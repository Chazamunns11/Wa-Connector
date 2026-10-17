import test from "node:test";
import assert from "node:assert/strict";

import { CANCELLED_CLEANUP_AFTER_MS, purgeCancelledAccounts, type CleanupRepo } from "@/lib/billing/cleanup";
import type { Account, GhlAccountSummary } from "@/lib/types";

const NOW = new Date("2026-10-30T12:00:00.000Z");

function acct(id: string): Account {
  return {
    id,
    name: id,
    kind: "business",
    ownerEmail: `${id}@x.co`,
    stripeCustomerId: "cus_secret",
    stripeSubscriptionId: "sub_secret",
    billingStatus: "cancelled",
    trialEndsAt: null,
    cancelledAt: "2026-10-01T00:00:00.000Z",
    cleanedUpAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function loc(locationId: string): GhlAccountSummary {
  return { locationId, tenantId: `t-${locationId}` } as GhlAccountSummary;
}

function harness(accounts: Account[], locs: Record<string, string[]>, extraNumbers: Record<string, string[]> = {}) {
  const cutoffs: string[] = [];
  const activated: Array<[string, string | null]> = [];
  const billing: Array<[string, unknown]> = [];
  const repo: CleanupRepo = {
    listAccountsCancelledBefore: async (iso) => {
      cutoffs.push(iso);
      return accounts;
    },
    listGhlAccountsForAccount: async (id) => (locs[id] ?? []).map(loc),
    setGhlActivated: async (l, v) => {
      activated.push([l, v]);
    },
    updateAccountBilling: async (id, patch) => {
      billing.push([id, patch]);
    },
    // Multiple numbers (merge): slot 1 is the location's own tenant; extra
    // numbers are seeded per location.
    listLocationNumbers: async (locationId) => [
      { tenantId: `t-${locationId}`, slot: 1, isDefault: true, label: null },
      ...(extraNumbers[locationId] ?? []).map((tenantId, i) => ({ tenantId, slot: (i + 2) as 2 | 3, isDefault: false, label: null })),
    ],
  };
  return { repo, cutoffs, activated, billing };
}

test("cleans every location, marks only fully-clean accounts, counts failures", async () => {
  const h = harness([acct("a"), acct("b")], { a: ["l1"], b: ["l2", "l3"] });
  const logged: string[] = [];
  const result = await purgeCancelledAccounts(h.repo, {
    now: () => NOW,
    logout: async (tenantId) => {
      logged.push(tenantId);
      return tenantId === "t-l3" ? { ok: false, error: "bridge down" } as never : { ok: true };
    },
  });
  assert.deepEqual(result, { accounts: 2, locations: 3, failures: 1 });
  assert.equal(h.cutoffs[0], new Date(NOW.getTime() - CANCELLED_CLEANUP_AFTER_MS).toISOString());
  assert.equal(CANCELLED_CLEANUP_AFTER_MS, 14 * 24 * 60 * 60 * 1000);
  assert.deepEqual(h.billing, [["a", { cleanedUpAt: NOW.toISOString() }]]);
  assert.ok(h.activated.some(([l, v]) => l === "l1" && v === null));
  assert.ok(h.activated.some(([l, v]) => l === "l2" && v === null));
  assert.deepEqual(logged.sort(), ["t-l1", "t-l2", "t-l3"]);
});

test("a throwing logout counts as a failure and never marks the account clean", async () => {
  const h = harness([acct("a")], { a: ["l1"] });
  const result = await purgeCancelledAccounts(h.repo, {
    now: () => NOW,
    logout: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(result, { accounts: 1, locations: 1, failures: 1 });
  assert.deepEqual(h.billing, []);
});

test("an account with no locations is marked clean; empty list gives zeros", async () => {
  const h = harness([acct("a")], {});
  const logout = async () => ({ ok: true }) as const;
  assert.deepEqual(await purgeCancelledAccounts(h.repo, { now: () => NOW, logout }), { accounts: 1, locations: 0, failures: 0 });
  assert.equal(h.billing.length, 1);
  const e = harness([], {});
  assert.deepEqual(await purgeCancelledAccounts(e.repo, { now: () => NOW, logout }), { accounts: 0, locations: 0, failures: 0 });
});

test("is idempotent and logs no secrets", async () => {
  const lines: string[] = [];
  const orig = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const h = harness([acct("a")], { a: ["l1"] });
    const deps = { now: () => NOW, logout: async () => ({ ok: false, error: "tok_secret" }) as never };
    await purgeCancelledAccounts(h.repo, deps);
    await purgeCancelledAccounts(h.repo, deps);
    assert.equal(h.billing.length, 0);
  } finally {
    [console.log, console.error, console.warn] = orig;
  }
  const out = lines.join("\n");
  assert.doesNotMatch(out, /cus_secret|sub_secret|tok_secret|@x\.co/);
});

test("multiple numbers: every number of a location is logged out, not only the default", async () => {
  const h = harness([acct("a")], { a: ["l1"] }, { l1: ["t-l1-slot2", "t-l1-slot3"] });
  const logged: string[] = [];
  const result = await purgeCancelledAccounts(h.repo, {
    now: () => NOW,
    logout: async (tenantId) => {
      logged.push(tenantId);
      return { ok: true };
    },
  });
  assert.deepEqual(result, { accounts: 1, locations: 1, failures: 0 });
  assert.deepEqual(logged.sort(), ["t-l1", "t-l1-slot2", "t-l1-slot3"]);
  assert.deepEqual(h.billing, [["a", { cleanedUpAt: NOW.toISOString() }]]);
});
