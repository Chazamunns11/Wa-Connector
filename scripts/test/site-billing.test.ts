import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addCardFlow, endTrialFlow, openPortalFlow, startCheckoutFlow } from "@/lib/billing/self-serve";
import { TRIAL_CAP_MESSAGE } from "@/lib/account-data/derive";
import { billingHref, DASHBOARD_RESULT_COPY } from "@/lib/site/dashboard-url";
import type { Account } from "@/lib/types";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

const acct = (over: Partial<Account> = {}): Account => ({
  id: "acc_1",
  name: "A",
  kind: "direct",
  ownerEmail: "a@example.com",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  billingStatus: "trialing",
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

test("endTrialFlow only acts on a trialing account with a subscription and a card", async () => {
  const seen: string[] = [];
  const endTrial = async (id: string) => (seen.push(id), { ok: true as const, data: {} as never });
  const withCard = async () => ({ ok: true as const, data: { cardLast4: "4242" } as never });
  const noCard = async () => ({ ok: true as const, data: { cardLast4: null } as never });
  const bad = async () => ({ ok: false as const, status: 500, code: null, message: "x" });
  assert.deepEqual(await endTrialFlow(acct(), { endTrial, retrieve: withCard }), { kind: "ended" });
  assert.deepEqual(seen, ["sub_1"]);
  for (const s of ["pending", "active", "past_due", "paused", "cancelled", "comped"] as const) {
    assert.deepEqual(await endTrialFlow(acct({ billingStatus: s }), { endTrial, retrieve: withCard }), { kind: "not_trialing" }, s);
  }
  assert.deepEqual(await endTrialFlow(acct({ stripeSubscriptionId: null }), { endTrial, retrieve: withCard }), { kind: "failed" });
  // No card: ending the trial now would pause the subscription at once, so ask for a card first.
  assert.deepEqual(await endTrialFlow(acct(), { endTrial, retrieve: noCard }), { kind: "needs_card" });
  assert.deepEqual(await endTrialFlow(acct(), { endTrial, retrieve: bad }), { kind: "failed" });
  assert.equal(seen.length, 1);
  assert.deepEqual(await endTrialFlow(acct(), { endTrial: bad, retrieve: withCard }), { kind: "failed" });
});

test("addCardFlow: setup Checkout for a trial or a trial paused with no card, back to the billing page", async () => {
  const calls: unknown[] = [];
  const setup = async (input: unknown) => (calls.push(input), { ok: true as const, data: { id: "cs", url: "https://stripe/s" } });
  const ended = "2026-10-08T00:00:00Z";
  assert.deepEqual(await addCardFlow(acct({ billingStatus: "paused", trialEndsAt: ended }), { appUrl: "https://app.test", setup }), {
    kind: "redirect",
    url: "https://stripe/s",
  });
  assert.deepEqual(calls[0], {
    accountId: "acc_1",
    customerId: "cus_1",
    successUrl: "https://app.test/dashboard/billing?result=card_added",
    cancelUrl: "https://app.test/dashboard/billing",
  });
  await addCardFlow(acct(), { appUrl: "https://app.test", setup, then: "end_trial" });
  assert.equal((calls[1] as { then?: string }).then, "end_trial");
  // unpaid (paused with no trial end) goes to the portal; other statuses never need it.
  for (const a of [
    acct({ billingStatus: "paused", trialEndsAt: null }),
    acct({ billingStatus: "active" }),
    acct({ billingStatus: "pending" }),
    acct({ billingStatus: "cancelled" }),
    acct({ stripeCustomerId: null }),
    acct({ stripeSubscriptionId: null }),
  ]) {
    assert.deepEqual(await addCardFlow(a, { appUrl: "u", setup }), { kind: "not_needed" });
  }
  assert.equal(calls.length, 2);
  const bad = async () => ({ ok: false as const, status: 500, code: null, message: "x" });
  assert.deepEqual(await addCardFlow(acct(), { appUrl: "u", setup: bad }), { kind: "failed" });
});

test("startCheckoutFlow for pending and cancelled accounts only", async () => {
  let n = 0;
  const checkout = async () => (n++, { ok: true as const, data: { id: "cs", url: "https://stripe/c" } });
  assert.deepEqual(await startCheckoutFlow(acct({ billingStatus: "pending" }), { appUrl: "u", checkout }), { kind: "redirect", url: "https://stripe/c" });
  assert.deepEqual(await startCheckoutFlow(acct({ billingStatus: "cancelled" }), { appUrl: "u", checkout }), { kind: "redirect", url: "https://stripe/c" });
  assert.deepEqual(await startCheckoutFlow(acct({ billingStatus: "active" }), { appUrl: "u", checkout }), { kind: "not_pending" });
  assert.equal(n, 2);
});

test("startCheckoutFlow: only brand-new pending accounts get a trial; restarts bill straight away on the old customer", async () => {
  const seen: Record<string, unknown>[] = [];
  const checkout = (async (i: Record<string, unknown>) => (seen.push(i), { ok: true as const, data: { id: "cs", url: "u" } })) as never;
  const fresh = { stripeCustomerId: null, stripeSubscriptionId: null };
  await startCheckoutFlow(acct({ billingStatus: "pending", ...fresh }), { appUrl: "u", checkout });
  await startCheckoutFlow(acct({ billingStatus: "cancelled" }), { appUrl: "u", checkout });
  await startCheckoutFlow(acct({ billingStatus: "cancelled", ...fresh }), { appUrl: "u", checkout });
  await startCheckoutFlow(acct({ billingStatus: "pending", stripeCustomerId: null, stripeSubscriptionId: "sub_old" }), { appUrl: "u", checkout });
  await startCheckoutFlow(acct({ billingStatus: "pending", stripeCustomerId: "cus_old", stripeSubscriptionId: null }), { appUrl: "u", checkout });
  assert.equal(seen[0].trial, true);
  assert.equal(seen[0].customerId, undefined);
  assert.equal(seen[1].trial, false);
  assert.equal(seen[1].customerId, "cus_1");
  assert.equal(seen[2].trial, false);
  assert.equal(seen[2].customerId, undefined);
  assert.equal(seen[3].trial, false);
  assert.equal(seen[4].trial, false);
  assert.equal(seen[4].customerId, "cus_old");
});

test("billing page restart button says billing starts today", () => {
  const src = read("src/app/(app)/dashboard/billing/page.tsx");
  assert.ok(src.includes("Restart your subscription — billing starts today"));
});

test("billingHref carries a fixed notice", () => {
  assert.equal(billingHref(), "/dashboard/billing");
  assert.equal(billingHref({ result: "trial_ended" }), "/dashboard/billing?result=trial_ended");
  assert.equal(billingHref({ error: "no_portal" }), "/dashboard/billing?error=no_portal");
});

test("trial cap message is the fixed sentence", () => {
  assert.equal(TRIAL_CAP_MESSAGE, "Your trial includes 3 sub-accounts. Start your paid plan now to add more.");
});

test("billing page is real: no sample markers, wired to the actions, tier sentence", () => {
  const src = read("src/app/(app)/dashboard/billing/page.tsx");
  assert.doesNotMatch(src, /\(sample\)|PreviewBadge|disabled aria-describedby="portal-hint"/);
  assert.match(src, /openBillingPortalAction/);
  assert.match(src, /endTrialNowAction/);
  assert.match(src, /startCheckoutAction/);
  assert.match(src, /addCardAction/);
  assert.match(src, /Add a card/);
  assert.match(src, /tierSentence\(/);
  assert.match(src, /Cancels at the end of this period/);
  assert.match(src, /Ends the free trial today and starts monthly billing for your active numbers\./);
});

test("billing actions re-check the session and take the customer id from the account row", () => {
  const src = read("src/app/(app)/dashboard/billing/actions.ts");
  assert.match(src, /^"use server"/);
  const fns = src.match(/export async function \w+/g) ?? [];
  assert.deepEqual(fns.map((f) => f.split(" ").pop()).sort(), ["addCardAction", "endTrialNowAction", "openBillingPortalAction", "startCheckoutAction"]);
  assert.equal((src.match(/requireAccountSession\(\)/g) ?? []).length, 4);
  assert.doesNotMatch(src, /formData|FormData/);
  assert.doesNotMatch(read("src/app/(app)/dashboard/actions.ts"), /startCheckoutAction/);
});

test("dashboard shows the trial cap message with a paid-plan button", () => {
  const src = read("src/app/(app)/dashboard/page.tsx");
  assert.equal(DASHBOARD_RESULT_COPY.trial_cap, TRIAL_CAP_MESSAGE);
  assert.match(src, /result === "trial_cap"/);
  assert.match(src, /endTrialNowAction/);
  assert.match(src, /billing\/actions/);
});
