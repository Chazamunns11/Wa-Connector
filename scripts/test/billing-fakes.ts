/** Shared in-memory fakes for the per-number billing tests (not a test file itself). */
import { parseSubscription, type StripeSubscription } from "@/lib/stripe/billing";
import type { NumberBillingDeps } from "@/lib/billing/numbers";
import type { Account, NumberBilling } from "@/lib/types";

export function account(over: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "A",
    kind: "agency",
    ownerEmail: "o@x.co",
    stripeCustomerId: "cus",
    stripeSubscriptionId: null,
    billingStatus: "active",
    trialEndsAt: null,
    cancelledAt: null,
    cleanedUpAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

export function number(tenantId: string, over: Partial<NumberBilling> = {}): NumberBilling {
  return { tenantId, locationId: "loc-1", stripeSubscriptionId: null, billingStatus: null, trialEndsAt: null, pricePence: null, ...over };
}

/** Numbers by tenant id, with the repo methods per-number billing reads and writes. */
export function numbersRepo(initial: NumberBilling[]) {
  const rows = new Map(initial.map((n) => [n.tenantId, { ...n }]));
  const writes: Array<{ tenantId: string; patch: Partial<NumberBilling> }> = [];
  return {
    rows,
    writes,
    listNumberBillingForAccount: async () => [...rows.values()].map((n) => ({ ...n })),
    getNumberBilling: async (tenantId: string) => {
      const n = rows.get(tenantId);
      return n ? { ...n } : null;
    },
    updateNumberBilling: async (tenantId: string, patch: Partial<NumberBilling>) => {
      writes.push({ tenantId, patch });
      const n = rows.get(tenantId);
      if (n) rows.set(tenantId, { ...n, ...patch });
    },
  };
}

const fail = { ok: false as const, status: 500, code: null, message: "boom" };

/** A fake Stripe holding subscriptions by id. `failOn` names calls that fail ("create", "price", "cancel", "retrieve"). */
export function fakeStripe(opts: { failOn?: string[]; failCreateAfter?: number } = {}) {
  const subs = new Map<string, { status: string; unitAmount: number; metadata: Record<string, string>; trial: boolean }>();
  const log: string[] = [];
  const notes: string[] = [];
  let created = 0;
  const sub = (id: string): StripeSubscription => {
    const s = subs.get(id)!;
    return parseSubscription({
      id,
      status: s.status,
      customer: "cus",
      trial_end: s.status === "trialing" ? 1_800_000_000 : null,
      metadata: s.metadata,
      items: { data: [{ id: `si_${id}`, quantity: 1, price: { unit_amount: s.unitAmount } }] },
    })!;
  };
  const deps: NumberBillingDeps = {
    createSubscription: async (input) => {
      log.push(`create:${input.tenantId}:${input.unitAmountPence}:${input.trial ? "trial" : "now"}`);
      if (opts.failOn?.includes("create") || (opts.failCreateAfter !== undefined && created >= opts.failCreateAfter)) return fail;
      created += 1;
      const id = `sub_${input.tenantId}_${created}`;
      subs.set(id, {
        status: input.trial ? "trialing" : "active",
        unitAmount: input.unitAmountPence,
        metadata: { account_id: input.accountId, location_id: input.locationId, tenant_id: input.tenantId },
        trial: input.trial,
      });
      return { ok: true, data: sub(id) };
    },
    retrieveSubscription: async (id) => {
      log.push(`retrieve:${id}`);
      if (opts.failOn?.includes("retrieve") || !subs.has(id)) return fail;
      return { ok: true, data: sub(id) };
    },
    setPrice: async (itemId, pence) => {
      log.push(`price:${itemId}:${pence}`);
      if (opts.failOn?.includes("price")) return fail;
      const id = itemId.replace(/^si_/, "");
      const s = subs.get(id);
      if (s) s.unitAmount = pence;
      return { ok: true, data: { id: itemId } };
    },
    cancel: async (id) => {
      log.push(`cancel:${id}`);
      if (opts.failOn?.includes("cancel")) return fail;
      const s = subs.get(id);
      if (!s) return { ok: false, status: 404, code: "resource_missing", message: "No such subscription" };
      s.status = "canceled";
      return { ok: true, data: sub(id) };
    },
    notify: (t) => notes.push(t),
  };
  return { deps, subs, log, notes };
}
