/**
 * THE FIX FOR FIX 1's RACE: `SessionManager.shuttingDown` and the guards
 * built on it in `doStartSession`/`attemptResumeSweep`/`shutdown()` (see
 * `shuttingDown`'s own JSDoc in src/sessions.ts for the full happens-before
 * proof). Registering SIGTERM/SIGINT before `resumeAll()` is awaited
 * (src/main.ts's `wireGracefulShutdown`) means a signal can now
 * legitimately land WHILE a session is still mid-`startSession` — this file
 * proves that race can never leave a lease held that no teardown pass will
 * ever release, which is the exact incident (a dead container's leases
 * sitting held for the full WA_LOCK_TTL_MS) Fix 1 exists to close.
 *
 * Deliberately exercises the REAL `SessionManager` (not an extracted
 * module-level function like `shutdownOneSession`'s own tests use), because
 * the race lives in the interaction between `doStartSession`, `shutdown()`,
 * and the shared `this.sessions` map — there is no smaller unit that would
 * still prove the guarantee. `store` is a fake matching only the methods
 * exercised (same pattern as test/auth-state.test.ts's `makeFakeStore`); no
 * real Supabase. Every test here deliberately never lets `doStartSession`
 * reach `openSocket` (real Baileys) — the fake store has NO `loadCreds`, so
 * IF a guard were broken and `openSocket` ran anyway, `useSupabaseAuthState`
 * would throw a TypeError immediately (its first line calls
 * `store.loadCreds`) instead of the test hanging on a real WebSocket
 * attempt — that TypeError would surface as an `assert.rejects(...,
 * ShuttingDownError)` mismatch, a fast and clear failure rather than a hang.
 *
 * A SECOND FIX, layered onto the first (`SessionManager.shutdown` now also
 * awaits every in-flight `this.starting` promise before IT resolves — see
 * that method's own JSDoc in src/sessions.ts). Every test below that has an
 * in-flight `startSession` attempt still paused at the moment `shutdown()`
 * is called therefore resolves its blocking deferred (`claim`/`sweep`/
 * `ensureRow`/`tenantB` etc.) BEFORE awaiting `manager.shutdown()` to
 * completion, never after — awaiting shutdown() first, with the blocker
 * still unresolved, now deadlocks the test instead of merely proving a
 * weaker guarantee. That is not a test-authoring quirk to work around; it
 * is the fix's whole point. THE ORIGINAL "core race" test below used to
 * await `manager.shutdown()` to completion BEFORE ever resolving `claim` —
 * which passed against the pre-fix code by accident (an empty `this.sessions`
 * snapshot let `shutdown()` return instantly, so the test process itself
 * stayed alive long enough for the later, separately-awaited claim/release
 * to happen — a luxury production's `.finally(() => process.exit(0))` does
 * not have). It has been rewritten below to assert the actual production
 * guarantee: `shutdown()` itself must not resolve until the claim is
 * accounted for, not merely "eventually release the lease at some point
 * after this test happens to keep awaiting things".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import { SessionManager, ShuttingDownError } from "../src/sessions.js";
import type { BridgeConfig } from "../src/config.js";
import type { BridgeStore } from "../src/store.js";

const silentLog = pino({ level: "silent" });

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flushes a generous number of microtask ticks — enough for several chained plain `async () => value` fakes to settle, without relying on real timers. */
async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    credsKey: Buffer.alloc(32),
    credsKeyPrevious: null,
    bridgeSecret: "bridge-secret-0123456789-0123456789-0123456789",
    port: 8080,
    sendMinGapMs: 45_000,
    sendJitterMs: 30_000,
    dailyCap: 150,
    // Large and .unref()'d in SessionLock — chosen so no heartbeat/resume-retry
    // timer fires mid-test regardless of how long a test takes to run.
    lockHeartbeatMs: 60_000,
    lockTtlMs: 180_000,
    shutdownFlushTimeoutMs: 500,
    maxQrReconnectAttempts: 5,
    logLevel: "silent",
    portalInboundUrl: null,
    waInboundPokeSecret: null,
    portalOutboundUrl: null,
    mediaOutboundEnabled: false,
    mediaInboundEnabled: false,
    mediaFetchTimeoutMs: 30_000,
    mediaMaxImageBytes: 1,
    mediaMaxAudioBytes: 1,
    mediaMaxVideoBytes: 1,
    mediaMaxDocumentBytes: 1,
    inboundMediaMaxBytes: 1,
    inboundMediaPerSenderDaily: 20,
    inboundMediaPerTenantDaily: 300,
    mediaBucket: "wa-media",
    ...overrides,
  };
}

interface StoreOverrides {
  ensureSessionRow?: (coachId: string) => Promise<void>;
  getDailyActivity?: (coachId: string) => Promise<{ attemptCount: number; lastAttemptAt: string | null }>;
  getTenantKind?: (coachId: string) => Promise<"coach" | "ghl_location" | null>;
  claimSessionLock?: (coachId: string, instanceId: string, ttlMs: number) => Promise<boolean>;
  renewSessionLock?: (coachId: string, instanceId: string) => Promise<boolean>;
  releaseSessionLock?: (coachId: string, instanceId: string) => Promise<void>;
  sweepInterruptedMessages?: (coachId: string, maxAgeMs: number) => Promise<[]>;
  listResumableCoachIds?: () => Promise<string[]>;
}

function makeFakeStore(overrides: StoreOverrides = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = {
    ensureSessionRow: overrides.ensureSessionRow ?? (async () => {}),
    getDailyActivity: overrides.getDailyActivity ?? (async () => ({ attemptCount: 0, lastAttemptAt: null })),
    getTenantKind: overrides.getTenantKind ?? (async () => "coach" as const),
    claimSessionLock:
      overrides.claimSessionLock ??
      (async (coachId: string, instanceId: string, ttlMs: number) => {
        calls.push({ method: "claimSessionLock", args: [coachId, instanceId, ttlMs] });
        return true;
      }),
    renewSessionLock: overrides.renewSessionLock ?? (async () => true),
    releaseSessionLock:
      overrides.releaseSessionLock ??
      (async (coachId: string, instanceId: string) => {
        calls.push({ method: "releaseSessionLock", args: [coachId, instanceId] });
      }),
    sweepInterruptedMessages: overrides.sweepInterruptedMessages ?? (async () => []),
    listResumableCoachIds: overrides.listResumableCoachIds ?? (async () => []),
  } as unknown as BridgeStore;
  return { store, calls };
}

// ---------------------------------------------------------------------------
// 1. The simple case: shutdown has ALREADY completed before startSession is
//    even called — no race at all, just the top-of-function refusal.
// ---------------------------------------------------------------------------

test("doStartSession: shutdown already complete — startSession refuses immediately, without a single store call", async () => {
  const ensureCalls: string[] = [];
  const { store } = makeFakeStore({
    ensureSessionRow: async (coachId) => {
      ensureCalls.push(coachId);
    },
  });
  const manager = new SessionManager(store, makeConfig(), silentLog);

  await manager.shutdown(); // nothing running yet — resolves immediately, sets shuttingDown.

  await assert.rejects(() => manager.startSession("coach-late"), ShuttingDownError);
  assert.deepEqual(ensureCalls, [], "must not touch the store at all once shutdown has begun");
});

// ---------------------------------------------------------------------------
// 2. THE CORE RACE: shutdown() begins in the exact gap between
//    `session.lock.acquire()` resolving and `this.sessions.set(...)`. This
//    is what `shuttingDown`'s happens-before proof (src/sessions.ts) is
//    about — pin it directly rather than trusting the proof on faith.
//
//    ALSO pins `SessionManager.shutdown()`'s own fix (see this file's
//    header): production's `.finally(() => process.exit(0))` fires the
//    INSTANT `shutdown()` resolves, so "the release call eventually
//    happens" is not good enough — `shutdown()` itself must not resolve
//    until the in-flight claim from this exact interleaving has been
//    accounted for.
// ---------------------------------------------------------------------------

test("shutdown() racing the lease-claim step: the lease granted exactly as shutdown begins is released BEFORE shutdown() itself resolves — not merely eventually", async () => {
  const claim = deferred<boolean>();
  let claimCalled = false;
  const { store, calls } = makeFakeStore({
    claimSessionLock: async () => {
      claimCalled = true;
      return claim.promise;
    },
  });
  const manager = new SessionManager(store, makeConfig(), silentLog);

  const startPromise = manager.startSession("coach-1");
  await flushMicrotasks();
  assert.equal(claimCalled, true, "must have reached the lease claim before we proceed");
  assert.equal(manager.getSnapshot("coach-1"), null, "not yet in the session map — still awaiting the claim");

  // shutdown() lands now, WHILE the claim is still unresolved. Its snapshot
  // of `this.sessions` is empty (this session was never inserted) — under
  // the pre-fix code that alone was enough for shutdown() to resolve
  // immediately, having torn down nothing. Deliberately NOT awaited here:
  // the whole point of this test is to prove shutdown() itself now blocks
  // on the still-in-flight claim, rather than resolving early and leaving
  // its fate to whatever the test does next.
  let shutdownSettled = false;
  const shutdownPromise = manager.shutdown().then(() => {
    shutdownSettled = true;
  });

  await flushMicrotasks();
  assert.equal(
    shutdownSettled,
    false,
    "shutdown() must still be waiting on the in-flight claim — resolving now would let src/main.ts's process.exit(0) fire before this lease is ever accounted for (FAILS against the pre-fix shutdown(), which resolved instantly here)"
  );
  assert.equal(calls.filter((c) => c.method === "releaseSessionLock").length, 0, "nothing to release yet — the claim itself hasn't resolved");

  // NOW grant the lease (models the deferred Supabase response finally
  // landing). doStartSession's post-acquire check must observe
  // `shuttingDown === true` and release the lease itself, since shutdown()'s
  // own snapshot never saw this session.
  claim.resolve(true);

  await shutdownPromise;
  assert.equal(shutdownSettled, true);

  // THE CRITICAL ASSERTION: by the time shutdown() resolves — i.e. by the
  // time src/main.ts's `.finally(() => process.exit(0))` would fire in
  // production — the lease claimed mid-shutdown is ALREADY released.
  const releaseCalls = calls.filter((c) => c.method === "releaseSessionLock");
  assert.equal(releaseCalls.length, 1, "the acquired lease must be released exactly once — never left held");
  assert.deepEqual(releaseCalls[0].args, ["coach-1", manager.instanceId]);

  await assert.rejects(startPromise, ShuttingDownError, "starting must fail once shutdown has begun, not silently succeed with an orphaned lease");
  assert.equal(manager.getSnapshot("coach-1"), null, "must never have been left registered as a running session");
});

// ---------------------------------------------------------------------------
// 3. shutdown() lands AFTER the session is inserted into `this.sessions` but
//    BEFORE `openSocket` runs (paused mid interrupted-message sweep).
//    `shutdownOneSession` must tear it down (release from THAT path), and
//    the in-flight `doStartSession` must bail before ever calling
//    `openSocket` — proven by never seeing a Baileys-shaped error, only
//    ShuttingDownError. `shutdown()` itself must not resolve until this
//    lingering `doStartSession` attempt has also unwound (see this file's
//    header) — so the sweep is resolved BEFORE awaiting shutdown() to
//    completion, not after.
// ---------------------------------------------------------------------------

test("shutdown() racing after insertion, before openSocket: shutdownOneSession tears the session down, doStartSession bails before opening a socket, and shutdown() waits for that bail-out too", async () => {
  const sweep = deferred<[]>();
  let sweepCalled = false;
  const { store, calls } = makeFakeStore({
    sweepInterruptedMessages: async () => {
      sweepCalled = true;
      return sweep.promise;
    },
  });
  const manager = new SessionManager(store, makeConfig(), silentLog);

  const startPromise = manager.startSession("coach-2");
  await flushMicrotasks();
  assert.equal(sweepCalled, true, "must have reached the interrupted-message sweep — i.e. past the lease claim and the insert into this.sessions");
  assert.notEqual(manager.getSnapshot("coach-2"), null, "must be registered as running before the sweep — this is what shutdown()'s snapshot needs to see");

  // shutdown() lands now, kicked off but not yet awaited to completion — it
  // must wait for coach-2's still-paused doStartSession attempt too (see
  // this file's header), and that attempt does not unwind until the sweep
  // below resolves.
  let shutdownSettled = false;
  const shutdownPromise = manager.shutdown().then(() => {
    shutdownSettled = true;
  });

  // shutdown()'s OWN teardown loop does not need the sweep to resolve — it
  // tears coach-2 down directly via its `this.sessions` snapshot (sock is
  // still null, so `end()` no-ops), independently of the paused
  // doStartSession call. This is NOT provable with `flushMicrotasks()`
  // alone, though: `shutdownOneSession` awaits `pendingWrites.flush(...)`,
  // and even an EMPTY pending set needs TWO consecutive checks with a real
  // `SHUTDOWN_FLUSH_SETTLE_GRACE_MS` (50ms) `setTimeout` between them
  // before `flush` reports drained (src/pending-writes.ts — a write can
  // land a beat after `sock.end()` returns, so one empty check is never
  // trusted alone). A pure microtask-spin cannot advance that real timer, so
  // we actually wait real wall-clock time here, comfortably over the 50ms
  // grace, while `sweep` stays deliberately unresolved throughout — proving
  // the release does NOT depend on it.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const releaseCallsBeforeSweep = calls.filter((c) => c.method === "releaseSessionLock");
  assert.equal(releaseCallsBeforeSweep.length, 1, "shutdown()'s own pass must have released this session's lease without waiting on the stuck sweep");
  assert.equal(manager.getSnapshot("coach-2"), null, "shutdown() must have cleared it from the session map");
  assert.equal(shutdownSettled, false, "shutdown() must still be waiting on coach-2's own doStartSession attempt to unwind before IT resolves");

  // Let the paused doStartSession continue. If the pre-openSocket guard were
  // missing, this would proceed into REAL Baileys code (useSupabaseAuthState
  // -> store.loadCreds, which this fake store does not implement) and reject
  // with a TypeError instead of ShuttingDownError — a clear, fast failure
  // signal rather than a hang on a real WebSocket attempt.
  sweep.resolve([]);
  await assert.rejects(startPromise, ShuttingDownError, "must bail with ShuttingDownError before ever reaching openSocket");

  await shutdownPromise;
  assert.equal(shutdownSettled, true, "shutdown() must resolve only once coach-2's doStartSession attempt has also settled");

  // doStartSession's own catch block also calls lock.release() unconditionally
  // — must be a safe no-op here (SessionLock.release is idempotent; see
  // test/lock.test.ts), NOT a second Supabase round trip.
  const releaseCallsAfterResume = calls.filter((c) => c.method === "releaseSessionLock");
  assert.equal(releaseCallsAfterResume.length, 1, "doStartSession's own cleanup must not hit the store a second time — release() is idempotent");
});

// ---------------------------------------------------------------------------
// 4. attemptResumeSweep (via the public resumeAll) must stop looping once
//    shutdown begins partway through — a later coach in the resumable list
//    must never even be attempted.
// ---------------------------------------------------------------------------

test("resumeAll's sweep stops as soon as shutdown begins mid-loop — a coach later in the list is never touched, and shutdown() waits for coach-A's attempt to unwind", async () => {
  const ensureRow = deferred<void>();
  let coachAEnsureCalled = false;
  let coachBEnsureCalled = false;
  const { store } = makeFakeStore({
    listResumableCoachIds: async () => ["coach-A", "coach-B"],
    ensureSessionRow: async (coachId) => {
      if (coachId === "coach-A") {
        coachAEnsureCalled = true;
        return ensureRow.promise;
      }
      if (coachId === "coach-B") {
        coachBEnsureCalled = true;
      }
    },
  });
  const manager = new SessionManager(store, makeConfig(), silentLog);

  const resumePromise = manager.resumeAll();
  await flushMicrotasks();
  assert.equal(coachAEnsureCalled, true, "the sweep must have started on coach-A");

  // shutdown() lands while coach-A's own startSession is still paused
  // (before any lease has been touched — nothing to release yet). Kicked
  // off but not awaited to completion yet: coach-A's attempt is still
  // registered in `this.starting`, and shutdown() must wait for it too.
  let shutdownSettled = false;
  const shutdownPromise = manager.shutdown().then(() => {
    shutdownSettled = true;
  });
  await flushMicrotasks();
  assert.equal(shutdownSettled, false, "shutdown() must still be waiting on coach-A's in-flight attempt");

  // Let coach-A's attempt continue — it will hit the pre-acquire
  // shuttingDown check and throw ShuttingDownError, which
  // attemptResumeSweep must treat as "stop the whole sweep now", not "log
  // and continue to the next coach".
  ensureRow.resolve();
  await resumePromise;
  await shutdownPromise;
  assert.equal(shutdownSettled, true);

  assert.equal(coachBEnsureCalled, false, "coach-B must never be attempted once shutdown began during coach-A's attempt");
});

// ---------------------------------------------------------------------------
// 5. Capstone: several coaches racing shutdown at different stages
//    simultaneously — every one of them must end up with no held lease, and
//    shutdown() itself must not resolve until every one of them has settled.
// ---------------------------------------------------------------------------

test("shutdown() with several coaches racing at three DIFFERENT stages simultaneously — every lease ends up released, none orphaned, before shutdown() itself resolves", async () => {
  const claimA = deferred<boolean>(); // paused waiting on the lease claim itself (before it's granted)
  const tenantB = deferred<"coach">(); // paused earlier still — before the lease is touched at all
  const sweepC = deferred<[]>(); // paused after insertion, before openSocket
  const { store, calls } = makeFakeStore({
    getTenantKind: async (coachId) => {
      if (coachId === "coach-B") return tenantB.promise;
      return "coach" as const;
    },
    claimSessionLock: async (coachId, instanceId, ttlMs) => {
      calls.push({ method: "claimSessionLock", args: [coachId, instanceId, ttlMs] });
      if (coachId === "coach-A") return claimA.promise;
      return true; // coach-C claims immediately
    },
    sweepInterruptedMessages: async (coachId) => {
      if (coachId === "coach-C") return sweepC.promise;
      return [];
    },
  });
  const manager = new SessionManager(store, makeConfig(), silentLog);

  const startA = manager.startSession("coach-A");
  const startB = manager.startSession("coach-B");
  const startC = manager.startSession("coach-C");

  await flushMicrotasks();
  // Each coach should now be paused at ITS OWN distinct checkpoint:
  //   A: inside session.lock.acquire(), the claim itself unresolved.
  //   B: inside resolveTenantKind, before the lease has been touched at all.
  //   C: past the claim and the insert into this.sessions, inside the
  //      interrupted-message sweep, before openSocket.
  assert.equal(manager.getSnapshot("coach-A"), null, "A must not be registered yet — still awaiting its claim");
  assert.equal(manager.getSnapshot("coach-B"), null, "B must not be registered yet — hasn't even reached the claim");
  assert.notEqual(manager.getSnapshot("coach-C"), null, "C must already be registered — inserted before its sweep pause");

  // Kicked off but not awaited to completion yet — all three coaches' attempts
  // are still in-flight, and shutdown() must wait for every one of them.
  let shutdownSettled = false;
  const shutdownPromise = manager.shutdown().then(() => {
    shutdownSettled = true;
  });
  await flushMicrotasks();
  assert.equal(shutdownSettled, false, "shutdown() must still be waiting on all three in-flight attempts");

  claimA.resolve(true);
  tenantB.resolve("coach");
  sweepC.resolve([]);

  const results = await Promise.allSettled([startA, startB, startC]);
  await shutdownPromise;
  assert.equal(shutdownSettled, true, "shutdown() must resolve only once every in-flight attempt has settled");

  for (const [i, label] of ["coach-A", "coach-B", "coach-C"].entries()) {
    const result = results[i];
    // Every attempt must settle as a rejection (none may silently "succeed"
    // once shutdown has begun) with the SPECIFIC ShuttingDownError — not,
    // say, a TypeError from an accidentally-reached openSocket.
    assert.equal(result.status, "rejected", `${label}'s startSession must reject once shutdown began`);
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof ShuttingDownError, `${label} must reject with ShuttingDownError specifically, got: ${(result.reason as Error)?.message}`);
    }
  }

  const claimCalls = calls.filter((c) => c.method === "claimSessionLock").map((c) => c.args[0]);
  const releaseCalls = calls.filter((c) => c.method === "releaseSessionLock").map((c) => c.args[0]);
  // coach-B never reaches the claim at all (it's rejected at the pre-acquire
  // check before ever calling claimSessionLock) — nothing to release for it,
  // and that's correct, not a gap: the invariant is "every CLAIMED lease is
  // released", not "every attempted coach touches the lease".
  assert.deepEqual(claimCalls.sort(), ["coach-A", "coach-C"], "coach-B must never reach the lease claim");
  assert.deepEqual([...releaseCalls].sort(), [...claimCalls].sort(), "every claimed lease must be released — zero orphans, regardless of which stage each session was paused at");

  assert.equal(manager.getSnapshot("coach-A"), null);
  assert.equal(manager.getSnapshot("coach-B"), null);
  assert.equal(manager.getSnapshot("coach-C"), null);
});
