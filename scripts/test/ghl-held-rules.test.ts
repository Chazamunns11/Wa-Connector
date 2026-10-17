import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HOLD_MAX_HOURS,
  REASON_NUMBER_BANNED,
  decideNotConnected,
  heldExpiredReason,
  holdMaxHours,
  isHeldExpired,
} from "@/lib/ghl-held-rules";
import type { WhatsappSessionStatus, WhatsappSessionSummary } from "@/lib/types";

const R = "this WhatsApp number is not connected — message not sent";

function summary(status: WhatsappSessionStatus, lastConnectedAt: string | null): WhatsappSessionSummary {
  return { coachId: "t1", status, phoneNumber: null, lastConnectedAt, lastDisconnectReason: null, sentToday: 0 };
}

test("holdMaxHours: default 24, accepts integers 1..168 only", () => {
  assert.equal(DEFAULT_HOLD_MAX_HOURS, 24);
  assert.equal(holdMaxHours({}), 24);
  assert.equal(holdMaxHours({ OUTBOUND_HOLD_MAX_HOURS: "0" }), 24);
  assert.equal(holdMaxHours({ OUTBOUND_HOLD_MAX_HOURS: "1" }), 1);
  assert.equal(holdMaxHours({ OUTBOUND_HOLD_MAX_HOURS: "168" }), 168);
  assert.equal(holdMaxHours({ OUTBOUND_HOLD_MAX_HOURS: "169" }), 24);
  assert.equal(holdMaxHours({ OUTBOUND_HOLD_MAX_HOURS: "abc" }), 24);
  assert.equal(holdMaxHours({ OUTBOUND_HOLD_MAX_HOURS: "12.5" }), 24);
  assert.equal(holdMaxHours({ OUTBOUND_HOLD_MAX_HOURS: "" }), 24);
});

test("heldExpiredReason is the exact fixed string", () => {
  assert.equal(heldExpiredReason(24), "phone was disconnected for more than 24 hours — message not sent");
});

test("decideNotConnected", () => {
  assert.deepEqual(decideNotConnected(null, R), { kind: "refuse", reason: R });
  assert.deepEqual(decideNotConnected(summary("disconnected", "2026-10-15T00:00:00Z"), R), { kind: "hold" });
  assert.deepEqual(decideNotConnected(summary("waiting_qr", "2026-10-15T00:00:00Z"), R), { kind: "hold" });
  assert.deepEqual(decideNotConnected(summary("waiting_qr", null), R), { kind: "refuse", reason: R });
  assert.deepEqual(decideNotConnected(summary("disconnected", null), R), { kind: "refuse", reason: R });
  assert.deepEqual(decideNotConnected(summary("logged_out", "2026-10-15T00:00:00Z"), R), { kind: "hold" });
  assert.deepEqual(decideNotConnected(summary("banned", "2026-10-15T00:00:00Z"), R), {
    kind: "refuse",
    reason: REASON_NUMBER_BANNED,
  });
  assert.deepEqual(decideNotConnected(summary("connected", "2026-10-15T00:00:00Z"), R), { kind: "refuse", reason: R });
  assert.equal(REASON_NUMBER_BANNED, "this WhatsApp number has been banned by WhatsApp — message not sent");
});

test("isHeldExpired", () => {
  const created = "2026-10-15T00:00:00Z";
  assert.equal(isHeldExpired(created, Date.parse("2026-10-16T00:00:01Z"), 24), true);
  assert.equal(isHeldExpired(created, Date.parse("2026-10-15T23:59:59Z"), 24), false);
  assert.equal(isHeldExpired("garbage", Date.parse("2026-10-16T00:00:01Z"), 24), true);
});
