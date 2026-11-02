import test from "node:test";
import assert from "node:assert/strict";

import { ActivationCapError } from "@/lib/billing/activation";
import { activateLocation, deactivateLocation, type ActivateDeps, type ActivateRepo } from "@/lib/billing/activate";
import type { Account, BillingStatus, GhlAccount, NumberBilling } from "@/lib/types";
import { account, fakeStripe, number, numbersRepo } from "./billing-fakes";

function harness(
  opts: {
    status?: BillingStatus;
    customer?: string | null;
    owner?: string | null;
    activatedAt?: string | null;
    numbers?: NumberBilling[];
    all?: number;
    cap?: number | null;
    failOn?: string[];
    failCreateAfter?: number;
    dbFails?: boolean;
    matched?: number;
  } = {},
) {
  const log: string[] = [];
  const location = { locationId: "loc-1", accountId: opts.owner === undefined ? "acc-1" : opts.owner, activatedAt: opts.activatedAt ?? null } as GhlAccount;
  const acct: Account = account({ billingStatus: opts.status ?? "active", stripeCustomerId: opts.customer === undefined ? "cus" : opts.customer });
  const nums = numbersRepo(opts.numbers ?? [number("t1"), number("t2"), number("other", { locationId: "loc-2" })]);
  const stripe = fakeStripe({ failOn: opts.failOn, failCreateAfter: opts.failCreateAfter });
  const repo: ActivateRepo = {
    getGhlAccountByLocationId: async () => location,
    getAccountById: async () => acct,
    countActivatedAll: async () => opts.all ?? 0,
    setGhlActivated: async (loc, at) => {
      log.push(`db:${loc}:${at}`);
      if (opts.dbFails && at !== null) throw new Error("db down");
      if (at !== null && opts.matched === 0) return 0;
      if (at !== null && opts.cap !== undefined && opts.cap !== null && (opts.all ?? 0) >= opts.cap) throw new ActivationCapError("platform_cap");
      return 1;
    },
    listNumberBillingForAccount: nums.listNumberBillingForAccount,
    updateNumberBilling: nums.updateNumberBilling,
    claimNumberTrial: nums.claimNumberTrial,
    releaseNumberTrial: nums.releaseNumberTrial,
  };
  const deps: ActivateDeps = {
    ...stripe.deps,
    now: () => new Date("2026-10-16T10:00:00.000Z"),
    platformCap: () => (opts.cap === undefined ? null : opts.cap),
  };
  return { repo, deps, log, nums, stripe };
}

test("activation writes activated_at, then starts one trialing subscription per number of THAT location only", async () => {
  const h = harness();
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true });
  assert.deepEqual(h.log, ["db:loc-1:2026-10-16T10:00:00.000Z"]);
  assert.deepEqual(h.stripe.log.filter((l) => l.startsWith("create")), ["create:t1:999:trial", "create:t2:999:trial"]);
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "trialing");
  assert.equal(h.nums.rows.get("t2")!.billingStatus, "trialing");
  assert.equal(h.nums.rows.get("other")!.stripeSubscriptionId, null);
});

test("an account with no card on file is refused before Stripe or the database is touched", async () => {
  for (const status of ["pending", "trialing", "paused", "cancelled"] as const) {
    const h = harness({ status });
    assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "billing_inactive" }, status);
    assert.deepEqual(h.log, []);
    assert.deepEqual(h.stripe.log, []);
  }
});

test("a comped account activates with no Stripe call", async () => {
  const h = harness({ status: "comped", customer: null });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true });
  assert.equal(h.log.length, 1);
  assert.deepEqual(h.stripe.log, []);
});

test("a card-on-file account with no Stripe customer is refused rather than activated unbilled", async () => {
  const h = harness({ customer: null });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "stripe_failed" });
  assert.deepEqual(h.log, []);
});

test("a Stripe failure part-way cancels what this activation created and undoes the activation", async () => {
  const h = harness({ failCreateAfter: 1 });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "stripe_failed" });
  assert.deepEqual(h.log, ["db:loc-1:2026-10-16T10:00:00.000Z", "db:loc-1:null"]);
  const first = h.nums.rows.get("t1")!;
  assert.equal(first.billingStatus, "cancelled");
  assert.ok(h.stripe.log.includes(`cancel:${first.stripeSubscriptionId}`));
  assert.equal(h.nums.rows.get("t2")!.stripeSubscriptionId, null);
});

test("a database failure on the activation write rethrows and touches no Stripe", async () => {
  const h = harness({ dbFails: true });
  await assert.rejects(activateLocation(h.repo, h.deps, "acc-1", "loc-1"), /db down/);
  assert.deepEqual(h.stripe.log, []);
});

test("platform cap: refused by the app check, or by the database race backstop", async () => {
  const pre = harness({ cap: 5, all: 5 });
  assert.deepEqual(await activateLocation(pre.repo, pre.deps, "acc-1", "loc-1"), { ok: false, reason: "platform_cap" });
  assert.deepEqual(pre.log, []);
  const race = harness({ cap: 5, all: 4 });
  race.repo.countActivatedAll = async () => 4;
  race.repo.setGhlActivated = async () => {
    throw new ActivationCapError("platform_cap");
  };
  assert.deepEqual(await activateLocation(race.repo, race.deps, "acc-1", "loc-1"), { ok: false, reason: "platform_cap" });
  assert.deepEqual(race.stripe.log, []);
});

test("already active (read or conditional write) is refused with no Stripe call", async () => {
  const read = harness({ activatedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(await activateLocation(read.repo, read.deps, "acc-1", "loc-1"), { ok: false, reason: "already_active" });
  const write = harness({ matched: 0 });
  assert.deepEqual(await activateLocation(write.repo, write.deps, "acc-1", "loc-1"), { ok: false, reason: "already_active" });
  assert.deepEqual(write.stripe.log, []);
});

test("another account's location, or a missing account, is not_found for both actions", async () => {
  for (const owner of ["acc-2", null]) {
    const h = harness({ owner });
    assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "not_found" });
    assert.deepEqual(await deactivateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "not_found" });
    assert.deepEqual(h.log, []);
  }
});

test("re-activating a location whose numbers were billed before restarts them with no trial", async () => {
  const h = harness({ numbers: [number("t1", { stripeSubscriptionId: "sub_old", billingStatus: "cancelled" })] });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true });
  assert.deepEqual(h.stripe.log.filter((l) => l.startsWith("create")), ["create:t1:999:now"]);
});

test("activation that takes the account to 11 numbers prices only the new one at £7.99; the first 10 keep £9.99", async () => {
  const h = harness({ numbers: [number("new", { locationId: "loc-1", createdAt: "2026-10-20T00:00:00.000Z" })] });
  for (let i = 0; i < 10; i++) {
    const r = await h.stripe.deps.createSubscription({ customerId: "cus", accountId: "acc-1", locationId: "loc-9", tenantId: `b${i}`, unitAmountPence: 999, trial: true });
    if (!r.ok) throw new Error("setup");
    h.nums.rows.set(`b${i}`, number(`b${i}`, { locationId: "loc-9", stripeSubscriptionId: r.data.id, billingStatus: "active", pricePence: 999 }));
  }
  h.stripe.log.length = 0;
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true });
  assert.deepEqual(h.stripe.log.filter((l) => l.startsWith("create")), ["create:new:799:trial"]);
  assert.equal(h.stripe.log.filter((l) => l.startsWith("price:")).length, 0);
  assert.equal(h.nums.rows.get("new")!.pricePence, 799);
});

test("deactivation clears activated_at first, then cancels that location's numbers now", async () => {
  const h = harness({
    numbers: [
      number("t1", { stripeSubscriptionId: "sub_a", billingStatus: "trialing" }),
      number("other", { locationId: "loc-2", stripeSubscriptionId: "sub_b", billingStatus: "active", pricePence: 999 }),
    ],
  });
  h.stripe.subs.set("sub_a", { status: "trialing", unitAmount: 999, metadata: {}, trial: true });
  h.stripe.subs.set("sub_b", { status: "active", unitAmount: 999, metadata: {}, trial: true });
  assert.deepEqual(await deactivateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true, billingSynced: true });
  assert.deepEqual(h.log, ["db:loc-1:null"]);
  assert.deepEqual(h.stripe.log, ["cancel:sub_a"]);
  assert.equal(h.nums.rows.get("t1")!.billingStatus, "cancelled");
  assert.equal(h.nums.rows.get("other")!.billingStatus, "active");
});

test("deactivation still succeeds when Stripe is down, and says billing is not synced", async () => {
  const h = harness({ failOn: ["cancel"], numbers: [number("t1", { stripeSubscriptionId: "sub_a", billingStatus: "active", pricePence: 999 })] });
  assert.deepEqual(await deactivateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true, billingSynced: false });
  assert.deepEqual(h.log, ["db:loc-1:null"]);
  assert.equal(h.stripe.notes.length, 1);
});
