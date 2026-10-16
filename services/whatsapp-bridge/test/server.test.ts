/**
 * Route-level checks against a REAL createBridgeServer instance with a fake
 * SessionManager/BridgeStore injected — auth gating, coach-id strictness,
 * E.164 refusal, idempotent replay shape, and the scoping proof (the coach
 * id the fake manager receives is exactly the path's, never anything from
 * the body). No Baileys, no network beyond localhost, no live WhatsApp
 * anything (hard rule 6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { createBridgeServer, constantTimeEqualStr } from "../src/server.js";
import type { SessionManager, SendOutcome } from "../src/sessions.js";
import type { BridgeStore, MessageRecord } from "../src/store.js";

const SECRET = "test-secret-0123456789-0123456789-0123456789";
const COACH_A = "11111111-1111-4111-8111-111111111111";

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    coachId: COACH_A,
    idempotencyKey: "run-1",
    toPhone: "+447700900123",
    status: "accepted",
    waMessageId: null,
    error: null,
    dispatchAttempted: false,
    createdAt: "2026-07-29T10:00:00.000Z",
    sentAt: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  args: unknown[];
}

function makeFakes(sendOutcome: SendOutcome) {
  const calls: Call[] = [];
  const manager = {
    startSession: async (coachId: string) => {
      calls.push({ method: "startSession", args: [coachId] });
      return {};
    },
    getSnapshot: (coachId: string) => ({
      coachId,
      status: "connected" as const,
      phoneNumber: "+447700900001",
      qr: null,
      sentToday: 0,
      dailyCap: 150,
      queueLength: 0,
    }),
    logout: async (coachId: string) => {
      calls.push({ method: "logout", args: [coachId] });
      return true;
    },
    send: async (coachId: string, to: string, text: string, idempotencyKey: string) => {
      calls.push({ method: "send", args: [coachId, to, text, idempotencyKey] });
      return sendOutcome;
    },
  } as unknown as SessionManager;
  const store = {
    tenantExists: async () => true,
    getMessage: async (coachId: string, key: string) => {
      calls.push({ method: "getMessage", args: [coachId, key] });
      return key === "run-1" ? makeRecord({ status: "sent", sentAt: "2026-07-29T10:01:00.000Z" }) : null;
    },
  } as unknown as BridgeStore;
  return { manager, store, calls };
}

async function withServer(
  sendOutcome: SendOutcome,
  fn: (base: string, calls: Call[]) => Promise<void>
): Promise<void> {
  const { manager, store, calls } = makeFakes(sendOutcome);
  const server = createBridgeServer({ manager, store, bridgeSecret: SECRET, log: pino({ level: "silent" }) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const AUTH = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };

test("health is open; everything else requires the exact bearer secret", async () => {
  await withServer({ kind: "accepted", record: makeRecord(), fresh: true }, async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/sessions/${COACH_A}`)).status, 401);
    const wrong = await fetch(`${base}/sessions/${COACH_A}`, { headers: { authorization: `Bearer ${SECRET}x` } });
    assert.equal(wrong.status, 401);
    const right = await fetch(`${base}/sessions/${COACH_A}`, { headers: AUTH });
    assert.equal(right.status, 200);
  });
});

test("coach id must be a strict UUID — no traversal, no fuzzy ids", async () => {
  await withServer({ kind: "accepted", record: makeRecord(), fresh: true }, async (base) => {
    for (const bad of ["abc", "../../etc", "11111111-1111-4111-8111-11111111111Z"]) {
      const res = await fetch(`${base}/sessions/${encodeURIComponent(bad)}`, { headers: AUTH });
      assert.equal(res.status, 400, `expected 400 for coach id ${JSON.stringify(bad)}`);
    }
  });
});

test("send: non-E.164 'to' is refused with 422 before the manager is ever consulted", async () => {
  await withServer({ kind: "accepted", record: makeRecord(), fresh: true }, async (base, calls) => {
    for (const bad of ["07700900123", "+44 7700 900123", "0044770O900123", ""]) {
      const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ to: bad, text: "hi", idempotencyKey: "run-1" }),
      });
      assert.equal(res.status, 422, `expected 422 for to=${JSON.stringify(bad)}`);
    }
    assert.equal(calls.filter((c) => c.method === "send").length, 0);
  });
});

test("SCOPING: the session is selected by the PATH coach id — a body 'coachId' is ignored entirely", async () => {
  await withServer({ kind: "accepted", record: makeRecord(), fresh: true }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        to: "+447700900123",
        text: "hi",
        idempotencyKey: "run-1",
        coachId: "22222222-2222-4222-8222-222222222222", // hostile body field — must change nothing
      }),
    });
    assert.equal(res.status, 202);
    const sendCall = calls.find((c) => c.method === "send");
    assert.ok(sendCall);
    assert.equal(sendCall.args[0], COACH_A);
  });
});

test("send replay: same idempotency key returns 200 + replay:true and the stored row", async () => {
  await withServer({ kind: "accepted", record: makeRecord({ status: "sent" }), fresh: false }, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { replay: boolean; message: { status: string } };
    assert.equal(body.replay, true);
    assert.equal(body.message.status, "sent");
  });
});

test("send maps manager outcomes to the documented status codes", async () => {
  await withServer({ kind: "session_not_connected", status: "waiting_qr" }, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 409);
  });
  await withServer({ kind: "daily_cap_reached", cap: 150 }, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 429);
  });
  await withServer({ kind: "idempotency_conflict", existing: makeRecord({ toPhone: "+447700900999" }) }, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "idempotency_conflict");
    assert.ok(body.error.message.includes("+447700900999"), "message should name the original recipient");
  });
});

test("send response includes toPhone so a caller can detect an idempotency-key/recipient mismatch", async () => {
  await withServer({ kind: "accepted", record: makeRecord({ toPhone: "+447700900123" }), fresh: true }, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", idempotencyKey: "run-1" }),
    });
    const body = (await res.json()) as { message: { toPhone: string } };
    assert.equal(body.message.toPhone, "+447700900123");
  });
});

test("logout: unknown coach id 404s before the manager is consulted", async () => {
  const { manager, calls } = makeFakes({ kind: "accepted", record: makeRecord(), fresh: true });
  const store = { tenantExists: async () => false, getMessage: async () => null } as unknown as BridgeStore;
  const server = createBridgeServer({ manager, store, bridgeSecret: SECRET, log: pino({ level: "silent" }) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${COACH_A}/logout`, { method: "POST", headers: AUTH });
    assert.equal(res.status, 404);
    assert.equal(calls.filter((c) => c.method === "logout").length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("message status lookup is scoped by coach + key", async () => {
  await withServer({ kind: "accepted", record: makeRecord(), fresh: true }, async (base, calls) => {
    const hit = await fetch(`${base}/sessions/${COACH_A}/messages/run-1`, { headers: AUTH });
    assert.equal(hit.status, 200);
    const miss = await fetch(`${base}/sessions/${COACH_A}/messages/run-2`, { headers: AUTH });
    assert.equal(miss.status, 404);
    const lookups = calls.filter((c) => c.method === "getMessage");
    assert.deepEqual(lookups[0]?.args, [COACH_A, "run-1"]);
  });
});

// ---------------------------------------------------------------------------
// Media plan (docs/MEDIA-PLAN.md §5.3) — the `attachment` body shape.
// Dedicated fakes/server setup (rather than reusing `withServer` above) so
// `manager.sendAttachment` and `mediaOutboundEnabled` can be wired in
// without touching a single existing test above this line.
// ---------------------------------------------------------------------------

function makeMediaFakes(sendOutcome: SendOutcome) {
  const calls: Call[] = [];
  const manager = {
    send: async (coachId: string, to: string, text: string, idempotencyKey: string) => {
      calls.push({ method: "send", args: [coachId, to, text, idempotencyKey] });
      return sendOutcome;
    },
    sendAttachment: async (coachId: string, to: string, attachment: unknown, idempotencyKey: string) => {
      calls.push({ method: "sendAttachment", args: [coachId, to, attachment, idempotencyKey] });
      return sendOutcome;
    },
  } as unknown as SessionManager;
  const store = { tenantExists: async () => true, getMessage: async () => null } as unknown as BridgeStore;
  return { manager, store, calls };
}

async function withMediaServer(
  opts: { sendOutcome: SendOutcome; mediaOutboundEnabled: boolean },
  fn: (base: string, calls: Call[]) => Promise<void>
): Promise<void> {
  const { manager, store, calls } = makeMediaFakes(opts.sendOutcome);
  const server = createBridgeServer({ manager, store, bridgeSecret: SECRET, log: pino({ level: "silent" }), mediaOutboundEnabled: opts.mediaOutboundEnabled });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("send: neither 'text' nor 'attachment' present is a 422, manager never consulted", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: true }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_body");
    assert.equal(calls.length, 0);
  });
});

test("send: BOTH 'text' and 'attachment' present is a 422, manager never consulted", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: true }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", attachment: { url: "https://example.com/f.pdf" }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_body");
    assert.equal(calls.length, 0);
  });
});

test("send: attachment shape is refused with a fixed reason when WA_MEDIA_OUTBOUND_ENABLED is off — DARK BY DEFAULT, same as if the shape never existed", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: false }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", attachment: { url: "https://example.com/f.pdf" }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "media_outbound_disabled");
    assert.equal(calls.filter((c) => c.method === "sendAttachment").length, 0, "the manager must never be consulted while the flag is off");
  });
});

test("send: a valid attachment shape, flag ON, reaches manager.sendAttachment with the exact url/fileName/idempotencyKey", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: true }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", attachment: { url: "https://example.com/invoice.pdf", fileName: "invoice.pdf" }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 202);
    const call = calls.find((c) => c.method === "sendAttachment");
    assert.ok(call);
    assert.deepEqual(call.args, [COACH_A, "+447700900123", { url: "https://example.com/invoice.pdf", fileName: "invoice.pdf" }, "run-1"]);
  });
});

test("send: attachment.url must be https:// — http:// is refused with a fixed reason, flag on", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: true }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", attachment: { url: "http://example.com/f.pdf" }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_attachment");
    assert.equal(calls.filter((c) => c.method === "sendAttachment").length, 0);
  });
});

test("send: attachment.url over the length bound is refused, flag on", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: true }, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", attachment: { url: "https://example.com/" + "a".repeat(3000) }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
  });
});

test("send: attachment.fileName over 128 chars is refused, flag on", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: true }, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", attachment: { url: "https://example.com/f.pdf", fileName: "a".repeat(200) }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
  });
});

// ---------------------------------------------------------------------------
// Flags-off regression (the critical test — see the task's own instructions):
// with WA_MEDIA_OUTBOUND_ENABLED off, the TEXT send path must be byte-for-byte
// what it was before the media plan touched server.ts at all.
// ---------------------------------------------------------------------------

test("FLAGS-OFF REGRESSION: with mediaOutboundEnabled false (the default), a plain {to, text, idempotencyKey} body still behaves EXACTLY as before — same 202, same manager.send call, same response shape", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord({ toPhone: "+447700900123" }), fresh: true }, mediaOutboundEnabled: false }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { ok: boolean; replay: boolean; message: { toPhone: string; status: string } };
    assert.equal(body.ok, true);
    assert.equal(body.replay, false);
    assert.equal(body.message.toPhone, "+447700900123");
    const sendCall = calls.find((c) => c.method === "send");
    assert.ok(sendCall);
    assert.deepEqual(sendCall.args, [COACH_A, "+447700900123", "hi", "run-1"]);
    assert.equal(calls.filter((c) => c.method === "sendAttachment").length, 0);
  });
});

test("FLAGS-OFF REGRESSION (QA Blocker 2): {to, idempotencyKey} with no text — pre-media response (422 invalid_text), not the xor check's invalid_body", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: false }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_text", "the pre-media contract only ever understood 'text' — this shape must read exactly as if 'attachment' had never been added");
    assert.equal(calls.length, 0, "the manager must never be consulted");
  });
});

test("FLAGS-OFF REGRESSION (QA Blocker 2): {to, text, attachment} — pre-media response (accepted, unknown 'attachment' field silently ignored), not the xor check's invalid_body", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord({ toPhone: "+447700900123" }), fresh: true }, mediaOutboundEnabled: false }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", text: "hi", attachment: { url: "https://example.com/f.pdf" }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { ok: boolean; message: { toPhone: string } };
    assert.equal(body.ok, true);
    assert.equal(body.message.toPhone, "+447700900123");
    const sendCall = calls.find((c) => c.method === "send");
    assert.ok(sendCall, "must dispatch the text exactly like before, the unrecognised 'attachment' field ignored");
    assert.deepEqual(sendCall.args, [COACH_A, "+447700900123", "hi", "run-1"]);
    assert.equal(calls.filter((c) => c.method === "sendAttachment").length, 0, "attachment must never reach the manager while the flag is off");
  });
});

test("FLAGS-OFF REGRESSION (QA Blocker 2, preserved behaviour): {to, attachment, idempotencyKey} with no text still gets the specific media_outbound_disabled diagnostic — this shape never existed pre-media, so there is no old response to preserve", async () => {
  await withMediaServer({ sendOutcome: { kind: "accepted", record: makeRecord(), fresh: true }, mediaOutboundEnabled: false }, async (base, calls) => {
    const res = await fetch(`${base}/sessions/${COACH_A}/send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ to: "+447700900123", attachment: { url: "https://example.com/f.pdf" }, idempotencyKey: "run-1" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "media_outbound_disabled");
    assert.equal(calls.length, 0);
  });
});

test("constantTimeEqualStr agrees with === without throwing on length mismatch", () => {
  assert.equal(constantTimeEqualStr("abc", "abc"), true);
  assert.equal(constantTimeEqualStr("abc", "abd"), false);
  assert.equal(constantTimeEqualStr("abc", "abcd"), false);
  assert.equal(constantTimeEqualStr("", ""), true);
});
