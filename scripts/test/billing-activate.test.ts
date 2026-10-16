import test from "node:test";
import assert from "node:assert/strict";

import { ActivationCapError } from "@/lib/billing/activation";
import { activateLocation, deactivateLocation, type ActivateDeps, type ActivateRepo } from "@/lib/billing/activate";
import { parseSubscription } from "@/lib/stripe/billing";
import type { Account, BillingStatus, GhlAccount } from "@/lib/types";

function account(over: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "A",
    kind: "direct",
    ownerEmail: "o@x.co",
    stripeCustomerId: "cus",
    stripeSubscriptionId: "sub",
    billingStatus: "active",
    trialEndsAt: null,
    cancelledAt: null,
    cleanedUpAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Account;
}

function harness(
  opts: {
    liveQty?: number;
    status?: BillingStatus;
    active?: number;
    all?: number;
    cap?: number | null;
    owner?: string | null;
    activatedAt?: string | null;
    stripeFails?: boolean;
    dbFails?: boolean;
    noSub?: boolean;
    matched?: number;
  } = {},
) {
  const log: string[] = [];
  const notes: string[] = [];
  const location = { locationId: "loc-1", accountId: opts.owner === undefined ? "acc-1" : opts.owner, activatedAt: opts.activatedAt ?? null } as GhlAccount;
  const acct = account({ billingStatus: opts.status ?? "active", stripeSubscriptionId: opts.noSub ? null : "sub" });
  const repo: ActivateRepo = {
    getGhlAccountByLocationId: async () => location,
    getAccountById: async () => acct,
    countActivatedForAccount: async () => opts.active ?? 0,
    countActivatedAll: async () => opts.all ?? opts.active ?? 0,
    setGhlActivated: async (loc, at) => {
      log.push(`db:${loc}:${at}`);
      if (opts.dbFails && at !== null) throw new Error("db down");
      if (at === null) opts.active = Math.max(0, (opts.active ?? 0) - 1);
      else if (opts.matched === 0) return 0;
      else opts.active = (opts.active ?? 0) + 1;
      return 1;
    },
  };
  const deps: ActivateDeps = {
    retrieveSubscription: (async () => {
      log.push("retrieve");
      return opts.stripeFails
        ? { ok: false, status: 500, code: null, message: "boom" }
        : { ok: true, data: parseSubscription({ id: "sub", status: "active", customer: "cus", items: { data: [{ id: "si_1", quantity: opts.liveQty ?? 1 }] } })! };
    }) as never,
    setQuantity: (async (item: string, q: number) => {
      log.push(`qty:${item}:${q}`);
      return opts.stripeFails ? { ok: false, status: 500, code: null, message: "boom" } : { ok: true, data: { id: item, quantity: q } };
    }) as never,
    notify: (t) => notes.push(t),
    now: () => new Date("2026-10-16T10:00:00.000Z"),
    platformCap: () => (opts.cap === undefined ? null : opts.cap),
  };
  return { repo, deps, log, notes };
}

test("a trial account at the cap is refused before Stripe or the database is touched", async () => {
  const h = harness({ status: "trialing", active: 3 });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "trial_cap" });
  assert.deepEqual(h.log, []);
});

test("activation updates the Stripe quantity first, then writes activated_at", async () => {
  const h = harness({ active: 2 });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true });
  assert.deepEqual(h.log, ["retrieve", "qty:si_1:3", "db:loc-1:2026-10-16T10:00:00.000Z"]);
});

test("a Stripe failure writes nothing", async () => {
  const h = harness({ active: 2, stripeFails: true });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "stripe_failed" });
  assert.equal(h.log.some((l) => l.startsWith("db:")), false);
});

test("a database failure after Stripe re-syncs the quantity and rethrows", async () => {
  const h = harness({ active: 2, dbFails: true });
  await assert.rejects(() => activateLocation(h.repo, h.deps, "acc-1", "loc-1"), /db down/);
  assert.deepEqual(h.log.filter((l) => l.startsWith("qty:")), ["qty:si_1:3", "qty:si_1:2"]);
});

test("a comped account activates without calling Stripe", async () => {
  const h = harness({ status: "comped", active: 5 });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true });
  assert.deepEqual(h.log, ["db:loc-1:2026-10-16T10:00:00.000Z"]);
});

test("a billable account with no subscription is refused rather than activated unbilled", async () => {
  const h = harness({ noSub: true });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "stripe_failed" });
  assert.deepEqual(h.log, []);
});

test("a location owned by another account (or nobody) is not found", async () => {
  for (const owner of ["acc-2", null]) {
    const h = harness({ owner });
    assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "not_found" });
    assert.deepEqual(await deactivateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "not_found" });
    assert.deepEqual(h.log, []);
  }
});

test("the platform cap refuses when the platform is full", async () => {
  const h = harness({ active: 0, all: 2, cap: 2 });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "platform_cap" });
  assert.deepEqual(h.log, []);
});

test("an already active number is refused", async () => {
  const h = harness({ activatedAt: "2026-10-01T00:00:00.000Z", active: 1 });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "already_active" });
});

test("deactivation clears activated_at first, then syncs the quantity", async () => {
  const h = harness({ active: 2, liveQty: 2, activatedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(await deactivateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true, quantitySynced: true });
  assert.deepEqual(h.log, ["db:loc-1:null", "retrieve", "qty:si_1:1"]);
});

test("deactivation still succeeds when Stripe is down, and says so to Slack", async () => {
  const h = harness({ active: 2, stripeFails: true, activatedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(await deactivateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: true, quantitySynced: false });
  assert.equal(h.log[0], "db:loc-1:null");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /acc-1/);
});

test("a conditional write that matches nothing rolls Stripe back and reports already_active", async () => {
  const h = harness({ active: 2, matched: 0 });
  assert.deepEqual(await activateLocation(h.repo, h.deps, "acc-1", "loc-1"), { ok: false, reason: "already_active" });
  assert.deepEqual(h.log.filter((l) => l.startsWith("qty:")), ["qty:si_1:3", "qty:si_1:2"]);
});

test("second concurrent activation at the cap is refused and quantity ends at 3", async () => {
  // Both callers read 2 active, so both pass the app-side check; the database refuses the second write.
  let active = 2;
  let quantity = 1;
  const acct = account({ billingStatus: "trialing" });
  const repo: ActivateRepo = {
    getGhlAccountByLocationId: async (id: string) => ({ locationId: id, accountId: "acc-1", activatedAt: null }) as GhlAccount,
    getAccountById: async () => acct,
    countActivatedForAccount: async () => active,
    countActivatedAll: async () => active,
    setGhlActivated: async (_loc, at) => {
      await new Promise((r) => setImmediate(r));
      if (at !== null) {
        if (active >= 3) throw new ActivationCapError("trial_cap");
        active += 1;
      }
      return 1;
    },
  };
  const staleRead = { n: 0 };
  const realCount = repo.countActivatedForAccount;
  repo.countActivatedForAccount = async () => (staleRead.n++ < 2 ? 2 : realCount("acc-1"));
  repo.countActivatedAll = async () => 2;
  const deps: ActivateDeps = {
    retrieveSubscription: (async () => ({
      ok: true,
      data: parseSubscription({ id: "sub", status: "trialing", customer: "cus", items: { data: [{ id: "si_1", quantity: 2 }] } })!,
    })) as never,
    setQuantity: (async (_i: string, q: number) => {
      quantity = q;
      return { ok: true, data: { id: "si_1", quantity: q } };
    }) as never,
    notify: () => {},
    now: () => new Date("2026-10-16T10:00:00.000Z"),
    platformCap: () => null,
  };
  const results = await Promise.all([
    activateLocation(repo, deps, "acc-1", "loc-a"),
    activateLocation(repo, deps, "acc-1", "loc-b"),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.deepEqual(results.find((r) => !r.ok), { ok: false, reason: "trial_cap" });
  assert.equal(active, 3);
  assert.equal(quantity, 3);
});

test("a failed database write does not re-POST a quantity Stripe already holds", async () => {
  const h = harness({ active: 0, dbFails: true });
  await assert.rejects(activateLocation(h.repo, h.deps, "acc-1", "loc-1"));
  // raised to 1, then the true count (0) differs, so exactly one restore is written
  assert.deepEqual(h.log.filter((l) => l.startsWith("qty:")), ["qty:si_1:1", "qty:si_1:0"]);
});

test("re-sync is skipped when the true count equals what was just written", async () => {
  const h = harness({ active: 0, matched: 0 });
  let reads = 0;
  h.repo.countActivatedForAccount = async () => (reads++ === 0 ? 0 : 1);
  await activateLocation(h.repo, h.deps, "acc-1", "loc-1");
  assert.deepEqual(h.log.filter((l) => l.startsWith("qty:")), ["qty:si_1:1"]);
});
