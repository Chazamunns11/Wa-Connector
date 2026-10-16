import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endTrialFlow, openPortalFlow, startCheckoutFlow } from "@/lib/billing/self-serve";
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

test("endTrialFlow only acts on a trialing account with a subscription", async () => {
  const seen: string[] = [];
  const endTrial = async (id: string) => (seen.push(id), { ok: true as const, data: {} as never });
  assert.deepEqual(await endTrialFlow(acct(), { endTrial }), { kind: "ended" });
  assert.deepEqual(seen, ["sub_1"]);
  for (const s of ["pending", "active", "past_due", "paused", "cancelled", "comped"] as const) {
    assert.deepEqual(await endTrialFlow(acct({ billingStatus: s }), { endTrial }), { kind: "not_trialing" }, s);
  }
  assert.deepEqual(await endTrialFlow(acct({ stripeSubscriptionId: null }), { endTrial }), { kind: "failed" });
  assert.equal(seen.length, 1);
  const bad = async () => ({ ok: false as const, status: 500, code: null, message: "x" });
  assert.deepEqual(await endTrialFlow(acct(), { endTrial: bad }), { kind: "failed" });
});

test("startCheckoutFlow only for pending accounts", async () => {
  let n = 0;
  const checkout = async () => (n++, { ok: true as const, data: { id: "cs", url: "https://stripe/c" } });
  assert.deepEqual(await startCheckoutFlow(acct({ billingStatus: "pending" }), { appUrl: "u", checkout }), { kind: "redirect", url: "https://stripe/c" });
  assert.deepEqual(await startCheckoutFlow(acct({ billingStatus: "active" }), { appUrl: "u", checkout }), { kind: "not_pending" });
  assert.equal(n, 1);
});

test("billingHref carries a fixed notice", () => {
  assert.equal(billingHref(), "/dashboard/billing");
  assert.equal(billingHref({ result: "trial_ended" }), "/dashboard/billing?result=trial_ended");
  assert.equal(billingHref({ error: "no_portal" }), "/dashboard/billing?error=no_portal");
});

test("trial cap message is the fixed sentence", () => {
  assert.equal(TRIAL_CAP_MESSAGE, "Your trial includes 3 numbers. Start your paid plan now to add more.");
});

test("billing page is real: no sample markers, wired to the actions, tier sentence", () => {
  const src = read("src/app/(app)/dashboard/billing/page.tsx");
  assert.doesNotMatch(src, /\(sample\)|PreviewBadge|disabled aria-describedby="portal-hint"/);
  assert.match(src, /openBillingPortalAction/);
  assert.match(src, /endTrialNowAction/);
  assert.match(src, /startCheckoutAction/);
  assert.match(src, /tierSentence\(/);
  assert.match(src, /Cancels at the end of this period\./);
  assert.match(src, /Ends the free trial today and starts monthly billing for your active numbers\./);
});

test("billing actions re-check the session and take the customer id from the account row", () => {
  const src = read("src/app/(app)/dashboard/billing/actions.ts");
  assert.match(src, /^"use server"/);
  const fns = src.match(/export async function \w+/g) ?? [];
  assert.deepEqual(fns.map((f) => f.split(" ").pop()).sort(), ["endTrialNowAction", "openBillingPortalAction", "startCheckoutAction"]);
  assert.equal((src.match(/requireAccountSession\(\)/g) ?? []).length, 3);
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
