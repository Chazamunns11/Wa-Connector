import test from "node:test";
import assert from "node:assert/strict";

import { billedCount, cancelNumber, isRunning, subscribeNumbers, syncNumberPrices } from "@/lib/billing/numbers";
import { createNumberSubscription, setSubscriptionItemPrice, cancelSubscription } from "@/lib/stripe/billing";
import { account, fakeStripe, number, numbersRepo } from "./billing-fakes";

test("subscribeNumbers: one subscription per new number, each with its own trial, at the tier for the count including them", async () => {
  const repo = numbersRepo([number("t1"), number("t2")]);
  const s = fakeStripe();
  const out = await subscribeNumbers(repo, s.deps, account(), ["t1", "t2"]);
  assert.equal(out.ok, true);
  assert.equal(out.created.length, 2);
  assert.deepEqual(s.log, ["create:t1:999:trial", "create:t2:999:trial"]);
  for (const t of ["t1", "t2"]) {
    const row = repo.rows.get(t)!;
    assert.equal(row.billingStatus, "trialing");
    assert.match(row.stripeSubscriptionId ?? "", /^sub_/);
    assert.equal(row.trialEndsAt, new Date(1_800_000_000 * 1000).toISOString());
    assert.equal(row.pricePence, 999);
  }
  assert.notEqual(repo.rows.get("t1")!.stripeSubscriptionId, repo.rows.get("t2")!.stripeSubscriptionId);
});

test("subscribeNumbers: the 11th billed number is created at the middle tier", async () => {
  const billed = Array.from({ length: 10 }, (_, i) => number(`b${i}`, { stripeSubscriptionId: `sub_b${i}`, billingStatus: "active", pricePence: 999 }));
  const repo = numbersRepo([...billed, number("new")]);
  const s = fakeStripe();
  await subscribeNumbers(repo, s.deps, account(), ["new"]);
  assert.deepEqual(s.log, ["create:new:799:trial"]);
});

test("subscribeNumbers: a number that has had a subscription before restarts with no trial; a running one is skipped", async () => {
  const repo = numbersRepo([
    number("old", { stripeSubscriptionId: "sub_old", billingStatus: "cancelled" }),
    number("live", { stripeSubscriptionId: "sub_live", billingStatus: "trialing" }),
  ]);
  const s = fakeStripe();
  const out = await subscribeNumbers(repo, s.deps, account(), ["old", "live"]);
  assert.equal(out.ok, true);
  // Count: 1 already billed (live) + 1 new = 2 -> standard tier.
  assert.deepEqual(s.log, ["create:old:999:now"]);
  assert.equal(repo.rows.get("old")!.billingStatus, "active");
  assert.equal(repo.rows.get("old")!.trialEndsAt, null);
  assert.equal(repo.rows.get("live")!.stripeSubscriptionId, "sub_live");
});

test("subscribeNumbers: no Stripe customer, or a Stripe failure, returns not ok with what was created so far", async () => {
  const repo = numbersRepo([number("t1"), number("t2")]);
  const none = fakeStripe();
  assert.deepEqual(await subscribeNumbers(repo, none.deps, account({ stripeCustomerId: null }), ["t1"]), { ok: false, created: [] });
  assert.deepEqual(none.log, []);
  const s = fakeStripe({ failCreateAfter: 1 });
  const out = await subscribeNumbers(repo, s.deps, account(), ["t1", "t2"]);
  assert.equal(out.ok, false);
  assert.equal(out.created.length, 1);
  assert.equal(s.notes.length, 1);
});

test("subscribeNumbers: a row write that fails after Stripe created the subscription cancels it and rethrows", async () => {
  const repo = numbersRepo([number("t1")]);
  repo.updateNumberBilling = async () => {
    throw new Error("db down");
  };
  const s = fakeStripe();
  await assert.rejects(subscribeNumbers(repo, s.deps, account(), ["t1"]), /db down/);
  assert.deepEqual(s.log.map((l) => l.split(":")[0]), ["create", "cancel"]);
  assert.equal([...s.subs.values()][0].status, "canceled");
});

test("cancelNumber: cancels a running subscription and records it; nothing running is a no-op; a missing one counts as cancelled", async () => {
  const repo = numbersRepo([number("t1", { stripeSubscriptionId: "sub_x", billingStatus: "trialing", trialEndsAt: "2026-11-09T00:00:00Z" })]);
  const s = fakeStripe();
  // Stripe has no sub_x: resource_missing is treated as already gone.
  assert.equal(await cancelNumber(repo, s.deps, repo.rows.get("t1")!), true);
  assert.equal(repo.rows.get("t1")!.billingStatus, "cancelled");
  assert.equal(repo.rows.get("t1")!.trialEndsAt, null);
  assert.equal(repo.rows.get("t1")!.stripeSubscriptionId, "sub_x", "kept, so a re-add restarts without a trial");
  s.log.length = 0;
  assert.equal(await cancelNumber(repo, s.deps, repo.rows.get("t1")!), true);
  assert.deepEqual(s.log, []);
});

test("cancelNumber: a Stripe failure returns false, writes nothing and tells Slack", async () => {
  const repo = numbersRepo([number("t1", { stripeSubscriptionId: "sub_x", billingStatus: "active" })]);
  const s = fakeStripe({ failOn: ["cancel"] });
  assert.equal(await cancelNumber(repo, s.deps, repo.rows.get("t1")!), false);
  assert.equal(repo.rows.get("t1")!.billingStatus, "active");
  assert.equal(s.notes.length, 1);
});

async function billedAccount(n: number, price: number) {
  const s = fakeStripe();
  const repo = numbersRepo([]);
  for (let i = 0; i < n; i++) {
    const r = await s.deps.createSubscription({ customerId: "cus", accountId: "acc-1", locationId: "loc-1", tenantId: `t${i}`, unitAmountPence: price, trial: true });
    if (!r.ok) throw new Error("setup");
    repo.rows.set(`t${i}`, number(`t${i}`, { stripeSubscriptionId: r.data.id, billingStatus: "trialing", pricePence: price }));
  }
  s.log.length = 0;
  return { s, repo };
}

test("syncNumberPrices: crossing up to 11 billed numbers re-prices all of them, with no proration", async () => {
  const { s, repo } = await billedAccount(11, 999);
  assert.deepEqual(await syncNumberPrices(repo, s.deps, account()), { ok: true });
  assert.equal(s.log.filter((l) => l.startsWith("price:")).length, 11);
  assert.ok(s.log.filter((l) => l.startsWith("price:")).every((l) => l.endsWith(":799")));
  assert.ok([...repo.rows.values()].every((n) => n.pricePence === 799));
});

test("syncNumberPrices: crossing back down below 25 re-prices to the middle tier; a settled account makes no Stripe call", async () => {
  const { s, repo } = await billedAccount(24, 599);
  await syncNumberPrices(repo, s.deps, account());
  assert.ok([...repo.rows.values()].every((n) => n.pricePence === 799));
  s.log.length = 0;
  await syncNumberPrices(repo, s.deps, account());
  assert.deepEqual(s.log, []);
});

test("syncNumberPrices: cancelled and never-billed numbers do not count and are not touched", async () => {
  const { s, repo } = await billedAccount(2, 999);
  repo.rows.set("gone", number("gone", { stripeSubscriptionId: "sub_gone", billingStatus: "cancelled", pricePence: 599 }));
  repo.rows.set("new", number("new"));
  await syncNumberPrices(repo, s.deps, account());
  assert.deepEqual(s.log, []);
  assert.equal(billedCount([...repo.rows.values()]), 2);
});

test("syncNumberPrices: comped or customer-less accounts do nothing; a Stripe failure is reported and the rest carry on", async () => {
  const { s, repo } = await billedAccount(11, 999);
  assert.deepEqual(await syncNumberPrices(repo, s.deps, account({ billingStatus: "comped" })), { ok: true });
  assert.deepEqual(await syncNumberPrices(repo, s.deps, account({ stripeCustomerId: null })), { ok: true });
  assert.deepEqual(s.log, []);
  const broken = fakeStripe({ failOn: ["price"] });
  broken.subs.clear();
  for (const [k, v] of s.subs) broken.subs.set(k, v);
  assert.deepEqual(await syncNumberPrices(repo, broken.deps, account()), { ok: false });
  assert.equal(broken.notes.length, 11);
  assert.ok([...repo.rows.values()].every((n) => n.pricePence === 999), "a failed re-price is not recorded");
});

test("isRunning: only a recorded subscription in a running status", () => {
  assert.equal(isRunning({ stripeSubscriptionId: null, billingStatus: "active" }), false);
  for (const st of ["trialing", "active", "past_due", "paused", "incomplete"] as const) assert.equal(isRunning({ stripeSubscriptionId: "s", billingStatus: st }), true, st);
  assert.equal(isRunning({ stripeSubscriptionId: "s", billingStatus: "cancelled" }), false);
  assert.equal(isRunning({ stripeSubscriptionId: "s", billingStatus: null }), false);
});

// The real Stripe calls these modules make, against a recorded request.
function recorder() {
  const calls: Array<{ method: string; path: string; params: Record<string, unknown> }> = [];
  const request = (async (method: string, path: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, path, params });
    return { ok: true, data: { id: "sub_1", status: "trialing", customer: "cus", items: { data: [{ id: "si_1", price: { unit_amount: 999 } }] }, metadata: {} } };
  }) as never;
  return { calls, request };
}

async function withStripeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { k: process.env.STRIPE_SECRET_KEY, p: process.env.STRIPE_PRODUCT_ID, t: process.env.STRIPE_AUTOMATIC_TAX };
  process.env.STRIPE_SECRET_KEY = "sk_test";
  process.env.STRIPE_PRODUCT_ID = "prod_1";
  delete process.env.STRIPE_AUTOMATIC_TAX;
  try {
    return await fn();
  } finally {
    for (const [k, v] of [["STRIPE_SECRET_KEY", prev.k], ["STRIPE_PRODUCT_ID", prev.p], ["STRIPE_AUTOMATIC_TAX", prev.t]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("createNumberSubscription: one inline-priced monthly item on STRIPE_PRODUCT_ID, tagged with the number, 7-day trial that pauses without a card", async () => {
  await withStripeEnv(async () => {
    const r = recorder();
    const out = await createNumberSubscription(
      { customerId: "cus", accountId: "acc-1", locationId: "loc-1", tenantId: "t1", unitAmountPence: 799, trial: true },
      { request: r.request },
    );
    assert.equal(out.ok, true);
    assert.deepEqual(r.calls, [
      {
        method: "POST",
        path: "/subscriptions",
        params: {
          customer: "cus",
          items: [{ price_data: { currency: "gbp", product: "prod_1", unit_amount: 799, recurring: { interval: "month" } } }],
          metadata: { account_id: "acc-1", location_id: "loc-1", tenant_id: "t1" },
          payment_behavior: "allow_incomplete",
          trial_period_days: 7,
          trial_settings: { end_behavior: { missing_payment_method: "pause" } },
        },
      },
    ]);
    const restart = recorder();
    await createNumberSubscription({ customerId: "cus", accountId: "a", locationId: "l", tenantId: "t", unitAmountPence: 999, trial: false }, { request: restart.request });
    assert.equal("trial_period_days" in restart.calls[0].params, false);
    assert.equal("trial_settings" in restart.calls[0].params, false);
  });
});

test("setSubscriptionItemPrice moves the item to a new inline price with no proration; cancelSubscription cancels now with a prorated credit", async () => {
  await withStripeEnv(async () => {
    const r = recorder();
    await setSubscriptionItemPrice("si_1", 599, { request: r.request });
    assert.deepEqual(r.calls[0], {
      method: "POST",
      path: "/subscription_items/si_1",
      params: { price_data: { currency: "gbp", product: "prod_1", unit_amount: 599, recurring: { interval: "month" } }, proration_behavior: "none" },
    });
    const c = recorder();
    await cancelSubscription("sub_1", { request: c.request });
    assert.deepEqual(c.calls[0], { method: "DELETE", path: "/subscriptions/sub_1", params: { invoice_now: true, prorate: true } });
  });
});
