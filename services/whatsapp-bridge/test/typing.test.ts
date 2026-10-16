/**
 * Typing simulation unit checks — injected RNG and sleep, a fake presence
 * socket, so no real waiting and no live sends (hard rule 6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulateTyping, typingDurationMs, TYPING_MIN_MS, TYPING_MS_PER_CHAR } from "../src/typing.js";

const ON = { enabled: true, maxMs: 4_000 };

test("typingDurationMs: scales with length, centred on min + per-char cost", () => {
  const mid = () => 0.5; // zero jitter
  assert.equal(typingDurationMs("", ON, mid), TYPING_MIN_MS);
  assert.equal(typingDurationMs("hello there", ON, mid), TYPING_MIN_MS + 11 * TYPING_MS_PER_CHAR);
});

test("typingDurationMs: clamped to maxMs for long text", () => {
  assert.equal(typingDurationMs("x".repeat(5_000), ON, () => 0.999), 4_000);
});

test("typingDurationMs: never below the floor, even with negative jitter", () => {
  assert.equal(typingDurationMs("", ON, () => 0), TYPING_MIN_MS);
});

test("typingDurationMs: jitter varies equal-length messages", () => {
  const low = typingDurationMs("a message of some length", ON, () => 0);
  const high = typingDurationMs("a message of some length", ON, () => 0.999);
  assert.ok(high > low, `expected jitter spread, got ${low}..${high}`);
});

test("typingDurationMs: disabled or maxMs 0 means no typing window", () => {
  assert.equal(typingDurationMs("hello", { enabled: false, maxMs: 4_000 }), 0);
  assert.equal(typingDurationMs("hello", { enabled: true, maxMs: 0 }), 0);
});

test("typingDurationMs: a maxMs below the floor is still honoured as the ceiling", () => {
  assert.equal(typingDurationMs("hello", { enabled: true, maxMs: 500 }, () => 0.5), 500);
});

function fakeSock(failOn: Set<string> = new Set()) {
  const calls: string[] = [];
  return {
    calls,
    sock: {
      async sendPresenceUpdate(type: "composing" | "paused", jid?: string) {
        calls.push(`${type}:${jid}`);
        if (failOn.has(type)) throw new Error(`${type} failed`);
      },
    },
  };
}

test("simulateTyping: composing -> wait -> paused, to the given JID", async () => {
  const { calls, sock } = fakeSock();
  const slept: number[] = [];
  await simulateTyping(sock, "447700900123@s.whatsapp.net", 1_500, async (ms) => {
    slept.push(ms);
    calls.push("sleep");
  });
  assert.deepEqual(calls, ["composing:447700900123@s.whatsapp.net", "sleep", "paused:447700900123@s.whatsapp.net"]);
  assert.deepEqual(slept, [1_500]);
});

test("simulateTyping: zero duration touches nothing", async () => {
  const { calls, sock } = fakeSock();
  await simulateTyping(sock, "jid", 0, async () => {
    calls.push("sleep");
  });
  assert.deepEqual(calls, []);
});

test("simulateTyping: presence failures are swallowed and reported, and the wait still happens", async () => {
  const { calls, sock } = fakeSock(new Set(["composing", "paused"]));
  const errors: string[] = [];
  await simulateTyping(
    sock,
    "jid",
    1_000,
    async () => {
      calls.push("sleep");
    },
    (err) => errors.push(err.message)
  );
  assert.deepEqual(calls, ["composing:jid", "sleep", "paused:jid"]);
  assert.deepEqual(errors, ["composing failed", "paused failed"]);
});

// drainQueue needs a live Baileys socket, so its wiring is checked at source
// level (same approach as test/sessions-text-content.test.ts).
const SESSIONS = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const drain = SESSIONS.slice(SESSIONS.indexOf("private async drainQueue"), SESSIONS.indexOf("async logout("));

test("LOCKSTEP (SOURCE-LEVEL): drainQueue types before TEXT sends only, after the existence check and before recordSend", () => {
  const typingAt = drain.indexOf("simulateTyping(");
  assert.ok(typingAt > 0, "drainQueue must call simulateTyping");
  assert.ok(drain.indexOf("sock.onWhatsApp(") < typingAt, "typing must follow the existence check (it needs WhatsApp's JID)");
  assert.ok(typingAt < drain.indexOf("session.pacer.recordSend()"), "typing must come before the attempt is recorded");
  assert.match(drain.slice(drain.lastIndexOf("if (", typingAt) - 200, typingAt), /payload\.kind === "text"/, "typing is for text parts only");
});

test("LOCKSTEP (SOURCE-LEVEL): after typing, a dropped socket fails the row as NOT dispatched", () => {
  const after = drain.slice(drain.indexOf("simulateTyping("), drain.indexOf("session.pacer.recordSend()"));
  assert.match(after, /session\.sock !== sock/);
  assert.match(after, /recordFailed\([^)]*false\)/);
});
