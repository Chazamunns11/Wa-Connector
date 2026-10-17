import { test } from "node:test";
import assert from "node:assert/strict";
import { SupabaseAccountDataSource } from "@/lib/account-data/supabase";
import { getAccountDataSource } from "@/lib/account-data";
import { monthlyCostPence, pricingConfig } from "@/lib/pricing";
import type { Account, GhlAccountSummary, LocationStats, WhatsappSessionSummary } from "@/lib/types";

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 86_400_000;

const ACCOUNT: Account = {
  id: "acc-1", name: "Sample Wellness", kind: "agency", ownerEmail: "o@example.com",
  stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", billingStatus: "trialing",
  trialEndsAt: "2026-10-20T12:00:00.000Z", cancelledAt: null, cleanedUpAt: null, createdAt: "2026-10-13T12:00:00Z",
};

function loc(id: string, label: string, activated: boolean): GhlAccountSummary {
  return {
    locationId: id, tenantId: `ten-${id}`, label, companyId: null, status: "connected", lastError: null,
    createdAt: "2026-10-01T00:00:00Z", brandLogoPath: null, brandAccentColor: null, accountId: "acc-1",
    activatedAt: activated ? "2026-10-10T00:00:00Z" : null,
  } as GhlAccountSummary;
}

function fakes(opts: { account?: Account | null; locations?: GhlAccountSummary[] } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const locations = opts.locations ?? [loc("a", "Alpha", true), loc("b", "Bravo", false), loc("c", "Charlie", true)];
  const repo = {
    async getAccountById(id: string) { calls.push({ name: "getAccountById", args: [id] }); return opts.account === undefined ? ACCOUNT : opts.account; },
    async listGhlAccountsForAccount(id: string) { calls.push({ name: "listGhlAccountsForAccount", args: [id] }); return locations; },
    async getWhatsappSessionSummariesForTenants(ids: string[]): Promise<WhatsappSessionSummary[]> {
      calls.push({ name: "summaries", args: [ids] });
      return [{ coachId: "ten-a", status: "connected", phoneNumber: "+447700900101", lastConnectedAt: "2026-10-10T00:00:00Z", lastDisconnectReason: null, sentToday: 7, heldMessages: 0 }];
    },
    async countOptOutsByTenant(ids: string[]): Promise<Map<string, number>> {
      calls.push({ name: "optOuts", args: [ids] });
      return new Map([["ten-a", 2]]);
    },
    async getLocationStats(ids: string[], since: string): Promise<Record<string, LocationStats>> {
      calls.push({ name: "stats", args: [ids, since] });
      return Object.fromEntries(ids.map((i) => [i, { pendingSend: 0, failedLast7Days: { count: 0, reasons: [] }, everReceived: true }]));
    },
  };
  return { repo, calls };
}
const stripeCalls: string[] = [];
const retrieveSubscription = async (id: string) => {
  stripeCalls.push(id);
  return { ok: true as const, data: { id, status: "trialing", customer: "cus_1", trialEnd: null, canceledAt: null, endedAt: null, cancelAtPeriodEnd: true, currentPeriodEnd: 1_792_000_000, itemId: "si_1", quantity: 2, cardLast4: "4242", metadata: {} } };
};
const make = (f: ReturnType<typeof fakes>, now = NOW) =>
  new SupabaseAccountDataSource(f.repo as never, { retrieveSubscription } as never, "acc-1", now);

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

test("getAccount maps Account to AccountSummary, including Stripe ids", async () => {
  const a = await make(fakes()).getAccount();
  assert.deepEqual(a, {
    id: "acc-1", name: "Sample Wellness", kind: "agency", email: "o@example.com", billingStatus: "trialing",
    trialEndsAt: "2026-10-20T12:00:00.000Z", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1",
  });
});

test("getAccount refuses a missing account", async () => {
  await assert.rejects(make(fakes({ account: null })).getAccount());
});

test("getBilling reads the subscription; next invoice uses volume pricing over active numbers", async () => {
  stripeCalls.length = 0;
  const b = await make(fakes()).getBilling();
  assert.deepEqual(stripeCalls, ["sub_1"]);
  assert.equal(b.cardLast4, "4242");
  assert.equal(b.nextInvoiceAt, new Date(1_792_000_000 * 1000).toISOString());
  assert.equal(b.nextInvoiceAmount, monthlyCostPence(2) / 100);
  assert.equal(b.currency, pricingConfig().currency);
  assert.equal(b.portalAvailable, true);
  assert.equal(b.cancelAtPeriodEnd, true);
});

test("getBilling given the rows does not list locations again", async () => {
  const f = fakes();
  const src = make(f);
  const rows = await src.listLocations();
  const before = f.calls.length;
  const b = await src.getBilling(rows);
  assert.equal(b.nextInvoiceAmount, monthlyCostPence(2) / 100);
  assert.equal(f.calls.slice(before).filter((c) => c.name === "listGhlAccountsForAccount").length, 0);
});

test("getBilling at 25 active sub-accounts prices every sub-account at the volume rate", async () => {
  const many = Array.from({ length: 25 }, (_, i) => loc(`l${i}`, `L${i}`, true));
  const b = await make(fakes({ locations: many })).getBilling();
  assert.equal(b.nextInvoiceAmount, 249.75);
});

test("getBilling for an account with no subscription (comped or pending) never calls Stripe", async () => {
  stripeCalls.length = 0;
  const comped = { ...ACCOUNT, billingStatus: "comped" as const, stripeCustomerId: null, stripeSubscriptionId: null };
  const b = await make(fakes({ account: comped })).getBilling();
  assert.deepEqual(stripeCalls, []);
  assert.deepEqual(b, {
    cardLast4: null, nextInvoiceAt: null, nextInvoiceAmount: null, currency: pricingConfig().currency,
    portalAvailable: false, cancelAtPeriodEnd: false,
  });
});

test("getBilling degrades to no card details when Stripe fails, keeping the portal if a customer exists", async () => {
  const failing = new SupabaseAccountDataSource(
    fakes().repo as never,
    { retrieveSubscription: async () => ({ ok: false, status: 502, code: null, message: "x" }) } as never,
    "acc-1", NOW,
  );
  const b = await failing.getBilling();
  assert.equal(b.cardLast4, null);
  assert.equal(b.nextInvoiceAt, null);
  assert.equal(b.portalAvailable, true);
});

test("the real source is not a preview, and index builds it from the session", () => {
  const src = getAccountDataSource({ accountId: "acc-1", role: "account" } as never, NOW);
  assert.equal(src.preview, false);
});
