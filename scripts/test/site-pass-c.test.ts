import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrandConfig } from "@/lib/brand-config";
import { salesCopy } from "@/lib/site/sales-copy";

// Task C of the site pass: features, hero copy, pricing (SITE-PASS.md §3, §6, §7; Ruling W47).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const brand: BrandConfig = {
  name: "Testbrand",
  tagline: "Tagline",
  supportEmail: null,
  supportWhatsApp: null,
  logoPath: null,
  accent: null,
  appUrl: "http://localhost:3000",
};

test("featureEntries: eight entries, groups last and 'soon' while the flag is off", async () => {
  const { FEATURES, featureEntries } = await import("../../src/lib/site/features.ts");
  assert.equal(FEATURES.groupsLive, false);
  const e = featureEntries(brand);
  assert.equal(e.length, 8);
  assert.equal(e[e.length - 1].id, "groups");
  assert.equal(e[e.length - 1].soon, true);
  assert.equal(e[0].visual, "reply");
  assert.equal(e[1].visual, "dashboard");
});

test("featureEntriesFor: with groups live the entry is second and not soon", async () => {
  const { featureEntriesFor } = await import("../../src/lib/site/features.ts");
  const e = featureEntriesFor({ groupsLive: true, dndSyncLive: true, mediaLive: true }, brand);
  assert.equal(e.length, 8);
  assert.equal(e[1].id, "groups");
  assert.ok(!e[1].soon);
  assert.equal(e[1].visual, "group");
});

test("featureEntriesFor: the DND and media entries drop out when their switches are off", async () => {
  const { featureEntriesFor } = await import("../../src/lib/site/features.ts");
  const e = featureEntriesFor({ groupsLive: false, dndSyncLive: false, mediaLive: false }, brand);
  assert.deepEqual(
    e.map((x) => x.id),
    ["chat", "dashboard", "pacing", "held", "stop", "groups"],
  );
});

test("featureEntries carry the three pinned safety sentences", async () => {
  const { featureEntries } = await import("../../src/lib/site/features.ts");
  const bodies = featureEntries(brand).map((e) => e.body);
  for (const s of salesCopy(brand).safety) assert.ok(bodies.some((b) => b.includes(s.body)), s.title);
});

test("feature copy: no rate claims, no GHL, no spaced dashes, brand at most once per entry", async () => {
  const { featureEntries } = await import("../../src/lib/site/features.ts");
  for (const e of featureEntries(brand)) {
    const t = `${e.title} ${e.body}`;
    assert.ok(!/read rate|open rate|98%|\bGHL\b/i.test(t), e.id);
    assert.ok(!/—/.test(t), `${e.id} has an em dash`);
    assert.ok(!/not just|not only/i.test(t), e.id);
    assert.ok((t.match(/Testbrand/g) ?? []).length <= 1, e.id);
  }
});

test("W47: the groups entry is honest about replies, the dashboard and the price", async () => {
  const { featureEntries, featureEntriesFor } = await import("../../src/lib/site/features.ts");
  for (const e of [
    featureEntries(brand).find((x) => x.id === "groups")!,
    featureEntriesFor({ groupsLive: true, dndSyncLive: true, mediaLive: true }, brand).find((x) => x.id === "groups")!,
  ]) {
    assert.match(e.body, /dashboard/);
    assert.match(e.body, /stay in WhatsApp on the phone/);
    assert.match(e.body, /don't appear in GoHighLevel/);
    assert.match(e.body, /invite link/);
    assert.match(e.body, /Included/);
    assert.ok(!/reach(es)? Conversations|from GoHighLevel workflows?/i.test(e.body));
  }
  const src = read("src/lib/site/features.ts");
  assert.match(src, /groups-copy\.ts/, "records where the groups wording was copied from");
});

test("home page renders FeatureList and no longer the afterwards or safety bands", () => {
  const p = read("src/app/(site)/page.tsx");
  assert.match(p, /<FeatureList/);
  assert.ok(!/copy\.afterwards/.test(p));
  assert.ok(!/<SafetyThread/.test(p));
  assert.ok(!/<DashboardSample/.test(p), "the dashboard sample lives inside the features list");
  assert.match(p, /href: "#features"/);
  assert.match(p, /See everything it does/);
});

test("hero: the h1 states the product and the result line keeps the 85%+ figure", () => {
  const p = read("src/app/(site)/page.tsx");
  const h1 = p.slice(p.indexOf("<h1"), p.indexOf("</h1>"));
  assert.ok(!/hero-big/.test(h1));
  assert.match(h1, /copy\.heroH1/);
  const c = salesCopy(brand) as unknown as { heroH1: string };
  assert.match(c.heroH1, /WhatsApp/);
  assert.match(c.heroH1, /from your own number/);
  assert.match(c.heroH1, /GoHighLevel/);
  assert.match(p, /className="hero-result/);
  assert.equal((p.match(/num-display/g) ?? []).length >= 2, true);
  assert.match(p, /result\.resultLabel/);
  assert.match(p, /href="#own-result"/);
  assert.ok(p.indexOf("</h1>") < p.indexOf("hero-result"), "result line is a sibling after the h1");
});

test("proof.ts exports resultLabel (the sentence became a figure plus a label in Task E)", async () => {
  const { OWN_RESULTS_AVERAGE } = await import("../../src/lib/site/proof.ts");
  assert.equal(OWN_RESULTS_AVERAGE.resultLabel, "of booked clients turned up, before and after WhatsApp reminders");
  assert.match(OWN_RESULTS_AVERAGE.after, /85%\+/);
});

test("hero sub-line: Telephony Provider, Send SMS steps, reply lands in Conversations", () => {
  const c = salesCopy(brand);
  assert.match(c.heroSub, /Telephony Provider/);
  assert.match(c.heroSub, /Send SMS/);
  assert.match(c.heroSub, /Conversations/);
});

test("FeatureList markup", () => {
  const f = read("src/components/site/FeatureList.tsx");
  assert.match(f, /id="features"/);
  assert.match(f, /className="band hang-pad/);
  assert.match(f, /What it does/);
  assert.match(f, /Everything here is on every plan, for every number you connect\./);
  assert.match(f, /border-t-2 border-rule/);
  assert.match(f, /h-item/);
  assert.match(f, /Coming soon/);
  assert.match(f, /bg-chip/);
  assert.match(f, /Sample screen, sample businesses\./);
  assert.match(f, /ReplyDiagram/);
  assert.match(f, /DashboardSample/);
  assert.ok(!/"use client"/.test(f));
  assert.ok(existsSync(join(root, "src/components/site/IncludedList.tsx")));
});

test("DashboardSample has the Send connect link action and its label says so", () => {
  const d = read("src/components/site/samples/DashboardSample.tsx");
  assert.match(d, /Send connect link/);
  const label = d.slice(d.indexOf("const label"), d.indexOf("return ("));
  assert.match(label, /Send connect link/);
});

test("home price strip and PricingSummary say every feature is on every plan", () => {
  assert.match(read("src/components/site/PricingSummary.tsx"), /Every feature on every plan/);
  assert.match(read("src/components/site/PricingSummary.tsx"), /No setup fee, no charge per message/);
});

test("pricing page: IncludedList in the calculator slab, resale band on coral, no setup fee line kept", () => {
  const p = read("src/app/(site)/pricing/page.tsx");
  assert.match(p, /<IncludedList/);
  assert.ok(p.indexOf("<IncludedList") > p.indexOf("<PricingCalculator"));
  assert.ok(p.indexOf("<IncludedList") < p.indexOf('id="resale"'));
  assert.match(p, /id="resale" className="surface-coral/);
  assert.match(p, /<ResaleCalculator/);
  assert.match(p, /There is no setup fee, and \{brand\.name\} does not charge per message\./);
});

test("IncludedList: features, no fee, trial, billing and cancel terms", async () => {
  const src = read("src/components/site/IncludedList.tsx");
  assert.match(src, /What's included/);
  assert.match(src, /Every feature on every plan/);
  assert.match(src, /No setup fee and no charge per message/);
  assert.match(src, /7-day|TRIAL_DAYS/);
  assert.match(src, /billing portal/);
  assert.match(src, /active sub-account/);
  assert.ok(!/[£$€]\s?\d/.test(src));
});
