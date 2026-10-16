/**
 * src/console-guard.ts — libsignal's own leaking `console.*` calls
 * (verified call sites listed in that file's header) redacted at the
 * ARGUMENT level, plus the patch/install machinery that routes sanitised
 * output through pino. `sanitizeConsoleArgs` is pure, so most of this file
 * needs neither pino nor a live console; `installConsoleGuard`'s tests
 * capture pino's own output stream directly (same technique as
 * server.test.ts's bearer-secret tests use for asserting exact log lines).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { pino } from "pino";
import { sanitizeConsoleArgs, installConsoleGuard } from "../src/console-guard.js";

/** A pino destination that just accumulates lines, for asserting exact log content without touching stdout. */
function makeCaptureStream(): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () => chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

// ---------------------------------------------------------------------------
// sanitizeConsoleArgs — pure
// ---------------------------------------------------------------------------

test("sanitizeConsoleArgs: primitives pass through and join with spaces, like console.log's own formatting", () => {
  const { message, redactedCount } = sanitizeConsoleArgs(["Closing session:", 42, true, null, undefined]);
  assert.equal(message, "Closing session: 42 true null undefined");
  assert.equal(redactedCount, 0);
});

test("sanitizeConsoleArgs: a Buffer argument becomes a placeholder naming the constructor — never the byte content", () => {
  const secretKey = Buffer.from("super-secret-signal-private-key-bytes", "utf8");
  const { message, redactedCount } = sanitizeConsoleArgs(["Opening session:", secretKey]);
  assert.equal(redactedCount, 1);
  assert.match(message, /\[redacted Buffer\]/);
  assert.ok(!message.includes(secretKey.toString("hex")), "must not contain the buffer's hex encoding");
  assert.ok(!message.includes(secretKey.toString("base64")), "must not contain the buffer's base64 encoding");
  assert.ok(!message.includes("super-secret-signal-private-key-bytes"), "must not contain the buffer's raw text");
});

test("sanitizeConsoleArgs: an object with a privKey Buffer property becomes a placeholder naming the constructor — never the property values", () => {
  const privKey = Buffer.from("another-secret-private-key", "utf8");
  const sessionEntry = { indexInfo: { closed: -1 }, privKey, registrationId: 12345 };
  const { message, redactedCount } = sanitizeConsoleArgs(["Closing session:", sessionEntry]);
  assert.equal(redactedCount, 1);
  assert.match(message, /\[redacted Object\]/);
  assert.ok(!message.includes(privKey.toString("hex")));
  assert.ok(!message.includes(privKey.toString("base64")));
  assert.ok(!message.includes("12345"), "no enumerable property value, including non-key fields, may leak either");
});

test("sanitizeConsoleArgs: arrays and functions also become constructor-named placeholders, not their contents", () => {
  const arrResult = sanitizeConsoleArgs([["a", "b", Buffer.from("x")]]);
  assert.match(arrResult.message, /\[redacted Array\]/);
  assert.equal(arrResult.redactedCount, 1);

  const fnResult = sanitizeConsoleArgs([function namedFn() {}]);
  assert.match(fnResult.message, /\[redacted Function\]/);
  assert.equal(fnResult.redactedCount, 1);
});

test("sanitizeConsoleArgs: an Error collapses to 'name: message' only — no stack, no enumerable extras", () => {
  const err = new TypeError("Invalid public key");
  (err as unknown as Record<string, unknown>).extraContext = { secret: "should-not-appear" };
  const { message, redactedCount } = sanitizeConsoleArgs(["Session error:", err]);
  assert.equal(message, "Session error: TypeError: Invalid public key");
  assert.equal(redactedCount, 1);
  assert.ok(!message.includes("at "), "must not include a stack trace frame");
  assert.ok(!message.includes("should-not-appear"), "must not include enumerable extra properties");
});

// ---------------------------------------------------------------------------
// sanitizeConsoleArgs — HOSTILE inputs must never throw. The patched
// console.* this function backs stands in for the native console, which
// never throws; libsignal calls console.error mid-decrypt (see the file
// header), so a guard whose OWN failure mode is throwing would inject a
// brand-new exception into that decrypt path — strictly worse than the
// key-leak this file exists to prevent. See sanitizeConsoleArgs's "NEVER
// THROWS" JSDoc paragraph.
// ---------------------------------------------------------------------------

test("sanitizeConsoleArgs HOSTILE: an object whose constructor.name getter throws — falls back to a bare placeholder, never throws", () => {
  const hostile = {
    constructor: {
      get name(): string {
        throw new Error("hostile name getter");
      },
    },
  };
  assert.doesNotThrow(() => sanitizeConsoleArgs(["boom:", hostile]));
  const { message, redactedCount } = sanitizeConsoleArgs(["boom:", hostile]);
  assert.equal(message, "boom: [redacted]");
  assert.equal(redactedCount, 1);
});

test("sanitizeConsoleArgs HOSTILE: an object with its OWN throwing constructor accessor — falls back to a bare placeholder, never throws", () => {
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "constructor", {
    get(): never {
      throw new Error("hostile constructor accessor");
    },
  });
  assert.doesNotThrow(() => sanitizeConsoleArgs(["boom:", hostile]));
  const { message, redactedCount } = sanitizeConsoleArgs(["boom:", hostile]);
  assert.equal(message, "boom: [redacted]");
  assert.equal(redactedCount, 1);
});

test("sanitizeConsoleArgs HOSTILE: a Proxy whose get trap throws on every property read — falls back to a bare placeholder, never throws", () => {
  const hostile = new Proxy(
    {},
    {
      get(): never {
        throw new Error("hostile proxy get trap");
      },
    }
  );
  assert.doesNotThrow(() => sanitizeConsoleArgs(["boom:", hostile]));
  const { message, redactedCount } = sanitizeConsoleArgs(["boom:", hostile]);
  assert.equal(message, "boom: [redacted]");
  assert.equal(redactedCount, 1);
});

test("sanitizeConsoleArgs HOSTILE: an Error subclass with a throwing message getter — falls back to a bare placeholder, never throws", () => {
  class HostileError extends Error {
    get message(): string {
      throw new Error("hostile message getter");
    }
  }
  const hostile = new HostileError();
  assert.doesNotThrow(() => sanitizeConsoleArgs(["boom:", hostile]));
  const { message, redactedCount } = sanitizeConsoleArgs(["boom:", hostile]);
  assert.equal(message, "boom: [redacted]");
  assert.equal(redactedCount, 1);
});

// ---------------------------------------------------------------------------
// sanitizeConsoleArgs — REGRESSION guard for shapes already verified safe
// before this hostile-input fix (adversarial review confirmed these don't
// throw today) — the try/catch added above must not change their output.
// ---------------------------------------------------------------------------

test("sanitizeConsoleArgs: Object.create(null) — no constructor at all — still falls back to the generic 'Object' placeholder", () => {
  const noProto = Object.create(null) as Record<string, unknown>;
  noProto.privKey = "leak-me-not";
  const { message, redactedCount } = sanitizeConsoleArgs(["Closing session:", noProto]);
  assert.match(message, /\[redacted Object\]/);
  assert.equal(redactedCount, 1);
});

test("sanitizeConsoleArgs: a circular reference — still doesn't throw or hang (this function never traverses/serialises the object)", () => {
  const circular: Record<string, unknown> = { privKey: "leak-me-not" };
  circular.self = circular;
  const { message, redactedCount } = sanitizeConsoleArgs(["Session:", circular]);
  assert.match(message, /\[redacted Object\]/);
  assert.equal(redactedCount, 1);
});

test("sanitizeConsoleArgs: a bare Symbol — still doesn't throw", () => {
  const { message, redactedCount } = sanitizeConsoleArgs(["tag:", Symbol("secret-ish")]);
  assert.match(message, /\[redacted Symbol\]/);
  assert.equal(redactedCount, 1);
});

test("sanitizeConsoleArgs: an object with a custom Symbol.toStringTag — still doesn't throw", () => {
  const tagged = { [Symbol.toStringTag]: "SessionEntry", privKey: "leak-me-not" };
  const { message, redactedCount } = sanitizeConsoleArgs(["tag:", tagged]);
  assert.match(message, /\[redacted Object\]/);
  assert.equal(redactedCount, 1);
});

// ---------------------------------------------------------------------------
// installConsoleGuard — patches the real global console, routes through pino
// ---------------------------------------------------------------------------

test("installConsoleGuard: console.info with a session-like object yields one debug line carrying the placeholder, never the object's data", () => {
  const { stream, lines } = makeCaptureStream();
  const log = pino({ level: "debug" }, stream);
  const uninstall = installConsoleGuard(log);
  try {
    const fakeSessionEntry = { privKey: Buffer.from("leak-me-not"), indexInfo: { closed: -1 } };
    console.info("Closing session:", fakeSessionEntry);
  } finally {
    uninstall();
  }
  const entries = lines();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 20, "pino debug level"); // 20 = debug
  assert.match(entries[0].msg as string, /Closing session: \[redacted Object\]/);
  assert.ok(!(entries[0].msg as string).includes("leak-me-not"));
});

test("installConsoleGuard: console.error with a fixed diagnostic string survives verbatim, at error level", () => {
  const { stream, lines } = makeCaptureStream();
  const log = pino({ level: "debug" }, stream);
  const uninstall = installConsoleGuard(log);
  try {
    console.error("Failed to decrypt message with any known session...");
  } finally {
    uninstall();
  }
  const entries = lines();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 50, "pino error level"); // 50 = error
  assert.equal(entries[0].msg, "Failed to decrypt message with any known session...");
});

test("installConsoleGuard: console.warn routes to warn level, unredacted for a plain fixed string", () => {
  const { stream, lines } = makeCaptureStream();
  const log = pino({ level: "debug" }, stream);
  const uninstall = installConsoleGuard(log);
  try {
    console.warn("Closing open session in favor of incoming prekey bundle");
  } finally {
    uninstall();
  }
  const entries = lines();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 40, "pino warn level"); // 40 = warn
  assert.equal(entries[0].msg, "Closing open session in favor of incoming prekey bundle");
});

test("installConsoleGuard: uninstall restores the exact native method references", () => {
  const nativeLog = console.log;
  const nativeInfo = console.info;
  const nativeWarn = console.warn;
  const nativeError = console.error;
  const nativeDebug = console.debug;

  const log = pino({ level: "silent" }, new Writable({ write: (_c, _e, cb) => cb() }));
  const uninstall = installConsoleGuard(log);
  try {
    assert.notEqual(console.log, nativeLog, "console.log should be patched while installed");
    assert.notEqual(console.info, nativeInfo);
    assert.notEqual(console.warn, nativeWarn);
    assert.notEqual(console.error, nativeError);
    assert.notEqual(console.debug, nativeDebug);
  } finally {
    uninstall();
  }
  assert.equal(console.log, nativeLog, "console.log must be restored to the exact original reference");
  assert.equal(console.info, nativeInfo);
  assert.equal(console.warn, nativeWarn);
  assert.equal(console.error, nativeError);
  assert.equal(console.debug, nativeDebug);
});
