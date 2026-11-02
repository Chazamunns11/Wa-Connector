import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capLevel,
  fleetSummary,
  headline,
  needsAttention,
  needsCard,
  planStatus,
  primaryActionFor,
  rowActionsFor,
  NO_CARD_BANNER,
} from "@/lib/account-data/derive";
import type { AccountSummary, BillingStatus, LocationRow } from "@/lib/account-data/types";

function acct(billingStatus: BillingStatus): AccountSummary {
  return { id: "a", name: "Sample Co", kind: "business", email: "o@example.com", billingStatus, stripeCustomerId: null };
}
const billing = (stoppedNumbers = 0, pastDueNumbers = 0) => ({ stoppedNumbers, pastDueNumbers });
function row(over: Partial<LocationRow> = {}): LocationRow {
  return {
    id: "l", name: "Sample Studio", activated: true, state: { kind: "connected", number: "+447700900000" },
    sentToday: 10, dailyCap: 150, heldMessages: 0, failedLast7Days: { count: 0, reasons: [] },
    optOuts: 0, providerNudge: false, ...over,
  };
}

test("planStatus: no card yet (pending, or an old-model status) asks for one; a card on file is Active", () => {
  for (const s of ["pending", "trialing", "past_due", "paused"] as const) {
    assert.deepEqual(planStatus(acct(s)), { label: "No card yet", tone: "warn", banner: NO_CARD_BANNER }, s);
  }
  assert.equal(NO_CARD_BANNER, "Save a card to start. Nothing is charged then: each WhatsApp number you add gets its own 7-day free trial.");
  assert.deepEqual(planStatus(acct("active")), { label: "Active", tone: "win", banner: null });
  assert.deepEqual(planStatus(acct("active"), billing()), { label: "Active", tone: "win", banner: null });
  assert.deepEqual(planStatus(acct("comped"), billing(3, 3)), { label: "Active", tone: "win", banner: null });
  assert.deepEqual(planStatus(acct("cancelled")), { label: "Cancelled", tone: "muted", banner: null });
});

test("planStatus names how many numbers a payment problem affects; stopped beats past due", () => {
  assert.deepEqual(planStatus(acct("active"), billing(0, 1)), {
    label: "Payment failed",
    tone: "loss",
    banner: "Payment failed for 1 number — update your card. Sending continues while we retry.",
  });
  assert.deepEqual(planStatus(acct("active"), billing(2, 1)), {
    label: "Billing stopped",
    tone: "loss",
    banner: "2 numbers stopped sending because a payment could not be taken. Add a card to restart.",
  });
});

test("needsCard: only a card-on-file account with numbers stopped on billing", () => {
  assert.equal(needsCard(acct("active"), billing(1)), true);
  assert.equal(needsCard(acct("active"), billing(0, 4)), false);
  for (const s of ["pending", "trialing", "past_due", "paused", "cancelled", "comped"] as const) assert.equal(needsCard(acct(s), billing(1)), false, s);
});

test("needsAttention reasons in priority order: disconnected, waiting_qr, providerNudge, cap, null", () => {
  const all = { providerNudge: true, sentToday: 150, dailyCap: 150 };
  assert.equal(needsAttention(row({ ...all, state: { kind: "disconnected", waiting: 4 } })), "Disconnected — 4 messages waiting");
  assert.equal(needsAttention(row({ state: { kind: "disconnected", waiting: 1 } })), "Disconnected — 1 message waiting");
  assert.equal(needsAttention(row({ ...all, state: { kind: "waiting_qr" } })), "Waiting for QR scan");
  assert.equal(needsAttention(row(all)), "No messages from GoHighLevel yet. Is the Telephony Provider set?");
  assert.equal(needsAttention(row({ sentToday: 150, dailyCap: 150 })), "Daily cap reached");
  assert.equal(needsAttention(row({ dailyCap: 0, sentToday: 0 })), null);
  assert.equal(needsAttention(row()), null);
  assert.equal(needsAttention(row({ activated: false, state: { kind: "not_active" } })), null);
});

test("headline reads '2 numbers billed · £19.98/month' and switches tier at 11 and 25", () => {
  assert.equal(headline(2), "2 numbers billed · £19.98/month");
  assert.equal(headline(1), "1 number billed · £9.99/month");
  assert.equal(headline(0), "0 numbers billed · £0.00/month");
  assert.equal(headline(10), "10 numbers billed · £99.90/month");
  assert.equal(headline(11), "11 numbers billed · £87.89/month");
  assert.equal(headline(25), "25 numbers billed · £149.75/month");
});

test("rowActionsFor for not_active, waiting_qr, connected and disconnected rows", () => {
  assert.deepEqual(rowActionsFor(row({ activated: false, state: { kind: "not_active" } })), {
    activate: true, showQr: false, sendLink: false, disconnect: false, deactivate: false,
  });
  assert.deepEqual(rowActionsFor(row({ state: { kind: "waiting_qr" } })), {
    activate: false, showQr: true, sendLink: true, disconnect: false, deactivate: true,
  });
  assert.deepEqual(rowActionsFor(row()), {
    activate: false, showQr: false, sendLink: false, disconnect: true, deactivate: true,
  });
  assert.deepEqual(rowActionsFor(row({ state: { kind: "disconnected", waiting: 4 } })), {
    activate: false, showQr: false, sendLink: true, disconnect: false, deactivate: true,
  });
});

test("primaryActionFor: one inline action per state, none when connected", () => {
  assert.deepEqual(primaryActionFor(row({ activated: false, state: { kind: "not_active" } })), { key: "activate", label: "Activate" });
  assert.deepEqual(primaryActionFor(row({ state: { kind: "waiting_qr" } })), { key: "show-qr", label: "Show QR" });
  assert.deepEqual(primaryActionFor(row({ state: { kind: "disconnected", waiting: 2 } })), { key: "show-qr", label: "Reconnect" });
  assert.equal(primaryActionFor(row({ state: { kind: "connected", number: "+447700900101" } })), null);
});

test("capLevel: ok below 90%, near from 90%, full at the cap, ok when not active", () => {
  assert.equal(capLevel(row({ sentToday: 134 })), "ok");
  assert.equal(capLevel(row({ sentToday: 135 })), "near");
  assert.equal(capLevel(row({ sentToday: 150 })), "full");
  assert.equal(capLevel(row({ sentToday: 160 })), "full");
  assert.equal(capLevel(row({ activated: false, state: { kind: "not_active" }, sentToday: 150 })), "ok");
  assert.equal(capLevel(row({ dailyCap: 0 })), "ok");
});

test("fleetSummary counts states, held messages, active sends and rows needing attention", () => {
  const rows = [
    row({ sentToday: 64 }),
    row({ state: { kind: "disconnected", waiting: 7 }, sentToday: 12 }),
    row({ state: { kind: "disconnected", waiting: 2 }, sentToday: 0 }),
    row({ state: { kind: "waiting_qr" }, sentToday: 0 }),
    row({ providerNudge: true, sentToday: 0 }),
    row({ activated: false, state: { kind: "not_active" }, sentToday: 5 }),
  ];
  assert.deepEqual(fleetSummary(rows), { connected: 2, offline: 2, waiting: 9, awaitingScan: 1, sentToday: 76, attention: 4 });
  assert.deepEqual(fleetSummary([]), { connected: 0, offline: 0, waiting: 0, awaitingScan: 0, sentToday: 0, attention: 0 });
});
