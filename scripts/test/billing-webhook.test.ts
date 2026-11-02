import test from "node:test";
import assert from "node:assert/strict";

import { handleBillingEvent, type WebhookDeps, type WebhookRepo } from "@/lib/billing/webhook-handler";
import { parseSubscription, type StripeCheckoutSession } from "@/lib/stripe/billing";
import type { Account, GhlAccount, NumberBilling } from "@/lib/types";
import { account, number, numbersRepo } from "./billing-fakes";

function harness(
  opts: {
    fresh?: boolean;
    numbers?: NumberBilling[];
    owner?: Account | null;
    session?: Partial<StripeCheckoutSession>;
  } = {},
) {
  const log: string[] = [];
  const notes: string[] = [];
  const nums = numbersRepo(opts.numbers ?? [number("t1", { stripeSubscriptionId: "sub", billingStatus: "trialing", pricePence: 999 })]);
  const state: { body: Record<string, unknown>; live: Record<string, unknown> | null } = { body: {}, live: null };
  const repo: WebhookRepo = {
    deleteStripeEvent: async () => {
      log.push("unrecord");
    },
    recordStripeEvent: async () => {
      log.push("record");
      return opts.fresh ?? true;
    },
    getAccountById: async () => (opts.owner === undefined ? account() : opts.owner),
    getGhlAccountByLocationId: async (id: string) => ({ locationId: id, accountId: "acc-1" }) as GhlAccount,
    getNumberBilling: nums.getNumberBilling,
    updateNumberBilling: nums.updateNumberBilling,
  };
  const session = { id: "cs_1", status: "complete", mode: "setup", customer: "cus", setupPaymentMethod: "pm", metadata: { account_id: "acc-1", purpose: "add_card" }, ...opts.session } as StripeCheckoutSession;
  const deps: WebhookDeps = {
    applyCardSetup: async () => {
      log.push("card");
      return { kind: "saved", resumed: 0 };
    },
    retrieveCheckoutSession: (async (id: string) => {
      log.push(`retrieve:${id}`);
      return { ok: true, data: session };
    }) as never,
    retrieveSubscription: (async (id: string) => {
      log.push(`live:${id}`);
      const raw = { ...(state.live ?? state.body) };
      const data = parseSubscription({ items: { data: [{ id: "si", price: { unit_amount: 999 } }] }, ...raw });
      return data ? { ok: true, data } : { ok: false, status: 500, code: null, message: "bad" };
    }) as never,
    syncPrices: async () => {
      log.push("sync");
    },
    notify: (t) => {
      notes.push(t);
    },
  };
  return { repo, deps, log, nums, notes, state };
}

type H = ReturnType<typeof harness>;
function run(h: H, event: Parameters<typeof handleBillingEvent>[2]) {
  h.state.body = event.data.object;
  return handleBillingEvent(h.repo, h.deps, event);
}

const sub = (over: Record<string, unknown> = {}) => ({
  id: "sub",
  status: "active",
  customer: "cus",
  metadata: { account_id: "acc-1", location_id: "loc-1", tenant_id: "t1" },
  ...over,
});
const ev = (type: string, object: Record<string, unknown>, id = "evt_1") => ({ id, type, data: { object } });

test("duplicate event id does nothing else", async () => {
  const h = harness({ fresh: false });
  assert.deepEqual(await run(h, ev("customer.subscription.updated", sub())), { kind: "duplicate" });
  assert.deepEqual(h.log, ["record"]);
  assert.equal(h.nums.writes.length, 0);
});

test("checkout.session.completed (save a card) retrieves the session fresh and applies the card", async () => {
  const h = harness();
  assert.deepEqual(await run(h, ev("checkout.session.completed", { id: "cs_1" })), { kind: "handled", type: "checkout.session.completed" });
  assert.deepEqual(h.log, ["record", "retrieve:cs_1", "card"]);
});

test("a non-setup Checkout is ignored: number subscriptions are never created by Checkout", async () => {
  const h = harness({ session: { mode: "subscription" } });
  assert.deepEqual(await run(h, ev("checkout.session.completed", { id: "cs_1" })), { kind: "ignored", type: "checkout.session.completed" });
  assert.ok(!h.log.includes("card"));
});

test("trialing -> active (the trial ended and the card was charged) writes the number's live status and re-prices", async () => {
  const h = harness();
  assert.deepEqual(await run(h, ev("customer.subscription.updated", sub())), { kind: "handled", type: "customer.subscription.updated" });
  assert.deepEqual(h.nums.writes, [{ tenantId: "t1", patch: { billingStatus: "active", trialEndsAt: null, pricePence: 999 } }]);
  assert.deepEqual(h.log, ["record", "live:sub", "sync"]);
});

test("a trialing number carries its own trial end", async () => {
  const h = harness({ numbers: [number("t1", { stripeSubscriptionId: "sub", billingStatus: "trialing" })] });
  await run(h, ev("customer.subscription.updated", sub({ status: "trialing", trial_end: 1_800_000_000 })));
  assert.equal(h.nums.rows.get("t1")!.trialEndsAt, new Date(1_800_000_000 * 1000).toISOString());
  assert.ok(!h.log.includes("sync"), "no status change, nothing to re-price");
});

test("past_due is written (the number keeps sending) and a deletion writes cancelled", async () => {
  const h = harness();
  await run(h, ev("customer.subscription.updated", sub({ status: "past_due" })));
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "past_due");
  await run(h, ev("customer.subscription.deleted", sub({ status: "canceled" }), "evt_2"));
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "cancelled");
  assert.equal(h.log.filter((l) => l === "sync").length, 2);
});

test("events are applied from the live subscription, not the event body (out-of-order delivery)", async () => {
  const h = harness();
  h.state.live = sub({ status: "canceled" });
  const event = ev("customer.subscription.updated", sub({ status: "active" }));
  await handleBillingEvent(h.repo, h.deps, event);
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "cancelled");
});

test("trial ended with no card: paused keeps the trial end date; unpaid also maps to paused", async () => {
  const h = harness();
  await run(h, ev("customer.subscription.paused", sub({ status: "paused", trial_end: 1_800_000_000 })));
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "paused");
  assert.equal(h.nums.rows.get("t1")!.trialEndsAt, new Date(1_800_000_000 * 1000).toISOString());
  await run(h, ev("customer.subscription.updated", sub({ status: "unpaid", trial_end: 1_800_000_000 }), "evt_2"));
  assert.equal(h.nums.rows.get("t1")!.trialEndsAt, null);
});

test("an unmapped status leaves the number untouched", async () => {
  const h = harness();
  assert.deepEqual(await run(h, ev("customer.subscription.updated", sub({ status: "mystery" }))), { kind: "handled", type: "customer.subscription.updated" });
  assert.equal(h.nums.writes.length, 0);
});

test("a subscription with no tenant in its metadata is not a number's and is ignored", async () => {
  const h = harness();
  assert.deepEqual(await run(h, ev("customer.subscription.updated", sub({ metadata: { account_id: "acc-1" } }))), { kind: "ignored", type: "customer.subscription.updated" });
  assert.equal(h.nums.writes.length, 0);
});

test("a removed number: a cancelled subscription is quietly ignored, a live one tells the operator", async () => {
  const h = harness({ numbers: [] });
  assert.equal((await run(h, ev("customer.subscription.deleted", sub({ status: "canceled" })))).kind, "ignored");
  assert.equal(h.notes.length, 0);
  assert.equal((await run(h, ev("customer.subscription.updated", sub({ status: "active" }), "evt_2"))).kind, "ignored");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /no longer exists/);
});

test("an older, replaced subscription never overwrites the number's current one", async () => {
  const h = harness({ numbers: [number("t1", { stripeSubscriptionId: "sub_new", billingStatus: "active" })] });
  assert.equal((await run(h, ev("customer.subscription.deleted", sub({ status: "canceled" })))).kind, "ignored");
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "active");
  assert.equal(h.notes.length, 0);
  await run(h, ev("customer.subscription.updated", sub({ status: "active" }), "evt_2"));
  assert.equal(h.notes.length, 1, "a live stray subscription is flagged");
});

test("a subscription event that beats its own row write is retried; one cancelled after a failed write is ignored", async () => {
  const h = harness({ numbers: [number("t1")] });
  await assert.rejects(run(h, ev("customer.subscription.created", sub({ status: "trialing" }))), /before its number recorded it/);
  assert.deepEqual(h.log.slice(-1), ["unrecord"]);
  assert.equal((await run(h, ev("customer.subscription.deleted", sub({ status: "canceled" }), "evt_2"))).kind, "ignored");
});

test("a number with no owning account is reported as unknown_account after its status is recorded", async () => {
  const h = harness({ owner: null });
  assert.deepEqual(await run(h, ev("customer.subscription.updated", sub())), { kind: "unknown_account", type: "customer.subscription.updated" });
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "active");
  assert.equal(h.notes.length, 1);
});

test("a failing handler releases the event id so Stripe's retry is processed", async () => {
  const h = harness();
  h.deps.retrieveSubscription = (async () => ({ ok: false, status: 500, code: null, message: "down" })) as never;
  await assert.rejects(run(h, ev("customer.subscription.updated", sub())));
  assert.deepEqual(h.log, ["record", "unrecord"]);
});

test("invoice.payment_failed notifies with the customer id, no billing write", async () => {
  const h = harness();
  assert.deepEqual(await run(h, ev("invoice.payment_failed", { customer: "cus_9" })), { kind: "handled", type: "invoice.payment_failed" });
  assert.match(h.notes[0], /cus_9/);
  assert.equal(h.nums.writes.length, 0);
});

test("other event types (trial_will_end included) are ignored", async () => {
  for (const type of ["customer.subscription.trial_will_end", "invoice.paid", "charge.refunded"]) {
    const h = harness();
    assert.deepEqual(await run(h, ev(type, sub())), { kind: "ignored", type });
    assert.equal(h.nums.writes.length, 0);
  }
});
