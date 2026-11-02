import test from "node:test";
import assert from "node:assert/strict";

import { applyCardSetup, type CardSetupDeps } from "@/lib/billing/card";
import type { StripeCheckoutSession } from "@/lib/stripe/billing";
import type { Account } from "@/lib/types";

const account = (over: Partial<Account> = {}): Account =>
  ({
    id: "acc-1",
    name: "A",
    kind: "direct",
    ownerEmail: "o@x.co",
    stripeCustomerId: "cus",
    stripeSubscriptionId: "sub",
    billingStatus: "paused",
    trialEndsAt: "2026-10-20T00:00:00.000Z",
    cancelledAt: null,
    cleanedUpAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  }) as Account;

const session = (over: Partial<StripeCheckoutSession> = {}): StripeCheckoutSession => ({
  id: "cs_s",
  status: "complete",
  mode: "setup",
  customer: "cus",
  subscription: null,
  setupPaymentMethod: "pm_1",
  metadata: { account_id: "acc-1", purpose: "add_card" },
  ...over,
});

function harness(liveStatus: string, acct: Account | null = account(), fail?: string, latestInvoice: string | null = "in_1") {
  const log: string[] = [];
  const ok = <T>(what: string, data: T) => {
    log.push(what);
    return what.startsWith(fail ?? "\0") ? { ok: false as const, status: 500, code: null, message: "x" } : { ok: true as const, data };
  };
  const live = { id: "sub", status: liveStatus, latestInvoice } as { id: string; status: string; latestInvoice: string | null };
  const deps: CardSetupDeps = {
    setCustomerDefault: (async (c: string, pm: string) => ok(`customer:${c}:${pm}`, { id: c })) as never,
    retrieveSubscription: (async (id: string) => ok(`live:${id}`, live)) as never,
    resume: (async (id: string) => ok(`resume:${id}`, live)) as never,
    setSubscriptionDefault: (async (id: string, pm: string) => ok(`subdefault:${id}:${pm}`, live)) as never,
    endTrial: (async (id: string) => ok(`endtrial:${id}`, live)) as never,
    settleInvoice: (async (id: string, o: { paymentMethod?: string }) => {
      const r = ok(`pay:${id}:${o.paymentMethod}`, { id, status: "paid" });
      // Stripe marks the subscription active once its latest invoice is paid.
      if (r.ok) live.status = "active";
      return r;
    }) as never,
  };
  const repo = {
    getAccountById: async () => acct,
    updateAccountBilling: async (_id: string, patch: { billingStatus?: string }) => {
      log.push(`status:${patch.billingStatus}`);
    },
  };
  return { log, deps, repo };
}

test("a trial paused with no card: customer default, then resume, then the subscription default", async () => {
  const h = harness("paused");
  assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "resumed" });
  assert.deepEqual(h.log, ["customer:cus:pm_1", "live:sub", "resume:sub", "subdefault:sub:pm_1"]);
});

test("a replay after the resume does not resume again", async () => {
  const h = harness("active", account({ billingStatus: "active", trialEndsAt: null }));
  assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "saved" });
  assert.deepEqual(h.log, ["customer:cus:pm_1", "live:sub", "subdefault:sub:pm_1"]);
});

test("during the trial the card is saved and the trial carries on, unless the card was for ending it", async () => {
  const h = harness("trialing", account({ billingStatus: "trialing" }));
  assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "saved" });
  assert.ok(!h.log.some((l) => l.startsWith("endtrial") || l.startsWith("resume")));

  const e = harness("trialing", account({ billingStatus: "trialing" }));
  const s = session({ metadata: { account_id: "acc-1", purpose: "add_card", then: "end_trial" } });
  assert.deepEqual(await applyCardSetup(e.repo, e.deps, s), { kind: "trial_ended" });
  assert.equal(e.log.at(-1), "endtrial:sub");
});

test("ignores sessions that are not a completed add-a-card, or that name another customer", async () => {
  for (const s of [
    session({ mode: "subscription" }),
    session({ status: "open" }),
    session({ metadata: { account_id: "acc-1" } }),
    session({ setupPaymentMethod: null }),
    session({ metadata: { purpose: "add_card" } }),
    session({ customer: "cus_other" }),
  ]) {
    const h = harness("paused");
    assert.deepEqual(await applyCardSetup(h.repo, h.deps, s), { kind: "ignored" });
    assert.deepEqual(h.log, []);
  }
});

test("an account without a Stripe subscription is unknown_account and touches nothing", async () => {
  for (const a of [null, account({ stripeSubscriptionId: null }), account({ stripeCustomerId: null })]) {
    const h = harness("paused", a);
    assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "unknown_account" });
    assert.deepEqual(h.log, []);
  }
});

test("a Stripe failure throws so the webhook releases the event and Stripe retries", async () => {
  for (const step of ["customer", "live", "resume", "subdefault"]) {
    const h = harness("paused", account(), step);
    await assert.rejects(applyCardSetup(h.repo, h.deps, session()), /card setup/, step);
  }
});

test("unpaid or past due: the new card becomes the default, then the outstanding invoice is paid with it", async () => {
  for (const status of ["unpaid", "past_due"]) {
    const h = harness(status, account({ billingStatus: status === "unpaid" ? "paused" : "past_due", trialEndsAt: null }));
    assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "paid" }, status);
    // Pays with the new card, then re-reads Stripe and writes the status at once.
    assert.deepEqual(h.log, ["customer:cus:pm_1", "live:sub", "subdefault:sub:pm_1", "live:sub", "pay:in_1:pm_1", "live:sub", "status:active"], status);
  }
});

test("unpaid: a declined payment is reported, not thrown (Stripe must not replay the webhook for a decline)", async () => {
  const h = harness("unpaid", account({ trialEndsAt: null }), "pay:");
  assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "payment_failed" });
});

test("an active subscription is never charged again on a replay", async () => {
  const h = harness("active", account({ billingStatus: "active", trialEndsAt: null }));
  await applyCardSetup(h.repo, h.deps, session());
  assert.ok(!h.log.some((l) => l.startsWith("pay:")));
});
