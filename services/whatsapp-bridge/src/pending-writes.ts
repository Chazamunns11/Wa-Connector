/**
 * Pending-writes tracker — the other half of the fix for the incident where
 * 12 live client WhatsApp numbers desynced their Signal ratchet on a
 * redeploy ("Waiting for this message" on the client's OWN phone, `Bad MAC`
 * in logs). Root cause: Baileys advances the Signal ratchet IN MEMORY the
 * instant a message is sent or received, then persists the new key state to
 * Supabase asynchronously (`useSupabaseAuthState`'s `keys.set`/`saveCreds`,
 * src/auth-state.ts) — the ratchet and the DB row are never atomic with each
 * other. Graceful shutdown used to call `sock.end()` and immediately
 * `lock.release()` with nothing in between: any `setKeys`/`saveCreds` call
 * still in flight at that instant got killed mid-persist. The replacement
 * container then resumed from a DB ratchet state one or more steps BEHIND
 * the real one — every subsequent decrypt fails its MAC check, because the
 * key it derives no longer matches what the client's phone (which has no
 * idea a redeploy happened) is actually encrypting with.
 *
 * This class is the tripwire against exactly that: every write the auth
 * state hands to Supabase is registered here first, so shutdown can find out
 * what's still outstanding and WAIT for it before the lease that makes those
 * rows "ours to write" is released (see src/sessions.ts's
 * `shutdownOneSession` for the ordering that actually closes the gap — this
 * class only tracks and waits, it has no opinion on lease timing itself).
 * Deliberately dependency-free (no Baileys, no Supabase, no pino even) so it
 * is unit-testable in isolation (test/pending-writes.test.ts).
 */

/** flush()'s bounded return — always resolves, never throws (see flush's own JSDoc). */
export interface FlushResult {
  /** How many drain passes actually ran (bounded by `maxPasses`). */
  passes: number;
  /** How many tracked promises were still outstanding when flush gave up (0 = fully drained). */
  remaining: number;
  /**
   * True iff the deadline was hit WHILE something was still genuinely
   * outstanding (`remaining > 0`) — i.e. a write was actually abandoned.
   * False whenever the set fully drained, even on the code path that
   * DISCOVERS the drain by finding the clock already past deadline (the
   * loop's next-pass budget check can run a beat after the LAST write
   * settled, if wall-clock time elapses between "the write settled" and
   * "the next pass started" — see `flush`'s own JSDoc). Reporting
   * `timedOut: true` there would be misleading during an incident: nothing
   * was actually killed mid-persist, the set just finished at an inconvenient
   * moment to check. Also false if `maxPasses` was hit first (a distinct,
   * non-time-based bound — see `flush`).
   */
  timedOut: boolean;
}

/** Sentinel distinguishing "the raced promise settled" from "the deadline fired first" without needing `flush` to reject or throw. */
const DEADLINE_HIT = Symbol("pending-writes-deadline-hit");

export class PendingWrites {
  private readonly pending = new Set<Promise<unknown>>();

  /**
   * Registers `p` and returns it UNCHANGED — the caller's own await/catch
   * behaviour is byte-identical to not calling `track` at all. Internally, a
   * separate "follower" promise (`p.then(cleanup, cleanup)`) removes `p`
   * from the set once it settles, resolved or rejected either way.
   *
   * CRITICAL: the follower is fire-and-forget and NEVER assigned anywhere —
   * do NOT be tempted to `return p.finally(cleanup)` instead. `.finally`
   * returns a NEW promise that adopts `p`'s rejection; if that derived
   * promise were the thing handed back (or even just left dangling
   * unawaited), a caller who fires-and-forgets `track(someRejectingPromise)`
   * — which is exactly how `creds.update`'s handler and libsignal's own
   * internal writes behave — would mint a BRAND NEW unhandled rejection that
   * doesn't exist today. The follower here always attaches both a resolve
   * AND a reject handler synchronously inside this call, so `p`'s rejection
   * is considered "handled" from Node's perspective the instant `track`
   * returns, regardless of whether anyone ever awaits the returned promise.
   */
  track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const cleanup = (): void => {
      this.pending.delete(p);
    };
    p.then(cleanup, cleanup);
    return p;
  }

  /** Current outstanding-write count — cheap, synchronous, used for logging/snapshots (e.g. a future health check), not for control flow (flush() re-snapshots internally). */
  size(): number {
    return this.pending.size;
  }

  /**
   * Drains the tracked set. NEVER rejects — a flush is called from a
   * shutdown path where an exception here must not prevent the lease
   * release that follows it (src/sessions.ts's `shutdownOneSession`).
   *
   * Loop, once per pass:
   *   - Snapshot the set into an array. NEVER hold a live reference to
   *     `this.pending` across an `await` — a write that settles (and
   *     self-removes) mid-await must not mutate a collection we're
   *     currently iterating, and a snapshot also gives `Promise.allSettled`
   *     a stable list even if new writes register while we wait.
   *   - Snapshot non-empty: race `Promise.allSettled(snapshot)` against the
   *     remaining deadline. `allSettled` itself never rejects, so the only
   *     way this race "loses" is the deadline firing first.
   *   - Snapshot empty: wait `settleGraceMs` and check again. This exists
   *     specifically because libsignal's OWN internal bookkeeping (see
   *     src/console-guard.ts's file header — `closeSession`/`openSession`
   *     etc.) can trigger a `keys.set` a beat AFTER `sock.end()` has already
   *     returned, i.e. after the very first "is anything pending" check
   *     would have seen zero. Two CONSECUTIVE empty checks (with a grace
   *     wait between them) is the signal that nothing more is coming, not
   *     one.
   * Stops on: two consecutive empty checks (fully drained), the deadline
   * (`timedOut: true`), or `maxPasses` (a distinct, non-time-based safety
   * backstop — `timedOut` stays false, since the wall clock never actually
   * ran out; see `Session`'s `SHUTDOWN_FLUSH_MAX_PASSES` in src/sessions.ts
   * for why this exists as a belt-and-braces cap even though it should be
   * unreachable in practice).
   */
  async flush(opts: { timeoutMs: number; maxPasses: number; settleGraceMs: number }): Promise<FlushResult> {
    const deadline = Date.now() + opts.timeoutMs;
    let passes = 0;
    let consecutiveEmptyChecks = 0;

    // Both deadline-hit return sites below share this: `remaining > 0` is
    // the ONLY thing that makes a deadline hit an actual abandonment.
    // Without this, a write that settles (and self-removes) in the gap
    // between "the last await resolved" and "this pass's budget check runs"
    // reports `timedOut: true, remaining: 0` — a fully drained set flagged
    // as if something was killed mid-persist, which could mislead whoever
    // reads this line during an incident (see `FlushResult.timedOut`'s own
    // JSDoc).
    const onDeadlineHit = (): FlushResult => {
      const remaining = this.pending.size;
      return { passes, remaining, timedOut: remaining > 0 };
    };

    while (passes < opts.maxPasses) {
      passes++;
      const budgetMs = deadline - Date.now();
      if (budgetMs <= 0) {
        return onDeadlineHit();
      }

      const snapshot = Array.from(this.pending);

      if (snapshot.length === 0) {
        consecutiveEmptyChecks++;
        if (consecutiveEmptyChecks >= 2) {
          return { passes, remaining: 0, timedOut: false };
        }
        await sleepBounded(opts.settleGraceMs, deadline);
        continue;
      }
      consecutiveEmptyChecks = 0;

      const outcome = await raceAgainstDeadline(Promise.allSettled(snapshot), deadline - Date.now());
      if (outcome === DEADLINE_HIT) {
        return onDeadlineHit();
      }
      // Settled within budget — loop back and take a FRESH snapshot (not
      // "done"): a write's own settlement handler can register a NEW
      // tracked write (e.g. a follow-up `saveCreds` chained off a
      // `creds.update` that itself fired from the settling write), and that
      // new entry is only visible on the next pass.
    }

    return { passes, remaining: this.pending.size, timedOut: false };
  }
}

/** Resolves with `value` if `p` settles first, or `DEADLINE_HIT` if `ms` elapses first. Never rejects (the only rejecting promise ever raced here is `Promise.allSettled`'s result, which itself never rejects). */
function raceAgainstDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE_HIT> {
  if (ms <= 0) return Promise.resolve(DEADLINE_HIT);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(DEADLINE_HIT), ms);
    timer.unref();
    void p.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** `setTimeout(ms)` clamped so a grace wait can never itself run past the overall deadline. */
function sleepBounded(ms: number, deadline: number): Promise<void> {
  const bounded = Math.max(0, Math.min(ms, deadline - Date.now()));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, bounded);
    timer.unref();
  });
}
