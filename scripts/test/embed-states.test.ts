import test from "node:test";
import assert from "node:assert/strict";
import { embedPausedMessage, embedStateFor } from "@/app/api/crm/embed/session/logic";
import type { BillingStatus, GhlAccount } from "@/lib/types";

function acct(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: "loc",
    tenantId: "t",
    label: "L",
    companyId: null,
    conversationProviderId: null,
    accessToken: "a",
    accessTokenExpiresAt: "2030-01-01T00:00:00Z",
    refreshToken: "r",
    status: "active",
    lastError: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    accountId: "acc",
    activatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  } as GhlAccount;
}

test("embedStateFor: disabled wins over everything", () => {
  assert.deepEqual(embedStateFor(acct({ status: "disabled", accountId: null }), null, "u"), { state: "disabled" });
});

test("embedStateFor: no account id is unclaimed and carries the claim url (or null)", () => {
  assert.deepEqual(embedStateFor(acct({ accountId: null }), null, "https://x/signup?claim=t"), { state: "unclaimed", claimUrl: "https://x/signup?claim=t" });
  assert.deepEqual(embedStateFor(acct({ accountId: null }), "active", null), { state: "unclaimed", claimUrl: null });
});

test("embedStateFor: pending, paused, cancelled and a missing account are billing_paused", () => {
  for (const b of ["pending", "paused", "cancelled", null] as (BillingStatus | null)[]) {
    assert.deepEqual(embedStateFor(acct(), b, null), { state: "billing_paused" }, String(b));
  }
});

test("embedStateFor: billing live but no activation is not_activated", () => {
  assert.deepEqual(embedStateFor(acct({ activatedAt: null }), "trialing", null), { state: "not_activated" });
});

test("embedStateFor: live billing and activated is ok (past_due and comped included)", () => {
  for (const b of ["trialing", "active", "past_due", "comped"] as BillingStatus[]) {
    assert.deepEqual(embedStateFor(acct(), b, null), { state: "ok" }, b);
  }
});

test("embedStateFor: a paused account that still has a trial end says the trial ended", () => {
  assert.deepEqual(embedStateFor(acct(), "paused", null, "2026-10-10T00:00:00Z"), { state: "billing_paused", reason: "trial_ended" });
});

test("embedStateFor: unpaid or paused-without-trial stays the generic billing_paused, and never carries ids", () => {
  assert.deepEqual(embedStateFor(acct(), "paused", null, null), { state: "billing_paused" });
  assert.deepEqual(embedStateFor(acct(), "cancelled", null, "2026-10-10T00:00:00Z"), { state: "billing_paused" });
  assert.deepEqual(embedStateFor(acct(), "pending", null, "2026-10-10T00:00:00Z"), { state: "billing_paused" });
  const json = JSON.stringify(embedStateFor(acct(), "paused", null, "2026-10-10T00:00:00Z"));
  assert.ok(!json.includes("tenant") && !json.includes('"t"') && !json.includes("acc"));
});

test("embedPausedMessage: trial-ended copy, else the generic billing line", () => {
  assert.equal(embedPausedMessage(true), "The free trial has ended. The account owner needs to add a card to keep sending.");
  assert.equal(embedPausedMessage(false), "The account owner needs to update billing.");
});
