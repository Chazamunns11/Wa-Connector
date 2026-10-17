/** Pure billing rules: status map, sending gate, activation rules. No network, no Next. */
import test from "node:test";
import assert from "node:assert/strict";
import { mapStripeSubscriptionStatus } from "@/lib/billing/status";
import { REASON_NOT_ACTIVATED, reasonSubscriptionInactive, sendingGate } from "@/lib/billing/gate";
import { canActivate, platformCap } from "@/lib/billing/activation";
import type { BillingStatus } from "@/lib/types";

test("mapStripeSubscriptionStatus maps every known status", () => {
  const pairs: Array<[string, string | null]> = [
    ["trialing", "trialing"],
    ["active", "active"],
    ["past_due", "past_due"],
    ["unpaid", "paused"],
    ["paused", "paused"],
    ["canceled", "cancelled"],
    ["incomplete_expired", "cancelled"],
    ["incomplete", null],
    ["garbage", null],
  ];
  for (const [input, expected] of pairs) assert.equal(mapStripeSubscriptionStatus(input), expected, input);
});

const INACTIVE = "PingWren subscription inactive — the account owner needs to update billing";
const all: Array<BillingStatus | null> = ["pending", "trialing", "active", "past_due", "paused", "cancelled", "comped", null];

test("sendingGate: not activated refuses with the fixed string whatever the status", () => {
  for (const s of all) {
    assert.equal(sendingGate({ accountId: null, activatedAt: null }, s, "PingWren"), REASON_NOT_ACTIVATED);
  }
  assert.equal(sendingGate({ accountId: "a", activatedAt: null }, "active", "PingWren"), REASON_NOT_ACTIVATED);
  assert.equal(REASON_NOT_ACTIVATED, "WhatsApp isn't activated for this sub-account");
});

test("sendingGate: activated but billing not live refuses", () => {
  const loc = { accountId: "a", activatedAt: "2026-10-16T00:00:00Z" };
  for (const s of [null, "pending", "paused", "cancelled"] as const) assert.equal(sendingGate(loc, s, "PingWren"), INACTIVE);
  assert.equal(reasonSubscriptionInactive("PingWren"), INACTIVE);
});

test("sendingGate: activated with trialing, active, past_due or comped sends", () => {
  const loc = { accountId: "a", activatedAt: "2026-10-16T00:00:00Z" };
  for (const s of ["trialing", "active", "past_due", "comped"] as const) assert.equal(sendingGate(loc, s, "PingWren"), null);
});

const base = { billingStatus: "active" as BillingStatus, alreadyActive: false, accountActive: 0, platformActive: 0, platformCap: null };

test("canActivate: refusals and precedence", () => {
  assert.deepEqual(canActivate({ ...base, alreadyActive: true }), { ok: false, reason: "already_active" });
  for (const s of ["pending", "paused", "cancelled"] as const) {
    assert.deepEqual(canActivate({ ...base, billingStatus: s }), { ok: false, reason: "billing_inactive" });
  }
  assert.deepEqual(canActivate({ ...base, billingStatus: "trialing", accountActive: 3 }), { ok: false, reason: "trial_cap" });
  assert.deepEqual(canActivate({ ...base, billingStatus: "trialing", accountActive: 2 }), { ok: true });
  assert.deepEqual(canActivate({ ...base, accountActive: 40 }), { ok: true });
  assert.deepEqual(canActivate({ ...base, platformCap: 50, platformActive: 50 }), { ok: false, reason: "platform_cap" });
  assert.deepEqual(canActivate({ ...base, platformCap: 50, platformActive: 49 }), { ok: true });
  assert.deepEqual(canActivate({ ...base, platformCap: null, platformActive: 9999 }), { ok: true });
  // precedence
  assert.deepEqual(
    canActivate({ billingStatus: "pending", alreadyActive: true, accountActive: 9, platformActive: 99, platformCap: 1 }),
    { ok: false, reason: "already_active" },
  );
  assert.deepEqual(
    canActivate({ billingStatus: "paused", alreadyActive: false, accountActive: 9, platformActive: 99, platformCap: 1 }),
    { ok: false, reason: "billing_inactive" },
  );
  assert.deepEqual(
    canActivate({ billingStatus: "trialing", alreadyActive: false, accountActive: 3, platformActive: 99, platformCap: 1 }),
    { ok: false, reason: "trial_cap" },
  );
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
