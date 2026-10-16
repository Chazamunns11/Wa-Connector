import test from "node:test";
import assert from "node:assert/strict";

import {
  createCheckoutSession,
  retrieveCheckoutSession,
  retrieveSubscription,
  setSubscriptionItemQuantity,
  endTrialNow,
  createPortalSession,
  parseSubscription,
  stripeVolumeTiers,
} from "@/lib/stripe/billing";
import { STANDARD_PENCE, VOLUME_PENCE, VOLUME_FROM } from "@/lib/pricing";

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

const input = { accountId: "acc-1", customerEmail: "a@b.co", successUrl: "S", cancelUrl: "C" };
const base = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_9", STRIPE_WEBHOOK_SECRET: "whsec" };

test("createCheckoutSession: trial subscription params, no tax by default", async () => {
  await withEnv({ ...base, STRIPE_AUTOMATIC_TAX: undefined }, async () => {
    const { calls, deps } = fake({ id: "cs_1", url: "U" });
    await createCheckoutSession(input, deps);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/checkout/sessions");
    assert.deepEqual(calls[0].params, {
      mode: "subscription",
      customer_email: "a@b.co",
      client_reference_id: "acc-1",
      line_items: [{ price: "price_9", quantity: 1 }],
      subscription_data: { trial_period_days: 7, metadata: { account_id: "acc-1" } },
      metadata: { account_id: "acc-1", owner_email: "a@b.co" },
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

test("parseSubscription: typed shape, object customer, missing items", () => {
  const raw = {
    id: "sub_1",
    status: "trialing",
    customer: "cus",
    trial_end: 1,
    canceled_at: null,
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
      params: { expand: ["subscription", "subscription.default_payment_method"] },
    });
    assert.ok(c.ok && c.data.subscription?.id === "sub_1" && c.data.metadata.account_id === "a");

    f = fake({ id: "si_1", quantity: 0 });
    await setSubscriptionItemQuantity("si_1", 0, f.deps);
    assert.deepEqual(f.calls[0], {
      method: "POST", path: "/subscription_items/si_1", params: { quantity: 0, proration_behavior: "create_prorations" },
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

test("stripeVolumeTiers: Stripe volume-price definition matches W40 pence", () => {
  assert.deepEqual(stripeVolumeTiers(), {
    currency: "gbp",
    billing_scheme: "tiered",
    tiers_mode: "volume",
    tiers: [
      { up_to: VOLUME_FROM - 1, unit_amount: STANDARD_PENCE },
      { up_to: "inf", unit_amount: VOLUME_PENCE },
    ],
  });
  assert.equal(STANDARD_PENCE, 1499);
  assert.equal(VOLUME_PENCE, 799);
  assert.equal(VOLUME_FROM, 10);
});
