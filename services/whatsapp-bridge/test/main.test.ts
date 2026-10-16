/**
 * src/main.ts's `wireGracefulShutdown` — THE FIX for the incident where a
 * deploy left every live client session's lease held by a dead container.
 * The old code called `process.on("SIGTERM", …)` AFTER `await
 * manager.resumeAll()`, and `resumeAll` opens a WebSocket and runs a full
 * Signal handshake per session, sequentially — tens of seconds with 7+
 * sessions. A SIGTERM landing in that window hit Node's DEFAULT behaviour
 * (instant exit, no handler installed yet): zero leases released, and the
 * Signal-key flush that fixes the ratchet-desync incident
 * (src/pending-writes.ts) never got to run either, since that flush lives in
 * the SAME graceful path.
 *
 * Imports straight from src/main.ts, not src/index.ts — see src/index.ts's
 * own file header for why: `main()`/`wireGracefulShutdown` moved there
 * specifically so this file (and any other importer) never risks executing
 * `main()` as a side effect of the import, which an "am I the entrypoint"
 * guard in src/index.ts used to (mostly) prevent but could silently fail to
 * under `node dist` or a symlinked path.
 *
 * `SignalTarget` is a structural type deliberately (same rationale as
 * sessions.ts's `ShutdownableSession` etc.), so every fake here is a plain
 * object: no real process-wide signal handler (which would leak across
 * every other test in this `node:test` run), no real SessionManager, no
 * Supabase, no Baileys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireGracefulShutdown, type SignalTarget } from "../src/main.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("wireGracefulShutdown: SIGTERM and SIGINT are registered BEFORE resumeAll is awaited (pins the incident's exact ordering defect)", async () => {
  const registeredEvents: string[] = [];
  const target: SignalTarget = {
    on(event) {
      registeredEvents.push(event);
      return target;
    },
  };
  const resume = deferred<void>();
  let resumeAllCalled = false;
  const resumeAll = () => {
    resumeAllCalled = true;
    return resume.promise;
  };
  const shutdownCalls: string[] = [];

  const wired = wireGracefulShutdown(target, resumeAll, (signal) => shutdownCalls.push(signal));

  // wireGracefulShutdown's synchronous prefix — both `target.on` calls, then
  // the call into `resumeAll()` up to ITS OWN first suspension point — has
  // already run by the time control returns here (JS always runs a function
  // to its first await/suspension before yielding). resumeAll is still
  // unresolved, so if the handlers were registered AFTER awaiting it (the
  // pre-fix ordering), `registeredEvents` would still be empty right now.
  assert.deepEqual(registeredEvents.sort(), ["SIGINT", "SIGTERM"], "both handlers must be registered before resumeAll settles, not after");
  assert.equal(resumeAllCalled, true);

  resume.resolve();
  await wired;
});

test("wireGracefulShutdown: a signal firing WHILE resumeAll is still in flight invokes shutdown immediately — the handler is live, not deferred until resumeAll settles", async () => {
  const handlers: Partial<Record<"SIGTERM" | "SIGINT", () => void>> = {};
  const target: SignalTarget = {
    on(event, handler) {
      handlers[event] = handler;
      return target;
    },
  };
  const resume = deferred<void>();
  const shutdownCalls: string[] = [];

  const wired = wireGracefulShutdown(target, () => resume.promise, (signal) => shutdownCalls.push(signal));

  // resumeAll is deliberately left pending — this simulates the exact
  // incident scenario: a SIGTERM landing while resumeAll's per-session
  // Baileys handshakes are still running.
  assert.equal(typeof handlers.SIGTERM, "function", "SIGTERM handler must already be callable while resumeAll is unresolved");
  handlers.SIGTERM!();
  assert.deepEqual(shutdownCalls, ["SIGTERM"], "shutdown must fire synchronously from the handler, not wait for resumeAll to settle first");

  resume.resolve();
  await wired;
});

test("wireGracefulShutdown: resolves only once resumeAll itself resolves", async () => {
  const target: SignalTarget = { on: () => target };
  const resume = deferred<void>();
  let settled = false;

  const wired = wireGracefulShutdown(target, () => resume.promise, () => {});
  void wired.then(() => {
    settled = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, "must not resolve before resumeAll does");

  resume.resolve();
  await wired;
  assert.equal(settled, true);
});
