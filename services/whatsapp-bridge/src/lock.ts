/**
 * Single-writer session lease — the split-brain guard.
 *
 * THE FAILURE MODE THIS PREVENTS: a Baileys session is ONE WebSocket
 * speaking the Signal protocol, and the Signal ratchet advances on every
 * message. Railway redeploys OVERLAP (new container becomes healthy before
 * the old one gets SIGTERM), so without a guard both containers would open
 * the same session: WhatsApp kicks one with connection-replaced (440), both
 * race writes to whatsapp_session_keys, and the ratchet state in Supabase
 * ends up a merge of two divergent histories — decryption failures at best,
 * a corrupted session needing a fresh QR scan at worst. For a CLIENT'S REAL
 * BUSINESS NUMBER that is an outage a human has to notice and fix, so it is
 * prevented structurally, not just detected.
 *
 * THE MECHANISM (lease with heartbeat, on whatsapp_sessions.lock_*):
 *   1. CLAIM before opening a socket — atomic UPDATE that succeeds iff the
 *      lease is free, already ours, or STALE (heartbeat older than
 *      WA_LOCK_TTL_MS). An instance that cannot claim does not open a
 *      socket, full stop; it retries on its heartbeat interval, so a new
 *      deploy takes over within ~TTL of the old instance dying.
 *   2. RENEW every WA_LOCK_HEARTBEAT_MS. A renew that reports "not yours
 *      any more" means a rival legitimately stole a lease we let go stale
 *      (e.g. this process froze past the TTL) — the response is immediate
 *      local shutdown of that session's socket WITHOUT touching the DB
 *      (`onLost`), because by definition the rival now owns the rows.
 *   3. RELEASE on SIGTERM (graceful deploys) — clears the lease only if
 *      still ours, so the replacement instance takes over immediately
 *      instead of waiting out the TTL. Bounded by `RELEASE_TIMEOUT_MS`: a
 *      hung Supabase call must never be allowed to eat into the 10s hard
 *      stop `shutdown()` runs under (src/main.ts) — see `release()`'s own
 *      JSDoc.
 *
 * WHY DETECTION-BY-HEARTBEAT IS ENOUGH: between a rival's steal and our next
 * renew there is a window (≤ heartbeat interval) where both instances hold a
 * socket. That window only opens after we ALREADY missed ≥ TTL of beats
 * (frozen process), and the exposure is bounded: creds/key WRITES are gated
 * on `isHeld()` in src/sessions.ts, so the stale instance stops persisting
 * state the moment it learns it lost — WhatsApp's own 440 usually kills one
 * side even sooner. A distributed lock with fencing tokens would shave that
 * window further at real complexity cost; wrong trade for one box and eight
 * coaches.
 */
import type { BridgeStore } from "./store.js";
import type { Logger } from "pino";

/**
 * Bound on `release()`'s Supabase round trip (see that method's own JSDoc
 * for why this exists) — a module constant, not an env var, matching
 * sessions.ts's `RECONNECT_BASE_MS`/`SHUTDOWN_FLUSH_MAX_PASSES` style: how
 * long ONE release call may take is an implementation detail of this class,
 * not a per-deploy operator tunable. Sized against the same 10s hard stop
 * src/main.ts's SIGTERM handler enforces: `WA_SHUTDOWN_FLUSH_TIMEOUT_MS`
 * (src/config.ts) already caps a session's flush under 6s specifically to
 * leave margin for the release round trip that runs immediately after it
 * (`shutdownOneSession`'s non-negotiable ordering) — 3s here keeps that
 * margin real even when a flush ran right up to its own ceiling, with ~1s
 * left over for signal-delivery/process overhead before the hard stop fires.
 */
const RELEASE_TIMEOUT_MS = 3_000;

/**
 * Races `promise` against a plain timer. Used by `release()` to bound its
 * Supabase round trip. Deliberately does NOT cancel the underlying call on
 * timeout — there is no cancellation primitive for a Supabase request, and a
 * cancelled-looking `releaseSessionLock` might still land server-side after
 * we've stopped waiting (harmless here: worst case is the lease we already
 * consider "possibly still held" gets cleared a moment later anyway). The
 * timer is `.unref()`d so a bound wait can never itself keep the process
 * alive past its own work — same discipline as this class's heartbeat timer.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      }
    );
  });
}

export class SessionLock {
  private timer: NodeJS.Timeout | null = null;
  private held = false;

  constructor(
    private readonly store: BridgeStore,
    private readonly coachId: string,
    private readonly instanceId: string,
    private readonly heartbeatMs: number,
    private readonly ttlMs: number,
    private readonly log: Logger,
    /** Called exactly once if the lease is lost — must synchronously start tearing the socket down. */
    private readonly onLost: () => void,
    /**
     * Bound on `release()`'s Supabase round trip — defaults to
     * `RELEASE_TIMEOUT_MS`. An optional constructor param rather than a
     * plain reference to the module constant purely for testability, same
     * rationale as `shutdownOneSession` taking `flushTimeoutMs` as a
     * parameter (src/sessions.ts) instead of hardcoding it: production call
     * sites never pass this, and get the real 3s bound; tests can inject a
     * tiny value so a "never-resolving store call" test finishes in
     * milliseconds instead of actually waiting out the production timeout.
     */
    private readonly releaseTimeoutMs: number = RELEASE_TIMEOUT_MS
  ) {}

  /** One-shot claim attempt. On success, starts the heartbeat. */
  async acquire(): Promise<boolean> {
    const ok = await this.store.claimSessionLock(this.coachId, this.instanceId, this.ttlMs);
    if (!ok) return false;
    this.held = true;
    this.timer = setInterval(() => void this.beat(), this.heartbeatMs);
    // Never keep the process alive just to heartbeat — shutdown is explicit.
    this.timer.unref();
    return true;
  }

  private async beat(): Promise<void> {
    if (!this.held) return;
    try {
      const stillOurs = await this.store.renewSessionLock(this.coachId, this.instanceId);
      if (!stillOurs) {
        this.log.warn({ coachId: this.coachId }, "session lease lost to another instance — shutting this session down locally");
        this.markLost();
      }
    } catch (err) {
      // A transient DB error is NOT a lost lease — the row still says we own
      // it, and the TTL hasn't elapsed for a rival until we miss beats for
      // WA_LOCK_TTL_MS. Log and let the next beat try again.
      this.log.error({ coachId: this.coachId, err: (err as Error).message }, "lease heartbeat failed (non-fatal, will retry)");
    }
  }

  private markLost(): void {
    this.held = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onLost();
  }

  /** Gate for credential/key writes — a session that lost its lease must stop persisting state (see file header). */
  isHeld(): boolean {
    return this.held;
  }

  /**
   * LIVE ownership check (an extra Supabase round trip), for the small
   * number of call sites where the cached `held` flag's staleness window
   * (see file header — up to one heartbeat interval) is not acceptable:
   * a status write that lands AFTER we've actually lost the lease can
   * silently overwrite the new holder's truth (e.g. writing 'disconnected'
   * over a session the successor has already reconnected), and `logout()`
   * wiping creds while genuinely not the owner would destroy a live
   * session's key material out from under it. Both are destructive/visible
   * enough to justify the extra round trip; the frequent per-key
   * read/write gate in src/auth-state.ts deliberately stays on the cheap
   * cached `isHeld()` instead — that path fires per Signal key, not per
   * lifecycle transition, and its worst case is already bounded by this
   * same class's write-gate documented in the file header.
   */
  async confirmHeld(): Promise<boolean> {
    if (!this.held) return false;
    try {
      const stillOurs = await this.store.renewSessionLock(this.coachId, this.instanceId);
      if (!stillOurs) this.markLost();
      return stillOurs;
    } catch (err) {
      // Can't verify either way. For a destructive/authoritative decision,
      // "unverifiable" must resolve to "don't act" rather than "assume yes".
      this.log.error({ coachId: this.coachId, err: (err as Error).message }, "confirmHeld check failed (non-fatal) — refusing the gated action this time");
      return false;
    }
  }

  /**
   * Graceful release (SIGTERM path). Safe to call twice — `held` flips to
   * `false` SYNCHRONOUSLY on entry, before the Supabase round trip even
   * starts, so a second concurrent call (e.g. `shutdownOneSession` racing a
   * shutdown-time caller that independently decides to release the same
   * session — see sessions.ts's `doStartSession` race-guard) sees `held`
   * already false and returns immediately without a second DB call. This
   * split-brain-relevant flip must never move to AFTER the round trip
   * (awaiting it first would let a rival believe we still hold the lease for
   * up to `RELEASE_TIMEOUT_MS` longer than necessary).
   *
   * BOUNDED (`RELEASE_TIMEOUT_MS`): one slow Supabase call used to be able to
   * consume the ENTIRE 10s hard-stop budget `shutdown()` runs under
   * (src/main.ts) by itself — `shutdown()` is concurrent across sessions
   * now (`Promise.allSettled`), which already bounds the damage to one
   * session's worth, but a single hung release is still one session too
   * many when the whole point of releasing promptly is avoiding a stall. On
   * timeout this logs and returns rather than throwing — the existing
   * fallback comment below already covers it: worst case the lease waits
   * out the TTL, exactly as if this call had genuinely failed.
   */
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    try {
      await withTimeout(
        this.store.releaseSessionLock(this.coachId, this.instanceId),
        this.releaseTimeoutMs,
        `lease release timed out after ${this.releaseTimeoutMs}ms`
      );
    } catch (err) {
      // Worst case the lease waits out the TTL — the takeover still happens.
      // A timeout lands here exactly like a thrown store error (see
      // withTimeout above); either way `held` is already false, so this
      // instance's own write gates (isHeld()) are already correct
      // regardless of whether the DB round trip ever actually completes.
      this.log.error({ coachId: this.coachId, err: (err as Error).message }, "lease release failed (rival takes over after TTL instead)");
    }
  }
}
