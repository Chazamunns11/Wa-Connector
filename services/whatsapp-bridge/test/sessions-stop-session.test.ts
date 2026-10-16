/**
 * src/sessions.ts's `stopSessionCore` and `teardownLocalCore` — the module-
 * level extractions of `SessionManager.stopSession`/`teardownLocal`, pulled
 * out for the same "needs a live dependency the class can't cheaply fake"
 * reason `shutdownOneSession`/`ShutdownableSession` were (see
 * test/sessions-shutdown.test.ts's own header). Two things are pinned here:
 *
 *   1. THE FIX (production-incident follow-up #2): `stopSessionCore` must
 *      skip `lock.release()` when `session.stopping` was ALREADY true on
 *      entry, because that means a concurrent `shutdownOneSession` (the
 *      SIGTERM path) got there first and is mid-flush for this exact
 *      session — see `stopSessionCore`'s own JSDoc in src/sessions.ts for
 *      the full race.
 *   2. THE INVARIANT (finding: nothing pinned this before): neither
 *      function may EVER flush. `StoppableSession`/`LocallyTeardownable`
 *      deliberately have no `pendingWrites` field, so the tests below hand
 *      each function a fake with a THROWING `pendingWrites` getter — if a
 *      future "helpful" change ever reads it (e.g. to add a flush), these
 *      tests fail with that exact throw, not just a type error a careless
 *      refactor could route around.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stopSessionCore, teardownLocalCore, type StoppableSession, type LocallyTeardownable } from "../src/sessions.js";

/**
 * Attaches a LAZY throwing `pendingWrites` getter to `base` via
 * `Object.defineProperty` — NOT object-spread, which would evaluate a
 * getter-bearing literal immediately (at test-setup time, not at the
 * access this test is trying to catch). The getter only throws when the
 * function under test actually reads `.pendingWrites`.
 */
function withThrowingPendingWrites<T extends object>(base: T, label: string): T {
  Object.defineProperty(base, "pendingWrites", {
    enumerable: true,
    get(): never {
      throw new Error(`${label} must never read pendingWrites — it does not flush (see its own JSDoc)`);
    },
  });
  return base;
}

// ---------------------------------------------------------------------------
// stopSessionCore — lease-release-skip fix
// ---------------------------------------------------------------------------

test("stopSessionCore: stopping=false on entry — lock.release() runs (the normal, non-racing case)", async () => {
  const calls: string[] = [];
  const session: StoppableSession = {
    coachId: "coach-normal",
    stopping: false,
    sock: { end: () => calls.push("sock.end") },
    lock: { release: async () => { calls.push("lock.release"); } },
  };

  await stopSessionCore(session, null);

  assert.deepEqual(calls, ["sock.end", "lock.release"]);
  assert.equal(session.stopping, true);
});

test("stopSessionCore: stopping=TRUE on entry — lock.release() is SKIPPED (shutdownOneSession owns it)", async () => {
  const calls: string[] = [];
  const session: StoppableSession = {
    coachId: "coach-racing",
    stopping: true, // a concurrent shutdownOneSession already claimed this session.
    sock: { end: () => calls.push("sock.end") },
    lock: { release: async () => { calls.push("lock.release"); } },
  };

  await stopSessionCore(session, null);

  assert.deepEqual(calls, ["sock.end"], "lock.release must NOT be called — shutdownOneSession's own release must not be raced");
  assert.equal(session.stopping, true, "stopping stays true (idempotent overwrite is fine)");
});

test("stopSessionCore: wipe still runs regardless of which branch the stopping-flag takes", async () => {
  const calls: string[] = [];
  const wipe = async () => { calls.push("wipe"); };

  await stopSessionCore(
    { coachId: "a", stopping: false, sock: null, lock: { release: async () => calls.push("release") } },
    wipe
  );
  assert.deepEqual(calls, ["wipe", "release"]);

  calls.length = 0;
  await stopSessionCore(
    { coachId: "b", stopping: true, sock: null, lock: { release: async () => calls.push("release") } },
    wipe
  );
  assert.deepEqual(calls, ["wipe"], "wipe runs, but release is skipped because stopping was already true");
});

test("stopSessionCore: sock === null and a throwing sock.end are both tolerated, in either stopping state", async () => {
  const releaseCalls: string[] = [];
  await assert.doesNotReject(
    stopSessionCore({ coachId: "null-sock", stopping: false, sock: null, lock: { release: async () => releaseCalls.push("r1") } }, null)
  );
  await assert.doesNotReject(
    stopSessionCore(
      { coachId: "throwing-sock", stopping: false, sock: { end: () => { throw new Error("already closed"); } }, lock: { release: async () => releaseCalls.push("r2") } },
      null
    )
  );
  assert.deepEqual(releaseCalls, ["r1", "r2"]);
});

test("stopSessionCore: NEVER reads pendingWrites — proves it does not flush, even when a caller's session object happens to carry one", async () => {
  const session = withThrowingPendingWrites(
    { coachId: "coach-no-flush", stopping: false, sock: null, lock: { release: async () => {} } },
    "stopSessionCore"
  ) as unknown as StoppableSession;

  await assert.doesNotReject(stopSessionCore(session, null));
});

// ---------------------------------------------------------------------------
// teardownLocalCore — no flush, no release (lease already gone)
// ---------------------------------------------------------------------------

test("teardownLocalCore: sets stopping and ends the socket, tolerating a throwing sock.end", () => {
  const calls: string[] = [];
  const session: LocallyTeardownable = {
    coachId: "coach-lost",
    stopping: false,
    sock: { end: () => calls.push("sock.end") },
  };
  teardownLocalCore(session);
  assert.deepEqual(calls, ["sock.end"]);
  assert.equal(session.stopping, true);

  assert.doesNotThrow(() =>
    teardownLocalCore({ coachId: "coach-lost-2", stopping: false, sock: { end: () => { throw new Error("dead"); } } })
  );
});

test("teardownLocalCore: NEVER reads pendingWrites — proves it does not flush after a lost lease", () => {
  const session = withThrowingPendingWrites(
    { coachId: "coach-no-flush-2", stopping: false, sock: null },
    "teardownLocalCore"
  ) as unknown as LocallyTeardownable;

  assert.doesNotThrow(() => teardownLocalCore(session));
});
