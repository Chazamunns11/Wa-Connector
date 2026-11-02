/**
 * Per-number billing, "charge before adding" (src/lib/billing/quantity.ts,
 * chargeForNewNumber): a new number is paid for at once (Stripe
 * always_invoice + error_if_incomplete), and a declined card means the
 * number is not added. Nothing to charge must never block an add.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chargeForNewNumber, type ChargeRepo } from "@/lib/billing/quantity";
import { parseSubscription } from "@/lib/stripe/billing";

type Opts = { activated?: boolean; numbersHere?: number; otherActive?: number; status?: string; noSub?: boolean; decline?: boolean; stripeDown?: boolean };

function harness(o: Opts = {}) {
  const sets: { item: string; q: number; refuse: boolean }[] = [];
  const repo = {
    getGhlAccountByLocationId: async () => ({ locationId: "loc-1", accountId: "acc-1", activatedAt: o.activated === false ? null : "2026-10-01T00:00:00Z" }),
    getAccountById: async () => ({ id: "acc-1", billingStatus: o.status ?? "active", stripeSubscriptionId: o.noSub ? null : "sub_1" }),
    listGhlAccountsForAccount: async () => [
      { locationId: "loc-1", activatedAt: o.activated === false ? null : "2026-10-01T00:00:00Z" },
      ...Array.from({ length: o.otherActive ?? 0 }, (_, i) => ({ locationId: `other-${i}`, activatedAt: "2026-10-01T00:00:00Z" })),
    ],
    countNumbersByLocation: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === "loc-1" ? (o.numbersHere ?? 1) : 1])),
  } as unknown as ChargeRepo;
  const deps = {
    retrieveSubscription: (async () =>
      o.stripeDown
        ? { ok: false, status: 500, code: null, message: "down" }
        : { ok: true, data: parseSubscription({ id: "sub_1", status: "active", customer: "cus", items: { data: [{ id: "si_1", quantity: 1 }] } })! }) as never,
    setQuantity: (async (item: string, q: number, _d: unknown, opts?: { refuseIfUnpaid?: boolean }) => {
      sets.push({ item, q, refuse: opts?.refuseIfUnpaid === true });
      return o.decline ? { ok: false, status: 402, code: "card_declined", message: "Your card was declined." } : { ok: true, data: { id: item, quantity: q } };
    }) as never,
  };
  return { repo, deps, sets };
}

test("a new number is charged now: Stripe goes up by one, payment required", async () => {
  const h = harness({ numbersHere: 1, otherActive: 2 });
  assert.deepEqual(await chargeForNewNumber(h.repo, h.deps, "loc-1"), { ok: true, charged: true });
  assert.deepEqual(h.sets, [{ item: "si_1", q: 4, refuse: true }]);
});

test("a declined card: refused as 'declined', so the caller does not add the number", async () => {
  const h = harness({ decline: true });
  assert.deepEqual(await chargeForNewNumber(h.repo, h.deps, "loc-1"), { ok: false, reason: "declined" });
});

test("Stripe unreachable: refused as stripe_failed, never a free number", async () => {
  const h = harness({ stripeDown: true });
  assert.deepEqual(await chargeForNewNumber(h.repo, h.deps, "loc-1"), { ok: false, reason: "stripe_failed" });
  assert.equal(h.sets.length, 0);
});

test("nothing to charge never blocks: comped, no subscription, inactive sub-account, or already at 3 numbers", async () => {
  for (const o of [{ status: "comped" }, { noSub: true }, { activated: false }, { numbersHere: 3 }] as Opts[]) {
    const h = harness(o);
    assert.deepEqual(await chargeForNewNumber(h.repo, h.deps, "loc-1"), { ok: true, charged: false }, JSON.stringify(o));
    assert.equal(h.sets.length, 0, JSON.stringify(o));
  }
});
