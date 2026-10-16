import test from "node:test";
import assert from "node:assert/strict";

import { encodeForm, stripeRequest, isStripeConfigured, STRIPE_API_VERSION } from "@/lib/stripe/client";

test("encodeForm: nested objects, arrays, booleans, nulls", () => {
  const out = encodeForm({
    mode: "subscription",
    line_items: [{ price: "p", quantity: 1 }],
    subscription_data: { trial_period_days: 7, metadata: { account_id: "a" } },
    automatic_tax: { enabled: true },
    skipped: null,
    alsoSkipped: undefined,
  });
  assert.equal(
    out,
    "mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&subscription_data%5Btrial_period_days%5D=7&subscription_data%5Bmetadata%5D%5Baccount_id%5D=a&automatic_tax%5Benabled%5D=true",
  );
  assert.equal(encodeForm({ x: false }), "x=false");
});

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> | T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const restore = () => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

test("stripeRequest: POST sends version, auth, form body, idempotency key", async () => {
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_1" }, async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "cus_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await stripeRequest<{ id: string }>("POST", "/customers/cus_1", { name: "A" }, { idempotencyKey: "k1", fetchImpl });
    assert.deepEqual(r, { ok: true, data: { id: "cus_1" } });
    assert.equal(calls[0].url, "https://api.stripe.com/v1/customers/cus_1");
    const h = calls[0].init.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer sk_test_x");
    assert.equal(h["Stripe-Version"], STRIPE_API_VERSION);
    assert.equal(STRIPE_API_VERSION, "2024-11-20.acacia");
    assert.equal(h["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(h["Idempotency-Key"], "k1");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, "name=A");
  });
});

test("stripeRequest: GET appends query, no body, no idempotency header", async () => {
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_1" }, async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await stripeRequest("GET", "/customers/cus_1", { a: "b" }, { fetchImpl });
    assert.equal(calls[0].url, "https://api.stripe.com/v1/customers/cus_1?a=b");
    assert.equal(calls[0].init.body, undefined);
    assert.equal((calls[0].init.headers as Record<string, string>)["Idempotency-Key"], undefined);
  });
});

test("stripeRequest: error mapping and network failure", async () => {
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_1" }, async () => {
    const declined = (async () =>
      new Response(JSON.stringify({ error: { code: "card_declined", message: "m" } }), { status: 402 })) as unknown as typeof fetch;
    assert.deepEqual(await stripeRequest("POST", "/x", {}, { fetchImpl: declined }), {
      ok: false,
      status: 402,
      code: "card_declined",
      message: "m",
    });
    const boom = (async () => {
      throw new Error("secret detail");
    }) as unknown as typeof fetch;
    assert.deepEqual(await stripeRequest("GET", "/x", {}, { fetchImpl: boom }), {
      ok: false,
      status: 0,
      code: null,
      message: "network",
    });
  });
});

test("isStripeConfigured: needs both secret key and price id", () => {
  withEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_PRICE_ID: undefined }, () => assert.equal(isStripeConfigured(), false));
  withEnv({ STRIPE_SECRET_KEY: "sk", STRIPE_PRICE_ID: undefined }, () => assert.equal(isStripeConfigured(), false));
  withEnv({ STRIPE_SECRET_KEY: "sk", STRIPE_PRICE_ID: "p" }, () => assert.equal(isStripeConfigured(), true));
});
