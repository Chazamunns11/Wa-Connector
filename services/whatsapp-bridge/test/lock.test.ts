/**
 * src/lock.ts's `release()` — the bounded-release fix. Before this, `release()`
 * awaited `store.releaseSessionLock` with no timeout at all: one slow (or
 * hung) Supabase call could consume the ENTIRE 10s hard-stop budget
 * `SessionManager.shutdown()` runs under (src/main.ts), starving every
 * OTHER session's release even though `shutdown()` is concurrent
 * (`Promise.allSettled`) — a single stuck release is still one session too
 * many when the whole point of releasing promptly is avoiding the
 * WA_LOCK_TTL_MS stall. `store` is a fake matching only the methods
 * SessionLock calls (same pattern as test/auth-state.test.ts's
 * `makeFakeStore`) — no real Supabase, no real timers beyond what the
 * timeout itself needs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import { SessionLock } from "../src/lock.js";
import type { BridgeStore } from "../src/store.js";

const silentLog = pino({ level: "silent" });

function makeFakeStore(overrides: Partial<{
  claimSessionLock: (coachId: string, instanceId: string, ttlMs: number) => Promise<boolean>;
  renewSessionLock: (coachId: string, instanceId: string) => Promise<boolean>;
  releaseSessionLock: (coachId: string, instanceId: string) => Promise<void>;
}> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = {
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
  } as unknown as BridgeStore;
  return { store, calls };
}

/**
 * `releaseTimeoutMs` defaults to 50ms — the class's own production default
 * (`RELEASE_TIMEOUT_MS`, 3s) is deliberately NOT exercised here: these tests
 * assert the BOUNDING BEHAVIOUR (a stuck call still returns, in bounded
 * time), not the specific production duration, so injecting a tiny value
 * (the same "make the constant a parameter for testability" pattern
 * `shutdownOneSession`'s `flushTimeoutMs` already uses — see this file's
 * header) keeps the whole suite fast instead of actually waiting out 3
 * real seconds per test.
 */
function makeLock(store: BridgeStore, onLost: () => void = () => {}, releaseTimeoutMs = 50): SessionLock {
  // Heartbeat/TTL values here are irrelevant to release() — chosen large so
  // no heartbeat timer fires during a test's own lifetime.
  return new SessionLock(store, "coach-1", "instance-1", 60_000, 180_000, silentLog, onLost, releaseTimeoutMs);
}

test("release: a never-resolving store.releaseSessionLock returns within the bound rather than hanging forever", async () => {
  const { store } = makeFakeStore({
    releaseSessionLock: () => new Promise<void>(() => {}), // never settles
  });
  const lock = makeLock(store, undefined, 50);
  assert.equal(await lock.acquire(), true);

  const started = Date.now();
  await lock.release();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2_000, `release() must not hang on a stuck store call, took ${elapsed}ms`);
});

test("release: held flips to false SYNCHRONOUSLY on entry, before the store round trip resolves — split-brain semantics unchanged", async () => {
  const { store } = makeFakeStore({
    releaseSessionLock: () => new Promise<void>(() => {}), // deliberately never resolves within this test
  });
  const lock = makeLock(store);
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);

  const releasePromise = lock.release();
  // release()'s synchronous prefix (clear timer, check held, flip held to
  // false) runs fully before its own first `await` suspends control back
  // here — so `held` is already false the instant `release()` is called,
  // regardless of how long (or whether at all) the store round trip takes.
  // This is what keeps release() safe to call twice even while a first
  // call's store round trip is still pending (see the next test).
  assert.equal(lock.isHeld(), false, "held must already be false synchronously, not only once the store round trip settles");

  // Don't leave the never-resolving call hanging past this test —
  // RELEASE_TIMEOUT_MS bounds it (proven by the previous test); just let it
  // settle on its own rather than re-asserting timing here too.
  await releasePromise;
});

test("release: safe to call twice — the second call is a no-op, no second store round trip", async () => {
  const { store, calls } = makeFakeStore();
  const lock = makeLock(store);
  assert.equal(await lock.acquire(), true);

  await lock.release();
  await lock.release();

  const releaseCalls = calls.filter((c) => c.method === "releaseSessionLock");
  assert.equal(releaseCalls.length, 1, "a second release() call must not hit the store again");
});

test("release: called on a lock that never held (acquire never called, or acquire failed) is a harmless no-op", async () => {
  const { store, calls } = makeFakeStore({
    claimSessionLock: async () => false,
  });
  const lock = makeLock(store);
  assert.equal(await lock.acquire(), false);

  await lock.release();

  assert.equal(calls.some((c) => c.method === "releaseSessionLock"), false);
});

test("release: a store call that rejects (not just times out) is caught, logged, and does not throw", async () => {
  const { store } = makeFakeStore({
    releaseSessionLock: async () => {
      throw new Error("simulated Supabase failure");
    },
  });
  const lock = makeLock(store);
  assert.equal(await lock.acquire(), true);

  await assert.doesNotReject(() => lock.release());
});

test("release: the normal (fast) path still actually calls the store — the bound must not skip a healthy release", async () => {
  const { store, calls } = makeFakeStore();
  const lock = makeLock(store);
  assert.equal(await lock.acquire(), true);

  await lock.release();

  const releaseCalls = calls.filter((c) => c.method === "releaseSessionLock");
  assert.deepEqual(releaseCalls, [{ method: "releaseSessionLock", args: ["coach-1", "instance-1"] }]);
});
