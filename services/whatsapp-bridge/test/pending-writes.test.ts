/**
 * src/pending-writes.ts's `PendingWrites` — the tracker that closes the
 * ratchet-desync incident's actual gap (see that file's header for the full
 * mechanism). Deliberately dependency-free (no Baileys, no Supabase), so
 * every test here uses plain hand-built promises, matching this package's
 * "no network, no WhatsApp" unit-test posture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingWrites } from "../src/pending-writes.js";

/** A promise plus externally-callable resolve/reject, for tests that need to control settlement timing precisely. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (err: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("track: returns the ORIGINAL promise — resolution propagates to an awaiting caller unchanged", async () => {
  const pending = new PendingWrites();
  const p = Promise.resolve(42);
  const tracked = pending.track(p);
  assert.equal(tracked, p, "track must return the exact same promise instance, not a wrapper");
  assert.equal(await tracked, 42);
});

test("track: rejection also propagates to an awaiting caller unchanged", async () => {
  const pending = new PendingWrites();
  const p = Promise.reject(new Error("write failed"));
  const tracked = pending.track(p);
  await assert.rejects(tracked, /write failed/);
});

test("track: a rejected, NEVER-awaited promise produces no unhandled rejection, and flush still counts it drained", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = new PendingWrites();
    // Deliberately fire-and-forget — this is exactly how a real caller in
    // src/auth-state.ts uses `pending.track(store.setKeys(...))` without
    // awaiting inline (the Baileys event handler that calls it is itself
    // fire-and-forget — see sessions.ts's `creds.update` wiring).
    pending.track(Promise.reject(new Error("simulated Supabase failure")));

    // Give Node's microtask queue a chance to process the rejection and,
    // if our follower were missing, flag it unhandled.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], "tracking a fire-and-forget rejecting promise must never mint a new unhandled rejection");

    const result = await pending.flush({ timeoutMs: 200, maxPasses: 10, settleGraceMs: 5 });
    assert.equal(result.remaining, 0, "the rejected write must still be counted as drained");
    assert.equal(result.timedOut, false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("flush: on an empty tracker resolves fast with remaining: 0", async () => {
  const pending = new PendingWrites();
  const started = Date.now();
  const result = await pending.flush({ timeoutMs: 2_000, maxPasses: 10, settleGraceMs: 5 });
  const elapsed = Date.now() - started;
  assert.equal(result.remaining, 0);
  assert.equal(result.timedOut, false);
  assert.ok(elapsed < 500, `flush on an empty tracker should resolve fast, took ${elapsed}ms`);
});

test("flush: multi-pass — a tracked promise whose settlement registers a SECOND tracked write drains both, passes >= 2", async () => {
  const pending = new PendingWrites();
  const first = deferred<void>();

  // `second` is only constructed (and its own settlement only scheduled)
  // once `first` has actually settled — simulates a follow-up `saveCreds`
  // chained off a `creds.update` that itself fired from the settling
  // write. Registering `second`'s setImmediate from INSIDE this handler
  // (rather than up front) guarantees it lands on a LATER event-loop tick
  // than `first`'s own resolution, so it is genuinely still outstanding —
  // not already-settled — the first time `flush` can observe it.
  pending.track(first.promise).then(() => {
    const second = new Promise<void>((resolve) => setImmediate(resolve));
    pending.track(second);
  });

  setImmediate(() => first.resolve());

  const result = await pending.flush({ timeoutMs: 2_000, maxPasses: 10, settleGraceMs: 5 });
  assert.equal(result.remaining, 0, "both the original and the follow-up write must be drained");
  assert.equal(result.timedOut, false);
  assert.ok(result.passes >= 2, `expected at least 2 passes to pick up the follow-up write, got ${result.passes}`);
});

test("flush: bounded — a never-settling tracked promise with a small timeoutMs returns timedOut: true, remaining: 1, in bounded time", async () => {
  const pending = new PendingWrites();
  pending.track(new Promise<void>(() => {})); // never settles

  const started = Date.now();
  const result = await pending.flush({ timeoutMs: 25, maxPasses: 10, settleGraceMs: 5 });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.equal(result.remaining, 1);
  assert.ok(elapsed < 1_000, `flush must bail out near the timeout budget, took ${elapsed}ms`);
});

test("flush: a set that drains WITHIN budget, where the NEXT pass's clock check lands past the deadline, reports timedOut: false — a fully-drained set must never be flagged as if a write was abandoned", async () => {
  // Reproduces the exact interleaving the finding describes: pass 1's
  // `Promise.allSettled` race is won normally (the tracked write settles
  // well inside the real timer this schedules), but by the time pass 2's
  // `budgetMs <= 0` check runs, the clock it reads has crossed the
  // deadline. `remaining` is 0 either way (nothing left tracked) — only
  // `timedOut` is at stake here, and it must reflect that nothing was
  // actually abandoned. `Date.now` is mocked by call order (there are
  // exactly 4 calls before the assertion-relevant check: the deadline calc,
  // pass 1's budget check, pass 1's race-timer `ms` calc, then pass 2's
  // budget check) — coupled to `flush`'s current internals, but that's the
  // only way to force this specific millisecond-scale race deterministically.
  const pending = new PendingWrites();
  pending.track(Promise.resolve()); // already resolved — settles on the very next microtask, well within budget.

  const realDateNow = Date.now;
  const timeoutMs = 200;
  const start = realDateNow();
  let call = 0;
  Date.now = () => {
    call++;
    return call <= 3 ? start : start + timeoutMs + 1; // call 4+ : reported as past the deadline.
  };

  try {
    const result = await pending.flush({ timeoutMs, maxPasses: 10, settleGraceMs: 5 });
    assert.equal(result.remaining, 0, "the write genuinely drained — nothing was abandoned");
    assert.equal(result.timedOut, false, "a fully-drained set must not report timedOut: true just because the NEXT pass's clock check ran late");
  } finally {
    Date.now = realDateNow;
  }
});

test("flush: maxPasses — a self-replenishing chain stops at the cap rather than looping forever", async () => {
  const pending = new PendingWrites();

  // Each settlement tracks a new promise that settles on the NEXT
  // setImmediate tick — an unbounded chain (deliberately real-macrotask
  // paced, not microtask-only, so this test's timing is deterministic
  // rather than depending on microtask queue ordering subtleties) if
  // nothing bounds the loop. `stopped` is test cleanup ONLY (so the chain
  // doesn't keep scheduling setImmediates and hold the process open after
  // this test finishes) — it plays no part in `flush`'s own maxPasses
  // bound, which is what's actually under test.
  let stopped = false;
  function chainOne(): void {
    if (stopped) return;
    const p = new Promise<void>((resolve) => setImmediate(resolve));
    pending.track(p).then(() => chainOne());
  }
  chainOne();

  try {
    const result = await pending.flush({ timeoutMs: 5_000, maxPasses: 3, settleGraceMs: 5 });
    assert.equal(result.passes, 3, "must stop exactly at maxPasses, not keep looping");
    assert.equal(result.remaining, 1, "the chain is still replenishing itself — never fully drains");
    assert.equal(result.timedOut, false, "maxPasses is a distinct, non-time-based bound — the wall clock never actually ran out");
  } finally {
    stopped = true;
  }
});

test("size(): reflects the current outstanding count and drops to zero once tracked promises settle", async () => {
  const pending = new PendingWrites();
  assert.equal(pending.size(), 0);
  const a = deferred<void>();
  const b = deferred<void>();
  pending.track(a.promise);
  pending.track(b.promise);
  assert.equal(pending.size(), 2);
  a.resolve();
  await a.promise;
  // Let the follower microtask run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.size(), 1);
  b.resolve();
  await b.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.size(), 0);
});
