import test from "node:test";
import assert from "node:assert/strict";

import { handleBillingEvent, type WebhookDeps, type WebhookRepo } from "@/lib/billing/webhook-handler";
import { syncSubscriptionQuantity, type QuantityDeps } from "@/lib/billing/quantity";
import type { Account } from "@/lib/types";
import { parseSubscription, type StripeCheckoutSession, type StripeSubscription } from "@/lib/stripe/billing";

function account(over: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "A",
    kind: "direct",
    ownerEmail: "o@x.co",
    stripeCustomerId: "cus",
    stripeSubscriptionId: "sub",
    billingStatus: "trialing",
    trialEndsAt: null,
    cancelledAt: null,
    cleanedUpAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Account;
}

function harness(opts: { fresh?: boolean; byId?: Account | null; byCustomer?: Account | null } = {}) {
  const log: string[] = [];
  const patches: Array<{ id: string; patch: unknown }> = [];
  const notes: string[] = [];
  const state: { body: Record<string, unknown>; live: Record<string, unknown> | null } = { body: {}, live: null };
  const repo: WebhookRepo = {
    deleteStripeEvent: async () => {
      log.push("unrecord");
    },
    recordStripeEvent: async () => {
      log.push("record");
      return opts.fresh ?? true;
    },
    getAccountById: async () => (opts.byId === undefined ? account() : opts.byId),
    getAccountByStripeCustomerId: async () => (opts.byCustomer === undefined ? null : opts.byCustomer),
    updateAccountBilling: async (id, patch) => {
      patches.push({ id, patch });
    },
  };
  const session = { id: "cs_1", status: "complete", customer: "cus", subscription: null, metadata: { account_id: "acc-1" } } as StripeCheckoutSession;
  const deps: WebhookDeps = {
    applyCheckout: async () => {
      log.push("apply");
      return { applied: true };
    },
    retrieveCheckoutSession: (async (id: string) => {
      log.push(`retrieve:${id}`);
      return { ok: true, data: session };
    }) as never,
    retrieveSubscription: (async (id: string) => {
      log.push(`live:${id}`);
      const raw = { ...(state.live ?? state.body), items: { data: [] } };
      const data = parseSubscription(raw);
      return data ? { ok: true, data } : { ok: false, status: 500, code: null, message: "bad" };
    }) as never,
    syncQuantity: async () => {
      log.push("sync");
    },
    notify: (t) => {
      notes.push(t);
    },
  };
  return { repo, deps, log, patches, notes, state };
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
  metadata: { account_id: "acc-1" },
  ...over,
});

test("duplicate event id does nothing else", async () => {
  const h = harness({ fresh: false });
  const out = await run(h, { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1" } } });
  assert.deepEqual(out, { kind: "duplicate" });
  assert.deepEqual(h.log, ["record"]);
});

test("checkout.session.completed retrieves fresh, applies, syncs quantity", async () => {
  const h = harness();
  const out = await run(h, {
    id: "evt_2",
    type: "checkout.session.completed",
    data: { object: { id: "cs_1", subscription: "ignored-body-value" } },
  });
  assert.deepEqual(out, { kind: "handled", type: "checkout.session.completed" });
  assert.deepEqual(h.log, ["record", "retrieve:cs_1", "apply", "sync"]);
});

test("subscription.updated past_due writes the mapped status", async () => {
  const h = harness();
  const out = await run(h, {
    id: "evt_3",
    type: "customer.subscription.updated",
    data: { object: sub({ status: "past_due" }) },
  });
  assert.equal(out.kind, "handled");
  assert.deepEqual(h.patches, [
    { id: "acc-1", patch: { billingStatus: "past_due", trialEndsAt: null, cancelledAt: null, cleanedUpAt: null, stripeSubscriptionId: "sub" } },
  ]);
});

test("subscription.deleted writes cancelled with cancelledAt", async () => {
  const h = harness();
  await run(h, {
    id: "evt_4",
    type: "customer.subscription.deleted",
    data: { object: sub({ status: "canceled", canceled_at: 1_700_000_000, ended_at: 1_800_000_000 }) },
  });
  assert.deepEqual(h.patches[0].patch, {
    billingStatus: "cancelled",
    trialEndsAt: null,
    cancelledAt: "2027-01-15T08:00:00.000Z",
    stripeSubscriptionId: "sub",
  });
});

test("cancel-at-period-end: cancelledAt is ended_at, not the request date", async () => {
  const h = harness();
  h.state.live = sub({ status: "canceled", canceled_at: 1_800_000_000 - 30 * 86400, ended_at: 1_800_000_000 });
  await run(h, { id: "evt_e", type: "customer.subscription.deleted", data: { object: sub({ status: "canceled" }) } });
  assert.equal((h.patches[0].patch as { cancelledAt: string }).cancelledAt, "2027-01-15T08:00:00.000Z");
});

test("reactivation clears cancelledAt and cleanedUpAt", async () => {
  const h = harness({ byId: account({ billingStatus: "cancelled", cancelledAt: "2026-01-01T00:00:00.000Z", cleanedUpAt: "2026-02-01T00:00:00.000Z" }) });
  await run(h, { id: "evt_r", type: "customer.subscription.updated", data: { object: sub({ status: "active" }) } });
  assert.deepEqual(h.patches[0].patch, {
    billingStatus: "active",
    trialEndsAt: null,
    cancelledAt: null,
    cleanedUpAt: null,
    stripeSubscriptionId: "sub",
  });
});

test("trialing carries trialEndsAt", async () => {
  const h = harness();
  await run(h, {
    id: "evt_t",
    type: "customer.subscription.updated",
    data: { object: sub({ status: "trialing", trial_end: 1_800_000_000 }) },
  });
  assert.equal((h.patches[0].patch as { trialEndsAt: string }).trialEndsAt, "2027-01-15T08:00:00.000Z");
});

test("no metadata falls back to customer lookup", async () => {
  const h = harness({ byCustomer: account({ id: "acc-9" }) });
  const out = await run(h, {
    id: "evt_5",
    type: "customer.subscription.updated",
    data: { object: sub({ metadata: {} }) },
  });
  assert.equal(out.kind, "handled");
  assert.equal(h.patches[0].id, "acc-9");
});

test("unknown account notifies once and reports unknown_account", async () => {
  const h = harness({ byCustomer: null });
  const out = await run(h, {
    id: "evt_6",
    type: "customer.subscription.updated",
    data: { object: sub({ metadata: {} }) },
  });
  assert.deepEqual(out, { kind: "unknown_account", type: "customer.subscription.updated" });
  assert.equal(h.notes.length, 1);
  assert.equal(h.patches.length, 0);
});

test("a failing handler releases the event id so Stripe's retry is processed", async () => {
  const h = harness();
  let fail = true;
  const original = h.deps.applyCheckout;
  h.deps.applyCheckout = async (s) => {
    if (fail) throw new Error("db down");
    return original(s);
  };
  const seen = new Set<string>();
  h.repo.recordStripeEvent = async (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
  h.repo.deleteStripeEvent = async (id) => {
    seen.delete(id);
    h.log.push("unrecord");
  };
  const ev = { id: "evt_r", type: "checkout.session.completed", data: { object: { id: "cs_1" } } };
  await assert.rejects(run(h, ev), /db down/);
  assert.ok(h.log.includes("unrecord"));
  fail = false;
  const out = await run(h, ev);
  assert.deepEqual(out, { kind: "handled", type: "checkout.session.completed" });
});

test("a stale updated(active) after deleted(canceled) leaves the account cancelled", async () => {
  const h = harness();
  h.state.live = { ...sub({ status: "canceled", canceled_at: 1_800_000_000 }) };
  await run(h, { id: "evt_s1", type: "customer.subscription.updated", data: { object: sub({ status: "active" }) } });
  assert.equal((h.patches[0].patch as { billingStatus: string }).billingStatus, "cancelled");
  assert.ok(h.log.includes("live:sub"));
});

test("events for a different subscription than the account's are ignored", async () => {
  const h = harness();
  const out = await run(h, { id: "evt_o", type: "customer.subscription.updated", data: { object: sub({ id: "sub_old", status: "canceled" }) } });
  assert.deepEqual(out, { kind: "ignored", type: "customer.subscription.updated" });
  assert.equal(h.patches.length, 0);
});

test("incomplete status leaves billing untouched", async () => {
  const h = harness();
  const out = await run(h, {
    id: "evt_7",
    type: "customer.subscription.updated",
    data: { object: sub({ status: "incomplete" }) },
  });
  assert.equal(out.kind, "handled");
  assert.equal(h.patches.length, 0);
});

test("invoice.payment_failed notifies with the customer id, no billing write", async () => {
  const h = harness();
  const out = await run(h, {
    id: "evt_8",
    type: "invoice.payment_failed",
    data: { object: { customer: "cus_42" } },
  });
  assert.equal(out.kind, "handled");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /cus_42/);
  assert.equal(h.patches.length, 0);
});

test("other event types are ignored", async () => {
  const h = harness();
  const out = await run(h, { id: "evt_9", type: "customer.created", data: { object: {} } });
  assert.deepEqual(out, { kind: "ignored", type: "customer.created" });
});

function qdeps(over: Partial<QuantityDeps> = {}) {
  const sets: Array<[string, number]> = [];
  const notes: string[] = [];
  const subscription = { id: "sub", itemId: "si_1", quantity: 0 } as StripeSubscription;
  const deps: QuantityDeps = {
    retrieveSubscription: (async () => ({ ok: true, data: subscription })) as never,
    setQuantity: (async (item: string, q: number) => {
      sets.push([item, q]);
      return { ok: true, data: { id: item, quantity: q } };
    }) as never,
    notify: (t) => {
      notes.push(t);
    },
    ...over,
  };
  return { deps, sets, notes };
}
const qrepo = (n: number) => ({ countActivatedForAccount: async () => n });

test("quantity sync: comped and missing subscription are no_subscription", async () => {
  const { deps } = qdeps();
  assert.deepEqual(await syncSubscriptionQuantity(qrepo(1), deps, account({ billingStatus: "comped" })), { ok: false, reason: "no_subscription" });
  assert.deepEqual(await syncSubscriptionQuantity(qrepo(1), deps, account({ stripeSubscriptionId: null })), { ok: false, reason: "no_subscription" });
});

test("quantity sync sets the activated count", async () => {
  const { deps, sets } = qdeps();
  assert.deepEqual(await syncSubscriptionQuantity(qrepo(2), deps, account()), { ok: true, quantity: 2 });
  assert.deepEqual(sets, [["si_1", 2]]);
});

test("quantity sync: Stripe failure notifies", async () => {
  const { deps, notes } = qdeps({
    setQuantity: (async () => ({ ok: false, status: 500, code: null, message: "boom" })) as never,
  });
  assert.deepEqual(await syncSubscriptionQuantity(qrepo(2), deps, account()), { ok: false, reason: "stripe_failed" });
  assert.deepEqual(notes, ["Billing quantity sync failed for account acc-1: boom"]);
});
