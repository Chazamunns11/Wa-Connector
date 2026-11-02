import { test } from "node:test";
import assert from "node:assert/strict";
import { SupabaseAccountDataSource } from "@/lib/account-data/supabase";
import { getAccountDataSource } from "@/lib/account-data";
import { pricingConfig } from "@/lib/pricing";
import type { Account, GhlAccountSummary, LocationStats, NumberBilling, WhatsappSessionSummary } from "@/lib/types";
import { number } from "./billing-fakes";

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 86_400_000;

const ACCOUNT: Account = {
  id: "acc-1", name: "Sample Wellness", kind: "agency", ownerEmail: "o@example.com",
  stripeCustomerId: "cus_1", stripeSubscriptionId: null, billingStatus: "active",
  trialEndsAt: "2026-10-20T12:00:00.000Z", cancelledAt: null, cleanedUpAt: null, createdAt: "2026-10-13T12:00:00Z",
};

function loc(id: string, label: string, activated: boolean): GhlAccountSummary {
  return {
    locationId: id, tenantId: `ten-${id}`, label, companyId: null, status: "connected", lastError: null,
    createdAt: "2026-10-01T00:00:00Z", brandLogoPath: null, brandAccentColor: null, accountId: "acc-1",
    activatedAt: activated ? "2026-10-10T00:00:00Z" : null,
  } as GhlAccountSummary;
}

function fakes(opts: { account?: Account | null; locations?: GhlAccountSummary[]; billing?: NumberBilling[]; numbers?: Record<string, number> } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const numbers = opts.numbers ?? {};
  const locations = opts.locations ?? [loc("a", "Alpha", true), loc("b", "Bravo", false), loc("c", "Charlie", true)];
  const repo = {
    async getAccountById(id: string) { calls.push({ name: "getAccountById", args: [id] }); return opts.account === undefined ? ACCOUNT : opts.account; },
    async listGhlAccountsForAccount(id: string) { calls.push({ name: "listGhlAccountsForAccount", args: [id] }); return locations; },
    async getWhatsappSessionSummariesForTenants(ids: string[]): Promise<WhatsappSessionSummary[]> {
      calls.push({ name: "summaries", args: [ids] });
      return [{ coachId: "ten-a", status: "connected", phoneNumber: "+447700900101", lastConnectedAt: "2026-10-10T00:00:00Z", lastDisconnectReason: null, sentToday: 7, heldMessages: 0 }];
    },
    // Per-number billing: one number per sub-account unless a test says otherwise.
    async countNumbersByLocation(ids: string[]): Promise<Record<string, number>> {
      return Object.fromEntries(ids.map((id) => [id, numbers[id] ?? 1]));
    },
    async countOptOutsByTenant(ids: string[]): Promise<Map<string, number>> {
      calls.push({ name: "optOuts", args: [ids] });
      return new Map([["ten-a", 2]]);
    },
    async listNumberBillingForAccount(id: string) {
      calls.push({ name: "numbers", args: [id] });
      return opts.billing ?? [
        number("n1", { billingStatus: "trialing" }),
        number("n2", { billingStatus: "active" }),
        number("n3", { billingStatus: "past_due" }),
        number("n4", { billingStatus: "paused" }),
        number("n5", { billingStatus: "incomplete" }),
        number("n6", { billingStatus: "cancelled" }),
        number("n7"),
      ];
    },
    async getLocationStats(ids: string[], since: string): Promise<Record<string, LocationStats>> {
      calls.push({ name: "stats", args: [ids, since] });
      return Object.fromEntries(ids.map((i) => [i, { pendingSend: 0, failedLast7Days: { count: 0, reasons: [] }, everReceived: true }]));
    },
  };
  return { repo, calls };
}
const stripeCalls: string[] = [];
const retrieveCustomerCard = async (id: string) => {
  stripeCalls.push(id);
  return { ok: true as const, data: { cardLast4: "4242" } };
};
const make = (f: ReturnType<typeof fakes>, now = NOW) =>
  new SupabaseAccountDataSource(f.repo as never, { retrieveCustomerCard } as never, "acc-1", now);

test("listLocations reads the account's rows, then summaries by tenant and stats since 7 days, in label order", async () => {
  const f = fakes({ locations: [loc("a", "Alpha", true), loc("b", "Bravo", false), loc("c", "Charlie", true)] });
  const rows = await make(f).listLocations();
  assert.deepEqual(f.calls.map((c) => c.name), ["listGhlAccountsForAccount", "summaries", "stats", "optOuts"]);
  assert.deepEqual(f.calls[3].args, [["ten-a", "ten-b", "ten-c"]]);
  assert.deepEqual(rows.map((r) => r.optOuts), [2, 0, 0]);
  assert.deepEqual(f.calls[0].args, ["acc-1"]);
  assert.deepEqual(f.calls[1].args, [["ten-a", "ten-b", "ten-c"]]);
  assert.deepEqual(f.calls[2].args, [["a", "b", "c"], new Date(NOW.getTime() - 7 * DAY).toISOString()]);
  assert.deepEqual(rows.map((r) => r.name), ["Alpha", "Bravo", "Charlie"]);
  assert.equal(rows[0].sentToday, 7);
  assert.deepEqual(rows[0].state, { kind: "connected", number: "+447700900101" });
  assert.deepEqual(rows[1].state, { kind: "not_active" });
});

test("listLocations with no rows makes no probe queries", async () => {
  const f = fakes({ locations: [] });
  assert.deepEqual(await make(f).listLocations(), []);
  assert.deepEqual(f.calls.map((c) => c.name), ["listGhlAccountsForAccount"]);
});

test("getAccount maps Account to AccountSummary", async () => {
  const a = await make(fakes()).getAccount();
  assert.deepEqual(a, { id: "acc-1", name: "Sample Wellness", kind: "agency", email: "o@example.com", billingStatus: "active", stripeCustomerId: "cus_1" });
});

test("getAccount refuses a missing account", async () => {
  await assert.rejects(make(fakes({ account: null })).getAccount());
});

test("getBilling counts the account's numbers by their own billing; the month is the graduated price of the billed ones", async () => {
  stripeCalls.length = 0;
  const b = await make(fakes()).getBilling();
  assert.deepEqual(stripeCalls, [], "no Stripe call unless the card is asked for");
  assert.deepEqual(b, {
    cardLast4: null,
    billedNumbers: 3,
    trialingNumbers: 1,
    pastDueNumbers: 1,
    stoppedNumbers: 2,
    monthlyAmount: 29.97,
    currency: pricingConfig().currency,
    portalAvailable: true,
  });
});

test("getBilling withCard reads the customer's card once", async () => {
  stripeCalls.length = 0;
  const b = await make(fakes()).getBilling({ withCard: true });
  assert.deepEqual(stripeCalls, ["cus_1"]);
  assert.equal(b.cardLast4, "4242");
});

test("getBilling at 25 billed numbers: 10 x £9.99 + 15 x £7.99", async () => {
  const many = Array.from({ length: 25 }, (_, i) => number(`n${i}`, { billingStatus: "active" }));
  const b = await make(fakes({ billing: many })).getBilling();
  assert.equal(b.monthlyAmount, 219.75);
});

test("getBilling for an account with no Stripe customer (comped or pending) never calls Stripe and has no portal", async () => {
  stripeCalls.length = 0;
  const comped = { ...ACCOUNT, billingStatus: "comped" as const, stripeCustomerId: null };
  const b = await make(fakes({ account: comped, billing: [] })).getBilling({ withCard: true });
  assert.deepEqual(stripeCalls, []);
  assert.equal(b.portalAvailable, false);
  assert.equal(b.monthlyAmount, 0);
});

test("getBilling degrades to no card details when Stripe fails, keeping the portal if a customer exists", async () => {
  const failing = new SupabaseAccountDataSource(
    fakes().repo as never,
    { retrieveCustomerCard: async () => ({ ok: false, status: 502, code: null, message: "x" }) } as never,
    "acc-1", NOW,
  );
  const b = await failing.getBilling({ withCard: true });
  assert.equal(b.cardLast4, null);
  assert.equal(b.portalAvailable, true);
});

test("the real source is not a preview, and index builds it from the session", () => {
  const src = getAccountDataSource({ accountId: "acc-1", role: "account" } as never, NOW);
  assert.equal(src.preview, false);
});
