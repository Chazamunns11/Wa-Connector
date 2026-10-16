import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DAILY_CAP,
  PROVIDER_NUDGE_AFTER_MS,
  toLocationRow,
  toWhatsappState,
} from "@/lib/account-data/map";
import type { GhlAccountSummary, LocationStats, WhatsappSessionSummary } from "@/lib/types";

const NOW = new Date("2026-10-16T12:00:00Z");
const HOUR = 3_600_000;

function loc(over: Partial<GhlAccountSummary> = {}): GhlAccountSummary {
  return {
    locationId: "loc-1", tenantId: "ten-1", label: "Harbour Street Physio", companyId: null, status: "connected",
    lastError: null, createdAt: "2026-10-01T00:00:00Z", brandLogoPath: null, brandAccentColor: null,
    accountId: "acc-1", activatedAt: new Date(NOW.getTime() - 48 * HOUR).toISOString(), ...over,
  } as GhlAccountSummary;
}
function summary(over: Partial<WhatsappSessionSummary> = {}): WhatsappSessionSummary {
  return {
    coachId: "ten-1", status: "connected", phoneNumber: "+447700900101", lastConnectedAt: "2026-10-10T00:00:00Z",
    lastDisconnectReason: null, sentToday: 42, ...over,
  };
}
const stats = (over: Partial<LocationStats> = {}): LocationStats => ({
  pendingSend: 0, failedLast7Days: { count: 0, reasons: [] }, everReceived: true, ...over,
});

test("toWhatsappState: not activated is not_active whatever the session says", () => {
  assert.deepEqual(toWhatsappState(false, summary(), 0), { kind: "not_active" });
});
test("toWhatsappState: connected carries the number (empty when unknown)", () => {
  assert.deepEqual(toWhatsappState(true, summary(), 0), { kind: "connected", number: "+447700900101" });
  assert.deepEqual(toWhatsappState(true, summary({ phoneNumber: null }), 0), { kind: "connected", number: "" });
});
test("toWhatsappState: waiting_qr, no summary, or never connected is waiting_qr", () => {
  assert.deepEqual(toWhatsappState(true, summary({ status: "waiting_qr" }), 0), { kind: "waiting_qr" });
  assert.deepEqual(toWhatsappState(true, null, 0), { kind: "waiting_qr" });
  assert.deepEqual(toWhatsappState(true, summary({ status: "disconnected", lastConnectedAt: null }), 3), { kind: "waiting_qr" });
});
test("toWhatsappState: dropped after having connected is disconnected with the held count", () => {
  assert.deepEqual(toWhatsappState(true, summary({ status: "disconnected" }), 4), { kind: "disconnected", waiting: 4 });
  assert.deepEqual(toWhatsappState(true, summary({ status: "logged_out" }), 0), { kind: "disconnected", waiting: 0 });
});

test("toLocationRow maps name, caps, sends, held and failures", () => {
  const failed = { count: 2, reasons: ["Number not on WhatsApp"] };
  const r = toLocationRow(loc(), summary(), stats({ pendingSend: 4, failedLast7Days: failed }), NOW, 150, 3);
  assert.equal(r.id, "loc-1");
  assert.equal(r.name, "Harbour Street Physio");
  assert.equal(r.activated, true);
  assert.equal(r.sentToday, 42);
  assert.equal(r.dailyCap, 150);
  assert.equal(r.heldMessages, 4);
  assert.deepEqual(r.failedLast7Days, failed);
  assert.equal(r.optOuts, 3);
});
test("toLocationRow passes dailyCap through and zeroes sends without a summary", () => {
  const r = toLocationRow(loc(), null, stats(), NOW, 75, 0);
  assert.equal(r.dailyCap, 75);
  assert.equal(r.sentToday, 0);
  assert.equal(DEFAULT_DAILY_CAP, 150);
});
test("a not-activated row is not active and never nudges", () => {
  const r = toLocationRow(loc({ activatedAt: null }), summary(), stats({ everReceived: false }), NOW, 150, 0);
  assert.equal(r.activated, false);
  assert.deepEqual(r.state, { kind: "not_active" });
  assert.equal(r.providerNudge, false);
});

test("providerNudge: true at exactly 24h activated, connected, nothing ever received", () => {
  const at = loc({ activatedAt: new Date(NOW.getTime() - PROVIDER_NUDGE_AFTER_MS).toISOString() });
  assert.equal(toLocationRow(at, summary(), stats({ everReceived: false }), NOW, 150, 0).providerNudge, true);
});
test("providerNudge: false before 24h, when received, or when not connected", () => {
  const young = loc({ activatedAt: new Date(NOW.getTime() - PROVIDER_NUDGE_AFTER_MS + 1).toISOString() });
  assert.equal(toLocationRow(young, summary(), stats({ everReceived: false }), NOW, 150, 0).providerNudge, false);
  assert.equal(toLocationRow(loc(), summary(), stats({ everReceived: true }), NOW, 150, 0).providerNudge, false);
  assert.equal(toLocationRow(loc(), summary({ status: "waiting_qr" }), stats({ everReceived: false }), NOW, 150, 0).providerNudge, false);
});
