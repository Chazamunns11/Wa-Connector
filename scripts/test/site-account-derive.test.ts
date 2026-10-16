import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeCount,
  headline,
  needsAttention,
  planStatus,
  primaryActionFor,
  rowActionsFor,
  trialDaysLeft,
} from "@/lib/account-data/derive";
import type { AccountSummary, BillingStatus, LocationRow } from "@/lib/account-data/types";

const NOW = new Date("2026-10-16T12:00:00Z");
const day = 86_400_000;

function acct(billingStatus: BillingStatus, trialEndsAt: string | null = null): AccountSummary {
  return { id: "a", name: "Sample Co", kind: "business", email: "o@example.com", billingStatus, trialEndsAt, stripeCustomerId: null, stripeSubscriptionId: null };
}
function row(over: Partial<LocationRow> = {}): LocationRow {
  return {
    id: "l", name: "Sample Studio", activated: true, state: { kind: "connected", number: "+447700900000" },
    sentToday: 10, dailyCap: 150, heldMessages: 0, failedLast7Days: { count: 0, reasons: [] },
    optOuts: 0, providerNudge: false, ...over,
  };
}

test("trialDaysLeft: 4 days ahead → 4; past → 0; null → 0", () => {
  assert.equal(trialDaysLeft(new Date(NOW.getTime() + 4 * day).toISOString(), NOW), 4);
  assert.equal(trialDaysLeft(new Date(NOW.getTime() + 3.2 * day).toISOString(), NOW), 4);
  assert.equal(trialDaysLeft(new Date(NOW.getTime() - day).toISOString(), NOW), 0);
  assert.equal(trialDaysLeft(null, NOW), 0);
  assert.equal(trialDaysLeft("not a date", NOW), 0);
});

test("planStatus per billing status", () => {
  const end = new Date(NOW.getTime() + 4 * day).toISOString();
  assert.deepEqual(planStatus(acct("trialing", end), NOW), { label: "Trial: 4 days left", tone: "warn", banner: null });
  assert.equal(planStatus(acct("trialing", new Date(NOW.getTime() + day).toISOString()), NOW).label, "Trial: 1 day left");
  assert.equal(planStatus(acct("trialing", new Date(NOW.getTime() - day).toISOString()), NOW).label, "Trial ended");
  assert.deepEqual(planStatus(acct("active"), NOW), { label: "Active", tone: "win", banner: null });
  assert.deepEqual(planStatus(acct("comped"), NOW), { label: "Active", tone: "win", banner: null });
  assert.deepEqual(planStatus(acct("past_due"), NOW), {
    label: "Payment failed", tone: "loss",
    banner: "Payment failed — update your card. Sending continues while we retry.",
  });
  const paused = planStatus(acct("paused"), NOW);
  assert.equal(paused.banner, "Sending is paused — update billing to resume");
  assert.equal(paused.tone, "loss");
  assert.deepEqual(planStatus(acct("cancelled"), NOW), { label: "Cancelled", tone: "muted", banner: null });
});

test("planStatus pending: an abandoned Checkout shows the trial has not started", () => {
  assert.deepEqual(planStatus(acct("pending"), NOW), {
    label: "Trial not started",
    tone: "warn",
    banner: "Add a card to start your 7-day free trial.",
  });
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

test("headline reads '2 numbers active · £29.98/month' and switches to the volume price at 10", () => {
  const rows = [row(), row(), row({ activated: false, state: { kind: "not_active" } })];
  assert.equal(headline(rows), "2 numbers active · £29.98/month");
  assert.equal(headline([row()]), "1 number active · £14.99/month");
  assert.equal(headline([]), "0 numbers active · £0.00/month");
  assert.equal(headline(Array.from({ length: 9 }, () => row())), "9 numbers active · £134.91/month");
  assert.equal(headline(Array.from({ length: 10 }, () => row())), "10 numbers active · £79.90/month");
});

test("activeCount counts activated rows only", () => {
  assert.equal(activeCount([row(), row({ activated: false }), row()]), 2);
  assert.equal(activeCount([]), 0);
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
