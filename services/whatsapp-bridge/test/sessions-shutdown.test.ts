/**
 * src/sessions.ts's `shutdownOneSession` and the `Promise.allSettled`
 * orchestration `SessionManager.shutdown()` builds on top of it — this IS
 * the fix for the incident (see that function's own JSDoc for the full
 * ordering rationale, and src/pending-writes.ts's file header for the
 * mechanism). `ShutdownableSession` is a structural type deliberately, so
 * every fake here is a plain object: no real `SessionLock` (needs a
 * `BridgeStore`), no real Baileys `WASocket`, no Supabase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { pino } from "pino";
import { shutdownOneSession, type ShutdownableSession } from "../src/sessions.js";
import { PendingWrites } from "../src/pending-writes.js";

const silentLog = pino({ level: "silent" });

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A pino destination that accumulates parsed JSON lines (same technique as test/console-guard.test.ts and test/auth-state.test.ts). */
function makeCaptureStream(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

test("shutdownOneSession: ORDERING — sock.end runs before flush begins, lock.release only after flush fully settles (pins the incident's exact defect)", async () => {
  const calls: string[] = [];
  const write = deferred<void>();
  const pendingWrites = new PendingWrites();
  pendingWrites.track(write.promise); // a write already in flight when shutdown starts.

  const session: ShutdownableSession = {
    coachId: "coach-order",
    stopping: false,
    sock: {
      end: () => {
        calls.push("sock.end");
      },
    },
    pendingWrites,
    lock: {
      release: async () => {
        calls.push("lock.release");
      },
    },
  };

  const shutdownPromise = shutdownOneSession(session, { flushTimeoutMs: 2_000 }, silentLog);

  // shutdownOneSession's synchronous prefix (stopping=true, sock.end, then
  // the call into pendingWrites.flush, which itself synchronously runs up
  // to ITS OWN first internal await) has already executed by the time
  // control returns here — JS always runs to a function's first suspension
  // point before yielding. The write is still unresolved, so flush cannot
  // have settled, so lock.release cannot have run yet.
  assert.deepEqual(calls, ["sock.end"], "lock.release must NOT run while a tracked write is still in flight");
  assert.equal(session.stopping, true);

  write.resolve();
  await shutdownPromise;

  assert.deepEqual(calls, ["sock.end", "lock.release"], "lock.release must run only AFTER the flush has fully settled — never called earlier and merely awaited later");
});

test("shutdownOneSession: a hung write with a small flushTimeoutMs — lock.release still runs, in bounded time", async () => {
  const calls: string[] = [];
  const pendingWrites = new PendingWrites();
  pendingWrites.track(new Promise<void>(() => {})); // never settles

  const session: ShutdownableSession = {
    coachId: "coach-hung",
    stopping: false,
    sock: {
      end: () => {
        calls.push("sock.end");
      },
    },
    pendingWrites,
    lock: {
      release: async () => {
        calls.push("lock.release");
      },
    },
  };

  const started = Date.now();
  await shutdownOneSession(session, { flushTimeoutMs: 25 }, silentLog);
  const elapsed = Date.now() - started;

  assert.deepEqual(calls, ["sock.end", "lock.release"], "a stuck write must never prevent the lease from being released");
  assert.ok(elapsed < 2_000, `shutdown must not hang on a stuck write, took ${elapsed}ms`);
});

test("shutdownOneSession: sock === null — flush and release still run", async () => {
  const calls: string[] = [];
  const session: ShutdownableSession = {
    coachId: "coach-null-sock",
    stopping: false,
    sock: null,
    pendingWrites: new PendingWrites(),
    lock: {
      release: async () => {
        calls.push("lock.release");
      },
    },
  };

  await shutdownOneSession(session, { flushTimeoutMs: 200 }, silentLog);
  assert.deepEqual(calls, ["lock.release"]);
});

test("shutdownOneSession: sock.end throwing — flush and release still run", async () => {
  const calls: string[] = [];
  const session: ShutdownableSession = {
    coachId: "coach-throwing-sock",
    stopping: false,
    sock: {
      end: () => {
        calls.push("sock.end");
        throw new Error("socket already closed");
      },
    },
    pendingWrites: new PendingWrites(),
    lock: {
      release: async () => {
        calls.push("lock.release");
      },
    },
  };

  await shutdownOneSession(session, { flushTimeoutMs: 200 }, silentLog);
  assert.deepEqual(calls, ["sock.end", "lock.release"], "a throwing sock.end must not skip flush or release");
});

test("shutdownOneSession: the flush-stats log line carries counts only — coachId/passes/remaining/timedOut, never a write's own resolved value", async () => {
  const { stream, lines } = makeCaptureStream();
  const log = pino({ level: "debug" }, stream);
  const pendingWrites = new PendingWrites();
  const fakeKeyId = "447700900999@s.whatsapp.net";
  // Worst-case probe: even if a tracked write's resolved value carried
  // something sensitive (writes resolve void in production), flush() only
  // ever COUNTS settlements — it never inspects or logs a resolved value —
  // so this must never reach the log regardless.
  pendingWrites.track(Promise.resolve(fakeKeyId as unknown as void));

  const session: ShutdownableSession = {
    coachId: "coach-log-safety",
    stopping: false,
    sock: null,
    pendingWrites,
    lock: { release: async () => {} },
  };

  await shutdownOneSession(session, { flushTimeoutMs: 200 }, log);

  const entries = lines();
  const flushLine = entries.find((e) => e.msg === "shutdown flush complete");
  assert.ok(flushLine, "must log a flush-stats line");
  assert.equal(flushLine!.coachId, "coach-log-safety");
  assert.equal(typeof flushLine!.passes, "number");
  assert.equal(typeof flushLine!.remaining, "number");
  assert.equal(typeof flushLine!.timedOut, "boolean");

  const raw = JSON.stringify(entries);
  assert.ok(!raw.includes(fakeKeyId), "no resolved write value may ever appear in a shutdown log line");

  const allowedTopLevelKeys = new Set(["level", "time", "pid", "hostname", "coachId", "passes", "remaining", "timedOut", "msg"]);
  for (const key of Object.keys(flushLine!)) {
    assert.ok(allowedTopLevelKeys.has(key), `unexpected field '${key}' on the flush-stats log line`);
  }
});

test("shutdown orchestration (Promise.allSettled): a rejected lock.release does not prevent another session's teardown", async () => {
  const calls: string[] = [];
  const sessionA: ShutdownableSession = {
    coachId: "coach-a-fails",
    stopping: false,
    sock: null,
    pendingWrites: new PendingWrites(),
    lock: {
      release: async () => {
        calls.push("a:lock.release");
        throw new Error("simulated release failure");
      },
    },
  };
  const sessionB: ShutdownableSession = {
    coachId: "coach-b-ok",
    stopping: false,
    sock: null,
    pendingWrites: new PendingWrites(),
    lock: {
      release: async () => {
        calls.push("b:lock.release");
      },
    },
  };

  // Mirrors exactly what SessionManager.shutdown() does: allSettled over
  // shutdownOneSession for every session.
  const outcomes = await Promise.allSettled([
    shutdownOneSession(sessionA, { flushTimeoutMs: 200 }, silentLog),
    shutdownOneSession(sessionB, { flushTimeoutMs: 200 }, silentLog),
  ]);

  assert.equal(outcomes[0].status, "rejected", "session A's failure must surface as a rejected settlement, not be swallowed");
  assert.equal(outcomes[1].status, "fulfilled", "session B must complete normally despite session A's failure");
  assert.deepEqual(calls.sort(), ["a:lock.release", "b:lock.release"], "BOTH sessions' release must have been attempted — allSettled, not all, is what guarantees this");
});
