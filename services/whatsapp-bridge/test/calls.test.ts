import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pino } from "pino";
import type { WACallEvent } from "@whiskeysockets/baileys";
import { MissedCallTracker, type MissedCallDeps } from "../src/calls.js";

const PN = "447700900123@s.whatsapp.net";
const DATE = new Date("2026-10-17T10:00:00.000Z");

function ev(status: WACallEvent["status"], over: Partial<WACallEvent> = {}): WACallEvent {
  return { chatId: PN, from: PN, id: "CALL1", date: DATE, status, offline: false, ...over };
}

function setup(over: Partial<MissedCallDeps> = {}) {
  const rows: Array<Parameters<MissedCallDeps["recordInboundMessage"]>[0]> = [];
  const state = { pokes: 0, recent: false };
  const deps: MissedCallDeps = {
    resolvePnForLid: async () => null,
    hasRecentMissedCall: async () => state.recent,
    recordInboundMessage: async (i) => {
      rows.push(i);
      return { fresh: true };
    },
    schedulePoke: () => {
      state.pokes++;
    },
    ownPhone: () => "+447700900999",
    log: pino({ level: "silent" }),
    ...over,
  };
  return { tracker: new MissedCallTracker(deps), rows, state };
}

test("offer then timeout -> one missed voice-call row", async () => {
  const { tracker, rows, state } = setup();
  await tracker.handle("coach1", [ev("offer")]);
  await tracker.handle("coach1", [ev("timeout")]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    coachId: "coach1",
    fromPhone: "+447700900123",
    waMessageId: "call:CALL1",
    body: null,
    messageType: "missedVoiceCall",
    receivedAt: "2026-10-17T10:00:00.000Z",
    groupJid: null,
    senderName: null,
    eventKind: "missed_call",
  });
  assert.equal(state.pokes, 1);
});

test("video call missed -> missedVideoCall", async () => {
  const { tracker, rows } = setup();
  await tracker.handle("c", [ev("offer", { isVideo: true }), ev("timeout", { isVideo: true })]);
  assert.equal(rows[0]?.messageType, "missedVideoCall");
});

test("accepted call is never missed", async () => {
  const { tracker, rows, state } = setup();
  await tracker.handle("c", [ev("offer"), ev("accept"), ev("terminate")]);
  assert.equal(rows.length, 0);
  assert.equal(state.pokes, 0);
});

test("a late duplicate terminal after an answered call is still not missed", async () => {
  const { tracker, rows } = setup();
  await tracker.handle("c", [ev("offer"), ev("accept"), ev("terminate"), ev("terminate")]);
  assert.equal(rows.length, 0);
});

test("reject without accept is missed", async () => {
  const { tracker, rows } = setup();
  await tracker.handle("c", [ev("offer"), ev("reject")]);
  assert.equal(rows.length, 1);
});

test("declined on the coach's own phone: reject carries our JID in from -> one row for the caller", async () => {
  const { tracker, rows } = setup();
  const OWN = "447700900999@s.whatsapp.net";
  await tracker.handle("c", [ev("offer", { isVideo: true })]);
  await tracker.handle("c", [ev("reject", { from: OWN, chatId: OWN, isVideo: false })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.fromPhone, "+447700900123");
  assert.equal(rows[0]?.messageType, "missedVideoCall", "the call type comes from the offer");
});

test("a LID caller saved at offer is resolved at the terminal event even if from changes", async () => {
  const LID = "123456789012345@lid";
  const { tracker, rows } = setup();
  await tracker.handle("c", [ev("offer", { from: LID, callerPn: PN })]);
  await tracker.handle("c", [ev("timeout", { from: "447700900999@s.whatsapp.net", callerPn: undefined })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.fromPhone, "+447700900123");
});

test("group call ignored", async () => {
  const { tracker, rows } = setup();
  await tracker.handle("c", [ev("offer", { isGroup: true }), ev("timeout", { isGroup: true, groupJid: "123@g.us" })]);
  assert.equal(rows.length, 0);
});

test("call from our own number ignored", async () => {
  const { tracker, rows } = setup({ ownPhone: () => "+447700900123" });
  await tracker.handle("c", [ev("offer"), ev("timeout")]);
  assert.equal(rows.length, 0);
});

test("callerPn is used as the alt for a LID caller", async () => {
  const { tracker, rows } = setup();
  await tracker.handle("c", [ev("offer", { from: "99999@lid", callerPn: PN }), ev("timeout", { from: "99999@lid", callerPn: PN })]);
  assert.equal(rows[0]?.fromPhone, "+447700900123");
});

test("LID caller resolved via lidMapping", async () => {
  const { tracker, rows } = setup({ resolvePnForLid: async (l) => (l === "99999@lid" ? "447700900555:3@s.whatsapp.net" : null) });
  await tracker.handle("c", [ev("offer", { from: "99999@lid" }), ev("timeout", { from: "99999@lid" })]);
  assert.equal(rows[0]?.fromPhone, "+447700900555");
});

test("unresolvable LID dropped, no row", async () => {
  const { tracker, rows, state } = setup();
  await tracker.handle("c", [ev("offer", { from: "99999@lid" }), ev("timeout", { from: "99999@lid" })]);
  assert.equal(rows.length, 0);
  assert.equal(state.pokes, 0);
});

test("rate limit: second missed call within 10 minutes is not recorded", async () => {
  const seen: string[] = [];
  const { tracker, rows, state } = setup({
    hasRecentMissedCall: async (_c, _p, since) => {
      seen.push(since);
      return true;
    },
  });
  await tracker.handle("c", [ev("offer", { id: "CALL2" }), ev("timeout", { id: "CALL2" })]);
  assert.equal(rows.length, 0);
  assert.equal(state.pokes, 0);
  assert.deepEqual(seen, ["2026-10-17T09:50:00.000Z"]);
});

test("duplicate terminal events for one call -> one row", async () => {
  const { tracker, rows, state } = setup();
  await tracker.handle("c", [ev("offer"), ev("timeout"), ev("terminate")]);
  assert.equal(rows.length, 1);
  assert.equal(state.pokes, 1);
});

test("redelivered call (store says not fresh) -> no poke", async () => {
  const { tracker, state } = setup({ recordInboundMessage: async () => ({ fresh: false }) });
  await tracker.handle("c", [ev("offer"), ev("timeout")]);
  assert.equal(state.pokes, 0);
});

test("a thrown store error doesn't throw out of handle, and later events still process", async () => {
  let n = 0;
  const { tracker, state } = setup({
    recordInboundMessage: async () => {
      if (n++ === 0) throw new Error("db down");
      return { fresh: true };
    },
  });
  const other = "447700900124@s.whatsapp.net";
  await assert.doesNotReject(tracker.handle("c", [ev("offer", { id: "A" }), ev("timeout", { id: "A" }), ev("offer", { id: "B", from: other }), ev("timeout", { id: "B", from: other })]));
  assert.equal(state.pokes, 1);
});

function timedTracker() {
  const clock = { t: 0 };
  const rows: unknown[] = [];
  const tracker = new MissedCallTracker(
    {
      resolvePnForLid: async () => null,
      hasRecentMissedCall: async () => false,
      recordInboundMessage: async (i) => {
        rows.push(i);
        return { fresh: true };
      },
      schedulePoke: () => {},
      ownPhone: () => null,
      log: pino({ level: "silent" }),
    },
    () => clock.t,
  );
  return { tracker, rows, clock };
}

test("terminal with no offer seen -> no row (restart mid-call fails safe)", async () => {
  const { tracker, rows } = setup();
  await tracker.handle("c", [ev("timeout")]);
  assert.equal(rows.length, 0);
});

test("offer swept after 10 minutes, then terminal -> no row", async () => {
  const { tracker, rows, clock } = timedTracker();
  await tracker.handle("c", [ev("offer")]);
  clock.t = 11 * 60 * 1000;
  await tracker.handle("c", [ev("timeout")]);
  assert.equal(rows.length, 0);
});

test("answered call lasting over 10 minutes -> no row", async () => {
  const { tracker, rows, clock } = timedTracker();
  await tracker.handle("c", [ev("offer"), ev("accept")]);
  clock.t = 25 * 60 * 1000;
  await tracker.handle("c", [ev("terminate")]);
  assert.equal(rows.length, 0);
});

test("swept accept no longer protects the call, but with no offer there is still no row", async () => {
  const { tracker, rows, clock } = timedTracker();
  await tracker.handle("c", [ev("accept")]);
  clock.t = 11 * 60 * 1000;
  await tracker.handle("c", [ev("terminate")]);
  assert.equal(rows.length, 0);
});

test("non offer/accept/terminal statuses create no state", async () => {
  const { tracker } = setup();
  await tracker.handle("c", [ev("ringing"), ev("transport"), ev("relaylatency")]);
  assert.equal((tracker as unknown as { calls: Map<string, unknown> }).calls.size, 0);
});

test("tracked calls are capped at 5000, dropping the oldest", async () => {
  const { tracker, rows } = setup();
  const events = Array.from({ length: 5001 }, (_, i) => ev("offer", { id: `C${i}` }));
  await tracker.handle("c", events);
  assert.equal((tracker as unknown as { calls: Map<string, unknown> }).calls.size, 5000);
  // The oldest (C0) was dropped, so its terminal is not missed; the newest still is.
  await tracker.handle("c", [ev("timeout", { id: "C0" })]);
  assert.equal(rows.length, 0);
  await tracker.handle("c", [ev("timeout", { id: "C5000" })]);
  assert.equal(rows.length, 1);
});

test("wiring: sessions.ts subscribes to call only behind missedCallsEnabled", () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/sessions.ts"), "utf8");
  const m = /if \(this\.config\.missedCallsEnabled\) \{[\s\S]*?\n    \}\n/.exec(src);
  assert.ok(m, "missedCallsEnabled block present");
  assert.match(m[0], /sock\.ev\.on\("call"/);
  assert.equal((src.match(/ev\.on\("call"/g) ?? []).length, 1, "only one call subscription, inside the block");
});
