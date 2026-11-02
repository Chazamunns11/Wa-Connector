import test from "node:test";
import assert from "node:assert/strict";

import { applyCardSetup, type CardSetupDeps } from "@/lib/billing/card";
import type { StripeCheckoutSession } from "@/lib/stripe/billing";
import type { Account, AccountBillingPatch, NumberBilling } from "@/lib/types";
import { account, number } from "./billing-fakes";

const session = (over: Partial<StripeCheckoutSession> = {}): StripeCheckoutSession => ({
  id: "cs_s",
  status: "complete",
  mode: "setup",
  customer: "cus",
  setupPaymentMethod: "pm_1",
  metadata: { account_id: "acc-1", purpose: "add_card" },
  ...over,
});

function harness(opts: { acct?: Account | null; numbers?: NumberBilling[]; live?: Record<string, string>; fail?: string } = {}) {
  const log: string[] = [];
  const patches: AccountBillingPatch[] = [];
  const ok = <T>(what: string, data: T) => {
    log.push(what);
    return what.startsWith(opts.fail ?? "\0") ? { ok: false as const, status: 500, code: null, message: "x" } : { ok: true as const, data };
  };
  const deps: CardSetupDeps = {
    setCustomerDefault: (async (c: string, pm: string) => ok(`customer:${c}:${pm}`, { id: c })) as never,
    retrieveSubscription: (async (id: string) => ok(`live:${id}`, { id, status: opts.live?.[id] ?? "paused" })) as never,
    resume: (async (id: string) => ok(`resume:${id}`, { id, status: "active" })) as never,
  };
  const acct = opts.acct === undefined ? account({ billingStatus: "pending" }) : opts.acct;
  const repo = {
    getAccountById: async () => acct,
    updateAccountBilling: async (_id: string, patch: AccountBillingPatch) => {
      patches.push(patch);
    },
    listNumberBillingForAccount: async () => opts.numbers ?? [],
  };
  return { log, deps, repo, patches };
}

test("signup: the card becomes the customer's default and a pending account becomes active (card on file)", async () => {
  const h = harness();
  assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "saved", resumed: 0 });
  assert.deepEqual(h.log, ["customer:cus:pm_1"]);
  assert.deepEqual(h.patches, [{ billingStatus: "active" }]);
});

test("a returning cancelled account is reset so it is not cleaned up again", async () => {
  const h = harness({ acct: account({ billingStatus: "cancelled" }) });
  await applyCardSetup(h.repo, h.deps, session());
  assert.deepEqual(h.patches, [{ billingStatus: "active", cancelledAt: null, cleanedUpAt: null }]);
});

test("a card added later resumes every number Stripe paused, and only those", async () => {
  const h = harness({
    acct: account(),
    numbers: [
      number("t1", { stripeSubscriptionId: "sub_1", billingStatus: "paused" }),
      number("t2", { stripeSubscriptionId: "sub_2", billingStatus: "paused" }),
      number("t3", { stripeSubscriptionId: "sub_3", billingStatus: "active" }),
    ],
    // sub_2 is `unpaid` in Stripe (stored as paused): not resumable, paid in the portal.
    live: { sub_1: "paused", sub_2: "unpaid" },
  });
  assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "saved", resumed: 1 });
  assert.deepEqual(h.log, ["customer:cus:pm_1", "live:sub_1", "resume:sub_1", "live:sub_2"]);
  assert.deepEqual(h.patches, [], "an active account is not rewritten");
});

test("a replay after the resume does not resume again", async () => {
  const h = harness({ acct: account(), numbers: [number("t1", { stripeSubscriptionId: "sub_1", billingStatus: "paused" })], live: { sub_1: "active" } });
  assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "saved", resumed: 0 });
  assert.ok(!h.log.some((l) => l.startsWith("resume")));
});

test("ignores sessions that are not a completed save-a-card, or that name another customer", async () => {
  for (const s of [
    session({ mode: "subscription" }),
    session({ status: "open" }),
    session({ metadata: { account_id: "acc-1" } }),
    session({ setupPaymentMethod: null }),
    session({ metadata: { purpose: "add_card" } }),
    session({ customer: "cus_other" }),
  ]) {
    const h = harness();
    assert.deepEqual(await applyCardSetup(h.repo, h.deps, s), { kind: "ignored" });
    assert.deepEqual(h.log, []);
    assert.deepEqual(h.patches, []);
  }
});

test("an account without a Stripe customer is unknown_account and touches nothing", async () => {
  for (const a of [null, account({ stripeCustomerId: null })]) {
    const h = harness({ acct: a });
    assert.deepEqual(await applyCardSetup(h.repo, h.deps, session()), { kind: "unknown_account" });
    assert.deepEqual(h.log, []);
  }
});

test("a Stripe failure throws so the webhook releases the event and Stripe retries", async () => {
  for (const step of ["customer", "live", "resume"]) {
    const h = harness({ acct: account(), numbers: [number("t1", { stripeSubscriptionId: "sub_1", billingStatus: "paused" })], fail: step });
    await assert.rejects(applyCardSetup(h.repo, h.deps, session()), /card setup/, step);
  }
});
