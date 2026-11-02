import test from "node:test";
import assert from "node:assert/strict";

import {
  retrieveCheckoutSession,
  retrieveSubscription,
  createPortalSession,
  createCardSetupSession,
  createCustomer,
  retrieveCustomerCard,
  setCustomerDefaultPaymentMethod,
  resumeSubscription,
  parseSubscription,
} from "@/lib/stripe/billing";

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

const base = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRODUCT_ID: "prod_9", STRIPE_WEBHOOK_SECRET: "whsec" };

test("createCustomer: one customer per account, tagged and idempotent on the account id", async () => {
  const calls: Array<{ method: string; path: string; params: unknown; opts: unknown }> = [];
  const request = (async (method: string, path: string, params: unknown, opts: unknown) => {
    calls.push({ method, path, params, opts });
    return { ok: true, data: { id: "cus_1" } };
  }) as never;
  const r = await createCustomer({ accountId: "acc-1", email: "a@b.co" }, { request });
  assert.ok(r.ok && r.data.id === "cus_1");
  assert.deepEqual(calls, [
    { method: "POST", path: "/customers", params: { email: "a@b.co", metadata: { account_id: "acc-1" } }, opts: { idempotencyKey: "customer-acc-1" } },
  ]);
});

test("retrieveCustomerCard reads the customer's default card (what every number charges)", async () => {
  let f = fake({ id: "cus", invoice_settings: { default_payment_method: { card: { last4: "4242" } } } });
  const r = await retrieveCustomerCard("cus", f.deps);
  assert.deepEqual(f.calls[0], { method: "GET", path: "/customers/cus", params: { expand: ["invoice_settings.default_payment_method"] } });
  assert.ok(r.ok && r.data.cardLast4 === "4242");
  f = fake({ id: "cus", invoice_settings: { default_payment_method: null } });
  const none = await retrieveCustomerCard("cus", f.deps);
  assert.ok(none.ok && none.data.cardLast4 === null);
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
    items: { data: [{ id: "si_1", quantity: 3, price: { unit_amount: 799 } }] },
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
    unitAmount: 799,
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

    f = fake({ id: "cs_1", status: "complete", customer: "cus", metadata: { account_id: "a" } });
    const c = await retrieveCheckoutSession("cs_1", f.deps);
    assert.deepEqual(f.calls[0], { method: "GET", path: "/checkout/sessions/cs_1", params: { expand: ["setup_intent", "setup_intent.payment_method"] } });
    assert.ok(c.ok && c.data.metadata.account_id === "a");
    assert.ok(c.ok && c.data.mode === null && c.data.setupPaymentMethod === null && c.data.setupBillingAddress === null);

    f = fake({ id: "cs_2", status: "complete", mode: "setup", customer: "cus", setup_intent: { id: "seti_1", payment_method: "pm_1" }, metadata: {} });
    const s = await retrieveCheckoutSession("cs_2", f.deps);
    assert.ok(s.ok && s.data.mode === "setup" && s.data.setupPaymentMethod === "pm_1");
    f = fake({ id: "cs_3", mode: "setup", setup_intent: { payment_method: { id: "pm_2" } }, metadata: {} });
    const s2 = await retrieveCheckoutSession("cs_3", f.deps);
    assert.ok(s2.ok && s2.data.setupPaymentMethod === "pm_2");
    // The card's billing address (collected by billing_address_collection: required) is carried for the customer.
    const address = { line1: "1 High St", city: "Chesterfield", postal_code: "S40 1AA", country: "GB" };
    f = fake({ id: "cs_4", mode: "setup", setup_intent: { payment_method: { id: "pm_3", billing_details: { address: { ...address, line2: null } } } }, metadata: {} });
    const s3 = await retrieveCheckoutSession("cs_4", f.deps);
    assert.ok(s3.ok);
    if (s3.ok) assert.deepEqual(s3.data.setupBillingAddress, address);

    f = fake({ url: "P" });
    await createPortalSession("cus", "R", f.deps);
    assert.deepEqual(f.calls[0], {
      method: "POST", path: "/billing_portal/sessions", params: { customer: "cus", return_url: "R" },
    });
  });
});

test("save a card: setup-mode Checkout on the account's customer, card only, billing address required, purpose in both metadata", async () => {
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
      billing_address_collection: "required",
      client_reference_id: "acc-1",
      metadata,
      setup_intent_data: { metadata },
      success_url: "S",
      cancel_url: "C",
    },
  });
});

test("default payment method and resume calls", async () => {
  const sub = { id: "sub_1", status: "active", customer: "cus", items: { data: [] }, metadata: {} };
  let f = fake({ id: "cus" });
  await setCustomerDefaultPaymentMethod("cus", "pm_1", f.deps);
  assert.deepEqual(f.calls[0], { method: "POST", path: "/customers/cus", params: { invoice_settings: { default_payment_method: "pm_1" } } });
  f = fake({ id: "cus" });
  await setCustomerDefaultPaymentMethod("cus", "pm_1", f.deps, { line1: "1 High St", country: "GB" });
  assert.deepEqual(f.calls[0].params, { invoice_settings: { default_payment_method: "pm_1" }, address: { line1: "1 High St", country: "GB" } });
  f = fake(sub);
  const r = await resumeSubscription("sub_1", f.deps);
  assert.deepEqual(f.calls[0], { method: "POST", path: "/subscriptions/sub_1/resume", params: { billing_cycle_anchor: "now" } });
  assert.ok(r.ok && r.data.status === "active");
});
