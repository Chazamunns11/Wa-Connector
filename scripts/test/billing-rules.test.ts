/** Pure billing rules: status map, sending gate, activation rules. No network, no Next. */
import test from "node:test";
import assert from "node:assert/strict";
import { mapStripeSubscriptionStatus } from "@/lib/billing/status";
import { REASON_NOT_ACTIVATED, reasonSubscriptionInactive, sendingGate } from "@/lib/billing/gate";
import { canActivate, hasCardOnFile, platformCap } from "@/lib/billing/activation";
import type { BillingStatus, NumberBillingStatus } from "@/lib/types";

test("mapStripeSubscriptionStatus maps every known status onto a number's billing status", () => {
  const pairs: Array<[string, string | null]> = [
    ["trialing", "trialing"],
    ["active", "active"],
    ["past_due", "past_due"],
    ["unpaid", "paused"],
    ["paused", "paused"],
    ["canceled", "cancelled"],
    ["incomplete_expired", "cancelled"],
    ["incomplete", "incomplete"],
    ["garbage", null],
  ];
  for (const [input, expected] of pairs) assert.equal(mapStripeSubscriptionStatus(input), expected, input);
});

const INACTIVE = "PingWren subscription inactive — the account owner needs to update billing";
const all: Array<BillingStatus | null> = ["pending", "trialing", "active", "past_due", "paused", "cancelled", "comped", null];
const numberStatuses: Array<NumberBillingStatus | null> = ["trialing", "active", "past_due", "paused", "incomplete", "cancelled", null];

test("sendingGate: not activated refuses with the fixed string whatever the statuses", () => {
  for (const s of all) {
    for (const n of numberStatuses) assert.equal(sendingGate({ accountId: null, activatedAt: null }, s, "PingWren", n), REASON_NOT_ACTIVATED);
  }
  assert.equal(sendingGate({ accountId: "a", activatedAt: null }, "active", "PingWren", "active"), REASON_NOT_ACTIVATED);
  assert.equal(REASON_NOT_ACTIVATED, "WhatsApp isn't activated for this sub-account");
});

test("sendingGate: activated, but the sending number's subscription is not live (or there is no owner) refuses", () => {
  const loc = { accountId: "a", activatedAt: "2026-10-16T00:00:00Z" };
  for (const n of ["paused", "incomplete", "cancelled", null] as const) assert.equal(sendingGate(loc, "active", "PingWren", n), INACTIVE);
  assert.equal(sendingGate(loc, null, "PingWren", "active"), INACTIVE);
  assert.equal(reasonSubscriptionInactive("PingWren"), INACTIVE);
});

test("sendingGate: activated with the number trialing, active or past_due sends; a comped account always sends", () => {
  const loc = { accountId: "a", activatedAt: "2026-10-16T00:00:00Z" };
  for (const n of ["trialing", "active", "past_due"] as const) assert.equal(sendingGate(loc, "active", "PingWren", n), null);
  for (const n of numberStatuses) assert.equal(sendingGate(loc, "comped", "PingWren", n), null);
});

const base = { billingStatus: "active" as BillingStatus, alreadyActive: false, platformActive: 0, platformCap: null };

test("canActivate: a card on file (active) or comped may activate; no trial cap; precedence", () => {
  assert.deepEqual(canActivate({ ...base, alreadyActive: true }), { ok: false, reason: "already_active" });
  for (const s of ["pending", "trialing", "past_due", "paused", "cancelled"] as const) {
    assert.deepEqual(canActivate({ ...base, billingStatus: s }), { ok: false, reason: "billing_inactive" }, s);
  }
  assert.deepEqual(canActivate({ ...base, billingStatus: "comped" }), { ok: true });
  assert.deepEqual(canActivate(base), { ok: true });
  assert.deepEqual(canActivate({ ...base, platformCap: 50, platformActive: 50 }), { ok: false, reason: "platform_cap" });
  assert.deepEqual(canActivate({ ...base, platformCap: 50, platformActive: 49 }), { ok: true });
  assert.deepEqual(canActivate({ ...base, platformCap: null, platformActive: 9999 }), { ok: true });
  assert.deepEqual(canActivate({ billingStatus: "pending", alreadyActive: true, platformActive: 99, platformCap: 1 }), { ok: false, reason: "already_active" });
  assert.deepEqual(canActivate({ billingStatus: "pending", alreadyActive: false, platformActive: 99, platformCap: 1 }), { ok: false, reason: "billing_inactive" });
});

test("hasCardOnFile: only active and comped", () => {
  for (const s of all.filter((x): x is BillingStatus => x !== null)) assert.equal(hasCardOnFile(s), s === "active" || s === "comped", s);
});

test("platformCap reads BRAND_MAX_ACTIVE_NUMBERS as a positive integer", () => {
  const prev = process.env.BRAND_MAX_ACTIVE_NUMBERS;
  try {
    delete process.env.BRAND_MAX_ACTIVE_NUMBERS;
    assert.equal(platformCap(), null);
    process.env.BRAND_MAX_ACTIVE_NUMBERS = "abc";
    assert.equal(platformCap(), null);
    process.env.BRAND_MAX_ACTIVE_NUMBERS = "0";
    assert.equal(platformCap(), null);
    process.env.BRAND_MAX_ACTIVE_NUMBERS = "75";
    assert.equal(platformCap(), 75);
  } finally {
    if (prev === undefined) delete process.env.BRAND_MAX_ACTIVE_NUMBERS;
    else process.env.BRAND_MAX_ACTIVE_NUMBERS = prev;
  }
});
