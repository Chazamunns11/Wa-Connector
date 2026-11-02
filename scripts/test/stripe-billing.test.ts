import test from "node:test";
import assert from "node:assert/strict";

import {
  createCheckoutSession,
  retrieveCheckoutSession,
  retrieveSubscription,
  setSubscriptionItemQuantity,
  endTrialNow,
  createPortalSession,
  createCardSetupSession,
  setCustomerDefaultPaymentMethod,
  setSubscriptionDefaultPaymentMethod,
  resumeSubscription,
  parseSubscription,
  stripeNumberPrice,
} from "@/lib/stripe/billing";
import { PRICE_PER_NUMBER_PENCE } from "@/lib/pricing";

type Call = { method: string; path: string; params: Record<string, unknown> | undefined };
function fake(data: unknown = {}) {
  const calls: Call[] = [];
  const request = (async (method: string, path: string, params?: Record<string, unknown>) => {
    calls.push({ method, path, params });
    return { ok: true, data };
  }) as never;
  return { calls, deps: { request } };
}

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

const input = { accountId: "acc-1", customerEmail: "a£7\.99.co", successUrl: "S", cancelUrl: "C" };
const base = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_9", STRIPE_WEBHOOK_SECRET: "whsec" };

test("createCheckoutSession: 7-day trial that TAKES a card (charged on day 7), pausing only if no card is left; no tax by default", async () => {
  await withEnv({ ...base, STRIPE_AUTOMATIC_TAX: undefined }, async () => {
    const { calls, deps } = fake({ id: "cs_1", url: "U" });
    await createCheckoutSession(input, deps);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/checkout/sessions");
    assert.deepEqual(calls[0].params, {
      mode: "subscription",
      customer_email: "a£7\.99.co",
      client_reference_id: "acc-1",
      line_items: [{ price: "price_9", quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        trial_settings: { end_behavior: { missing_payment_method: "pause" } },
        metadata: { account_id: "acc-1" },
      },
      metadata: { account_id: "acc-1", owner_email: "a£7\.99.co" },
      payment_method_collection: "always",
      success_url: "S",
      cancel_url: "C",
    });
  });
});

test("createCheckoutSession: automatic tax when enabled", async () => {
  await withEnv({ ...base, STRIPE_AUTOMATIC_TAX: "true" }, async () => {
    const { calls, deps } = fake({ id: "cs_1", url: "U" });
    await createCheckoutSession(input, deps);
    assert.deepEqual(calls[0].params?.automatic_tax, { enabled: true });
    assert.deepEqual(calls[0].params?.customer_update, { address: "auto" });
  });
});

test("createCheckoutSession: a restart has no trial, no trial_settings and still needs a card", async () => {
  await withEnv({ ...base, STRIPE_AUTOMATIC_TAX: undefined }, async () => {
    const { calls, deps } = fake({ id: "cs_1", url: "U" });
    await createCheckoutSession({ ...input, trial: false, customerId: "cus_9" }, deps);
    const p = calls[0].params as Record<string, unknown>;
    assert.deepEqual(p.subscription_data, { metadata: { account_id: "acc-1" } });
    assert.equal(p.customer, "cus_9");
    assert.equal("customer_email" in p, false);
    assert.equal(p.payment_method_collection, "always");
  });
});

test("parseSubscription: typed shape, object customer, missing items", () => {
  const raw = {
    id: "sub_1",
    status: "trialing",
    customer: "cus",
    trial_end: 1,
    canceled_at: null,
    ended_at: null,
    cancel_at_period_end: false,
    current_period_end: 2,
    items: { data: [{ id: "si_1", quantity: 3 }] },
    default_payment_method: { card: { last4: "4242" } },
    metadata: {},
  };
  assert.deepEqual(parseSubscription(raw), {
    id: "sub_1",
    status: "trialing",
    customer: "cus",
    trialEnd: 1,
    canceledAt: null,
    endedAt: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: 2,
    itemId: "si_1",
    quantity: 3,
    cardLast4: "4242",
    metadata: {},
  });
  assert.equal(parseSubscription({ ...raw, customer: { id: "cus" } })?.customer, "cus");
  const { items: _items, ...noItems } = raw;
  void _items;
  assert.equal(parseSubscription(noItems), null);
  assert.equal(parseSubscription(null), null);
});

test("retrieve and mutate calls use the specified paths and params", async () => {
  await withEnv(base, async () => {
    const sub = {
      id: "sub_1", status: "active", customer: "cus", items: { data: [{ id: "si_1", quantity: 1 }] }, metadata: {},
    };
    let f = fake(sub);
    const r = await retrieveSubscription("sub_1", f.deps);
    assert.deepEqual(f.calls[0], { method: "GET", path: "/subscriptions/sub_1", params: { expand: ["default_payment_method"] } });
    assert.ok(r.ok && r.data.itemId === "si_1");

    f = fake({ id: "cs_1", status: "complete", customer: "cus", subscription: sub, metadata: { account_id: "a" } });
    const c = await retrieveCheckoutSession("cs_1", f.deps);
    assert.deepEqual(f.calls[0], {
      method: "GET",
      path: "/checkout/sessions/cs_1",
      params: { expand: ["subscription", "subscription.default_payment_method", "setup_intent"] },
    });
    assert.ok(c.ok && c.data.subscription?.id === "sub_1" && c.data.metadata.account_id === "a");
    assert.ok(c.ok && c.data.mode === null && c.data.setupPaymentMethod === null);

    f = fake({ id: "cs_2", status: "complete", mode: "setup", customer: "cus", subscription: null, setup_intent: { id: "seti_1", payment_method: "pm_1" }, metadata: {} });
    const s = await retrieveCheckoutSession("cs_2", f.deps);
    assert.ok(s.ok && s.data.mode === "setup" && s.data.setupPaymentMethod === "pm_1" && s.data.subscription === null);
    f = fake({ id: "cs_3", mode: "setup", setup_intent: { payment_method: { id: "pm_2" } }, metadata: {} });
    const s2 = await retrieveCheckoutSession("cs_3", f.deps);
    assert.ok(s2.ok && s2.data.setupPaymentMethod === "pm_2");

    f = fake({ id: "si_1", quantity: 0 });
    await setSubscriptionItemQuantity("si_1", 0, f.deps);
    // Every change is invoiced at once (no build-up to month end); a re-sync is never blocked by the card.
    assert.deepEqual(f.calls[0], {
      method: "POST", path: "/subscription_items/si_1", params: { quantity: 0, proration_behavior: "always_invoice", payment_behavior: "allow_incomplete" },
    });

    // An increase the customer asked for is charged now, or refused by Stripe if it can't be paid.
    f = fake({ id: "si_1", quantity: 2 });
    await setSubscriptionItemQuantity("si_1", 2, f.deps, { refuseIfUnpaid: true });
    assert.deepEqual(f.calls[0], {
      method: "POST", path: "/subscription_items/si_1", params: { quantity: 2, proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete" },
    });

    f = fake(sub);
    await endTrialNow("sub_1", f.deps);
    assert.deepEqual(f.calls[0], {
      method: "POST", path: "/subscriptions/sub_1", params: { trial_end: "now", proration_behavior: "none" },
    });

    f = fake({ url: "P" });
    await createPortalSession("cus", "R", f.deps);
    assert.deepEqual(f.calls[0], {
      method: "POST", path: "/billing_portal/sessions", params: { customer: "cus", return_url: "R" },
    });
  });
});

test("add-a-card: setup-mode Checkout on the existing customer, card only, purpose in both metadata", async () => {
  const f = fake({ id: "cs_s", url: "U" });
  const r = await createCardSetupSession({ accountId: "acc-1", customerId: "cus_1", successUrl: "S", cancelUrl: "C" }, f.deps);
  assert.ok(r.ok && r.data.url === "U");
  const metadata = { account_id: "acc-1", purpose: "add_card" };
  assert.deepEqual(f.calls[0], {
    method: "POST",
    path: "/checkout/sessions",
    params: {
      mode: "setup",
      customer: "cus_1",
      payment_method_types: ["card"],
      client_reference_id: "acc-1",
      metadata,
      setup_intent_data: { metadata },
      success_url: "S",
      cancel_url: "C",
    },
  });
  const g = fake({ id: "cs_s", url: "U" });
  await createCardSetupSession({ accountId: "acc-1", customerId: "cus_1", successUrl: "S", cancelUrl: "C", then: "end_trial" }, g.deps);
  assert.deepEqual((g.calls[0].params as { metadata: unknown }).metadata, { ...metadata, then: "end_trial" });
});

test("default payment method and resume calls", async () => {
  const sub = { id: "sub_1", status: "active", customer: "cus", items: { data: [] }, metadata: {} };
  let f = fake({ id: "cus" });
  await setCustomerDefaultPaymentMethod("cus", "pm_1", f.deps);
  assert.deepEqual(f.calls[0], { method: "POST", path: "/customers/cus", params: { invoice_settings: { default_payment_method: "pm_1" } } });
  f = fake(sub);
  await setSubscriptionDefaultPaymentMethod("sub_1", "pm_1", f.deps);
  assert.deepEqual(f.calls[0], {
    method: "POST", path: "/subscriptions/sub_1", params: { default_payment_method: "pm_1", expand: ["default_payment_method"] },
  });
  f = fake(sub);
  const r = await resumeSubscription("sub_1", f.deps);
  assert.deepEqual(f.calls[0], { method: "POST", path: "/subscriptions/sub_1/resume", params: { billing_cycle_anchor: "now" } });
  assert.ok(r.ok && r.data.status === "active");
});

test("stripeNumberPrice: monthly volume price per number, 799p for 1-24 and 599p for all from 25 (Nov 2026)", () => {
  assert.equal(PRICE_PER_NUMBER_PENCE, 799);
  assert.deepEqual(stripeNumberPrice(), {
    currency: "gbp",
    billing_scheme: "tiered",
    tiers_mode: "volume",
    tiers: [
      { up_to: 24, unit_amount: 799 },
      { up_to: "inf", unit_amount: 599 },
    ],
    recurring: { interval: "month" },
  });
});


