import test from "node:test";
import assert from "node:assert/strict";

import { payWhatsDue, type ReactivateDeps } from "@/lib/billing/reactivate";

function harness(status: string, opts: { latestInvoice?: string | null; decline?: boolean } = {}) {
  const log: string[] = [];
  const live = { status, latestInvoice: opts.latestInvoice === undefined ? "in_1" : opts.latestInvoice };
  const deps: ReactivateDeps = {
    retrieveSubscription: (async () => {
      log.push(`live:${live.status}`);
      return { ok: true, data: { ...live } };
    }) as never,
    settleInvoice: (async (id: string, o: { paymentMethod?: string }) => {
      log.push(`settle:${id}:${o.paymentMethod ?? ""}`);
      if (opts.decline) return { ok: false, status: 402, code: "card_declined", message: "declined" };
      live.status = "active";
      return { ok: true, data: { id, status: "paid" } };
    }) as never,
  };
  const writes: unknown[] = [];
  const repo = {
    updateAccountBilling: async (id: string, patch: unknown) => {
      writes.push({ id, patch });
    },
  };
  return { log, deps, repo, writes };
}

const acct = { id: "acc-1", stripeSubscriptionId: "sub" };

test("unpaid: pays the latest invoice with the new card and switches the account back on at once", async () => {
  const h = harness("unpaid");
  assert.equal(await payWhatsDue(h.repo, h.deps, acct, "pm_1"), "paid");
  assert.deepEqual(h.log, ["live:unpaid", "settle:in_1:pm_1", "live:active"]);
  assert.deepEqual(h.writes, [{ id: "acc-1", patch: { billingStatus: "active" } }]);
});

test("a decline leaves the account as it was", async () => {
  const h = harness("unpaid", { decline: true });
  assert.equal(await payWhatsDue(h.repo, h.deps, acct, "pm_1"), "payment_failed");
  assert.deepEqual(h.writes, []);
});

test("nothing is charged when nothing is owed", async () => {
  for (const s of ["active", "trialing", "paused", "canceled"]) {
    const h = harness(s);
    assert.equal(await payWhatsDue(h.repo, h.deps, acct, "pm_1"), "nothing_due", s);
    assert.ok(!h.log.some((l) => l.startsWith("settle")), s);
  }
  const noInvoice = harness("unpaid", { latestInvoice: null });
  assert.equal(await payWhatsDue(noInvoice.repo, noInvoice.deps, acct), "nothing_due");
  assert.equal(await payWhatsDue(noInvoice.repo, noInvoice.deps, { id: "x", stripeSubscriptionId: null }), "nothing_due");
});
