import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewAccountDataSource } from "@/lib/account-data/preview";
import { getAccountDataSource, parseScenario } from "@/lib/account-data";
import { activeCount } from "@/lib/account-data/derive";
import { TRIAL_MAX_NUMBERS, monthlyCost, pricingConfig } from "@/lib/pricing";

const NOW = new Date("2026-10-16T12:00:00Z");

test("preview source is marked preview and returns 6 locations with every WhatsappState kind", async () => {
  const src = new PreviewAccountDataSource("active", NOW);
  assert.equal(src.preview, true);
  assert.equal(getAccountDataSource().preview, true);
  const rows = await src.listLocations();
  assert.equal(rows.length, 6);
  const kinds = new Set<string>(rows.map((r) => r.state.kind));
  for (const k of ["not_active", "waiting_qr", "connected", "disconnected"]) assert.ok(kinds.has(k), k);
  assert.equal(rows.filter((r) => r.state.kind === "connected").length, 3);
  assert.equal(rows.filter((r) => r.providerNudge).length, 1);
  const dis = rows.find((r) => r.state.kind === "disconnected");
  assert.deepEqual(dis?.state, { kind: "disconnected", waiting: 4 });
  assert.ok(rows.some((r) => r.sentToday === 150 && r.dailyCap === 150));
  const billing = await src.getBilling();
  assert.equal(billing.portalAvailable, false);
});

test("trial scenario keeps activated numbers within the trial cap, and the invoice follows them", async () => {
  const src = new PreviewAccountDataSource("trial", NOW);
  const rows = await src.listLocations();
  assert.ok(activeCount(rows) <= TRIAL_MAX_NUMBERS);
  assert.equal(rows.length, 6);
  const billing = await src.getBilling();
  assert.equal(billing.currency, pricingConfig().currency);
  assert.equal(billing.nextInvoiceAmount, monthlyCost(activeCount(rows)));
  const via = await getAccountDataSource({ scenario: "trial", now: NOW }).getAccount();
  assert.equal(via.trialEndsAt, new Date(NOW.getTime() + 4 * 86_400_000).toISOString());
});

test("scenario past_due sets billingStatus past_due; trial sets trialEndsAt 4 days ahead of now", async () => {
  const past = await new PreviewAccountDataSource("past_due", NOW).getAccount();
  assert.equal(past.billingStatus, "past_due");
  const trial = await new PreviewAccountDataSource("trial", NOW).getAccount();
  assert.equal(trial.billingStatus, "trialing");
  assert.equal(trial.trialEndsAt, new Date(NOW.getTime() + 4 * 86_400_000).toISOString());
  const active = await new PreviewAccountDataSource("active", NOW).getAccount();
  assert.equal(active.billingStatus, "active");
  assert.equal(active.trialEndsAt, null);
});

test("parseScenario defaults to trial and rejects unknown values", () => {
  assert.equal(parseScenario(undefined), "trial");
  assert.equal(parseScenario("active"), "active");
  assert.equal(parseScenario("past_due"), "past_due");
  assert.equal(parseScenario("bogus"), "trial");
  assert.equal(parseScenario(["active", "past_due"]), "active");
  assert.equal(parseScenario([]), "trial");
});
