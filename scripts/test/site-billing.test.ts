import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addCardFlow, openPortalFlow, startCheckoutFlow } from "@/lib/billing/self-serve";
import { billingHref, DASHBOARD_RESULT_COPY } from "@/lib/site/dashboard-url";
import type { Account } from "@/lib/types";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

const acct = (over: Partial<Account> = {}): Account => ({
  id: "acc_1",
  name: "A",
  kind: "direct",
  ownerEmail: "a@example.com",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: null,
  billingStatus: "active",
  trialEndsAt: null,
  cancelledAt: null,
  cleanedUpAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

test("openPortalFlow uses the account's own customer id and the billing return url", async () => {
  const calls: string[][] = [];
  const out = await openPortalFlow(acct(), {
    appUrl: "https://app.test",
    portal: async (c, r) => (calls.push([c, r]), { ok: true, data: { url: "https://stripe/p" } }),
  });
  assert.deepEqual(out, { kind: "redirect", url: "https://stripe/p" });
  assert.deepEqual(calls, [["cus_1", "https://app.test/dashboard/billing"]]);
});

test("openPortalFlow: no customer means no_portal, Stripe failure means failed", async () => {
  const portal = async () => ({ ok: false as const, status: 500, code: null, message: "x" });
  assert.deepEqual(await openPortalFlow(acct({ stripeCustomerId: null }), { appUrl: "u", portal }), { kind: "no_portal" });
  assert.deepEqual(await openPortalFlow(acct(), { appUrl: "u", portal }), { kind: "failed" });
});

test("addCardFlow: setup Checkout on the account's own customer for a card-on-file account, back to the billing page", async () => {
  const calls: unknown[] = [];
  const setup = async (input: unknown) => (calls.push(input), { ok: true as const, data: { id: "cs", url: "https://stripe/s" } });
  assert.deepEqual(await addCardFlow(acct(), { appUrl: "https://app.test", setup }), { kind: "redirect", url: "https://stripe/s" });
  assert.deepEqual(calls[0], {
    accountId: "acc_1",
    customerId: "cus_1",
    successUrl: "https://app.test/dashboard/billing?result=card_added",
    cancelUrl: "https://app.test/dashboard/billing",
  });
  for (const a of [acct({ billingStatus: "pending" }), acct({ billingStatus: "comped" }), acct({ billingStatus: "cancelled" }), acct({ stripeCustomerId: null })]) {
    assert.deepEqual(await addCardFlow(a, { appUrl: "u", setup }), { kind: "not_needed" });
  }
  assert.equal(calls.length, 1);
  const bad = async () => ({ ok: false as const, status: 500, code: null, message: "x" });
  assert.deepEqual(await addCardFlow(acct(), { appUrl: "u", setup: bad }), { kind: "failed" });
});

test("startCheckoutFlow (save a card): creates the Stripe customer once, then a setup Checkout; never for a card-on-file account", async () => {
  const log: string[] = [];
  const repo = { updateAccountBilling: async (id: string, p: unknown) => void log.push(`update:${id}:${JSON.stringify(p)}`) };
  const deps = {
    appUrl: "https://app.test",
    createCustomer: async (i: { accountId: string }) => (log.push(`customer:${i.accountId}`), { ok: true as const, data: { id: "cus_new" } }),
    setup: async (i: { customerId: string }) => (log.push(`setup:${i.customerId}`), { ok: true as const, data: { id: "cs", url: "https://stripe/c" } }),
  };
  assert.deepEqual(await startCheckoutFlow(repo, acct({ billingStatus: "pending", stripeCustomerId: null }), deps), { kind: "redirect", url: "https://stripe/c" });
  assert.deepEqual(log, ["customer:acc_1", 'update:acc_1:{"stripeCustomerId":"cus_new"}', "setup:cus_new"]);
  log.length = 0;
  assert.deepEqual(await startCheckoutFlow(repo, acct({ billingStatus: "cancelled" }), deps), { kind: "redirect", url: "https://stripe/c" });
  assert.deepEqual(log, ["setup:cus_1"]);
  log.length = 0;
  for (const s of ["active", "comped"] as const) assert.deepEqual(await startCheckoutFlow(repo, acct({ billingStatus: s }), deps), { kind: "not_pending" });
  assert.deepEqual(log, []);
});

test("billingHref carries a fixed notice", () => {
  assert.equal(billingHref(), "/dashboard/billing");
  assert.equal(billingHref({ result: "card_added" }), "/dashboard/billing?result=card_added");
  assert.equal(billingHref({ error: "no_portal" }), "/dashboard/billing?error=no_portal");
});

test("billing page is real: no sample markers, wired to the actions, price sentence", () => {
  const src = read("src/app/(app)/dashboard/billing/page.tsx");
  assert.doesNotMatch(src, /\(sample\)|PreviewBadge|disabled aria-describedby="portal-hint"/);
  assert.match(src, /openBillingPortalAction/);
  assert.doesNotMatch(src, /endTrialNowAction/);
  assert.match(src, /startCheckoutAction/);
  assert.match(src, /addCardAction/);
  assert.match(src, /Save a card/);
  assert.match(src, /Add a card/);
  assert.match(src, /priceSentence\(/);
  assert.match(src, /Each number is charged separately, every month on the day its trial ended\./);
});

test("billing actions re-check the session and take the customer id from the account row", () => {
  const src = read("src/app/(app)/dashboard/billing/actions.ts");
  assert.match(src, /^"use server"/);
  const fns = src.match(/export async function \w+/g) ?? [];
  assert.deepEqual(fns.map((f) => f.split(" ").pop()).sort(), ["addCardAction", "openBillingPortalAction", "startCheckoutAction"]);
  assert.equal((src.match(/requireAccountSession\(\)/g) ?? []).length, 3);
  assert.doesNotMatch(src, /formData|FormData/);
  assert.doesNotMatch(read("src/app/(app)/dashboard/actions.ts"), /startCheckoutAction/);
});

test("the trial cap is gone: no trial_cap result, no paid-plan-now button", () => {
  const src = read("src/app/(app)/dashboard/page.tsx");
  assert.equal(Object.hasOwn(DASHBOARD_RESULT_COPY, "trial_cap"), false);
  assert.doesNotMatch(src, /trial_cap|endTrialNowAction/);
  assert.match(src, /billing\/actions/);
});
