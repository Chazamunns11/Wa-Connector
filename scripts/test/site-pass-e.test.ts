import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = () => read("src/app/globals.css");
const DIR = "src/components/site/samples";

/** Body of the first rule whose selector line is exactly `selector {`. */
function rule(text: string, selector: string): string {
  const i = text.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `${selector} rule exists`);
  return text.slice(i, text.indexOf("\n}", i));
}

test("E: the hero grid gives the phones close to half the width", () => {
  const m = rule(css(), ".hero-grid").match(/grid-template-columns:\s*minmax\(0,\s*([\d.]+)fr\)\s*minmax\(0,\s*([\d.]+)fr\)/);
  assert.ok(m, "two fr columns");
  assert.ok(Number(m![1]) / Number(m![2]) <= 1.3, "text column is at most 1.3x the phones column");
});

test("E: the phones overlap, and each is at least 280px wide when there is room", () => {
  const c = css();
  assert.match(rule(c, ".phone"), /width:\s*clamp\(165px,\s*2[4-9]vw,\s*3[0-2]\dpx\)/);
  assert.match(c, /@media \(min-width: 601px\)\s*\{[^@]*\.phones > \.phone:nth-child\(2\)\s*\{[^}]*margin-left:\s*-\d+px/);
});

test("E: the hero section has its own bottom padding, so the result block is inside the Ink", () => {
  const p = read("src/app/(site)/page.tsx");
  assert.ok(!/surface-dark pb-0/.test(p));
  assert.match(p, /className="surface-dark hero-band"/);
  assert.match(rule(css(), ".hero-band"), /padding-bottom:\s*clamp\(/);
});

test("E: the result is its own block: one figure, one label, a footnote link outside the h1 (W34)", () => {
  const p = read("src/app/(site)/page.tsx");
  assert.match(p, /className="hero-result/);
  assert.match(p, /hero-result-figure/);
  assert.match(p, /result\.resultLabel/);
  assert.ok(!/result\.resultLead/.test(p), "the inline sentence is gone");
  assert.match(p, /href="#own-result"/);
  assert.match(p, /Our own average/);
  assert.ok(p.indexOf("</h1>") < p.indexOf("hero-result"), "result block is a sibling after the h1");
  assert.match(p, /sr-only/, "the arrow figure has a spoken form");
});

test("E: resultLabel wording, and it makes no read claim", async () => {
  const { OWN_RESULTS_AVERAGE: r } = await import("../../src/lib/site/proof.ts");
  assert.equal(r.resultLabel, "of booked clients turned up, before and after WhatsApp reminders");
  assert.ok(!/\bread|\bopen/i.test(r.resultLabel));
});

test("E: the WhatsApp phone shows an earlier booking exchange, the SMS phone only the unanswered reminder", () => {
  const t = read(`${DIR}/SameReminderTwice.tsx`);
  const sms = t.slice(t.indexOf('variant="sms"'), t.indexOf('variant="whatsapp"'));
  const wa = t.slice(t.indexOf('variant="whatsapp"'));
  assert.ok(!/Monday/.test(sms), "no history on the SMS phone");
  assert.match(sms, /No reply/);
  assert.match(wa, /Monday/);
  assert.match(wa, /BOOKING_ASK/);
  assert.match(wa, /BOOKING_CONFIRM/);
  assert.ok(wa.indexOf("Monday") < wa.indexOf("Yesterday"), "history comes first");
  assert.ok(wa.indexOf("Yesterday") < wa.indexOf("{REMINDER}"));
  const label = t.match(/const LABEL = `([^`]*)`/)![1];
  assert.match(label, /earlier/i);
});

test("E: no blue read ticks, no WhatsApp green in the phone files", () => {
  const all = ["SameReminderTwice", "Ticks", "GroupChatSample"].map((n) => read(`${DIR}/${n}.tsx`)).join("\n");
  assert.ok(!/#(25D366|34B7F1|53BDEB)/i.test(all));
});

test("E: FeatureList mounts GroupChatSample for the group visual and the TODO is gone", async () => {
  const f = read("src/components/site/FeatureList.tsx");
  assert.ok(!/TODO/.test(f));
  assert.match(f, /import \{ GroupChatSample \} from "@\/components\/site\/samples\/GroupChatSample"/);
  assert.match(f, /feature\.visual === "group"/);
  assert.match(f, /<GroupChatSample/);
});

test("E: the group visual exists only while groupsLive is true; Coming soon stays text-only", async () => {
  const { featureEntriesFor, FEATURES } = await import("../../src/lib/site/features.ts");
  const brand = { name: "Testbrand" } as never;
  assert.equal(FEATURES.groupsLive, false);
  const off = featureEntriesFor({ groupsLive: false, dndSyncLive: false, mediaLive: false }, brand).find((e) => e.id === "groups")!;
  assert.equal(off.visual, undefined);
  assert.equal(off.soon, true);
  const on = featureEntriesFor({ groupsLive: true, dndSyncLive: true, mediaLive: true }, brand).find((e) => e.id === "groups")!;
  assert.equal(on.visual, "group");
});
