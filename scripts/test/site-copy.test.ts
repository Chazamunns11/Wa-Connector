import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BrandConfig } from "@/lib/brand-config";
import { FAQ_IDS, HOME_FAQ_IDS, faqEntries } from "@/lib/site/faq";
import { salesCopy } from "@/lib/site/sales-copy";

const brand: BrandConfig = {
  name: "Testbrand",
  tagline: "Tagline",
  supportEmail: null,
  supportWhatsApp: null,
  logoPath: null,
  accent: null,
  appUrl: "http://localhost:3000",
};

test("faqEntries returns FAQ_IDS in order with non-empty answers", () => {
  const entries = faqEntries(brand);
  assert.deepEqual(
    entries.map((e) => e.id),
    [...FAQ_IDS],
  );
  for (const e of entries) {
    assert.ok(e.question.trim().length > 0, e.id);
    assert.ok(e.answer.trim().length > 0, e.id);
  }
  assert.ok(entries.some((e) => e.answer.includes("Testbrand")));
});

test("ban-risk answer mentions restriction and cannot promise safety", () => {
  const a = faqEntries(brand).find((e) => e.id === "ban-risk")!.answer;
  assert.match(a, /ban|restrict/i);
  assert.match(a, /can't|cannot/);
  assert.match(a, /dedicated/i);
});

test("official-api answer says linked device and not the official Business API", () => {
  const a = faqEntries(brand).find((e) => e.id === "official-api")!.answer;
  assert.match(a, /linked.device/i);
  assert.match(a, /not the official WhatsApp Business API/i);
  assert.match(a, /verified badge/i);
});

test("daily-cap, stop and white-label answers state the real behaviour", () => {
  const get = (id: string) => faqEntries(brand).find((e) => e.id === id)!.answer;
  assert.match(get("daily-cap"), /reported back to GoHighLevel as not sent/);
  assert.match(get("daily-cap"), /midnight \(UTC\)/);
  assert.match(get("stop"), /from that number/);
  assert.match(get("white-label"), /It depends on the agency/);
  assert.match(get("white-label"), /ask your agency to allow Testbrand/);
  assert.match(get("trial"), /After that you pay per number: 1 number = /);
  assert.ok(!salesCopy(brand).safety.some((s) => /from your account/.test(s.body)));
});

// Task 13: salesCopy is the home page's voice: setup steps moved under `setup`, hook and keepWorkflows are gone.
test("salesCopy has 3 setup steps, the three safety items and the disclosure block", () => {
  const c = salesCopy(brand);
  assert.equal(c.setup.steps.length, 3);
  assert.equal(c.safety.length, 3);
  assert.equal(c.disclosure.paragraphs.length, 3);
  assert.equal(c.why.paragraphs.length, 2);
  const titles = c.safety.map((s) => s.title.toLowerCase()).join("|");
  assert.match(titles, /pac/);
  assert.match(titles, /held|disconnect/);
  assert.match(titles, /stop/);
  assert.equal(c.ctaLabel, "Start 7-day free trial");
});

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

test("the brand name appears at most once per string in sales copy", () => {
  for (const s of strings(salesCopy(brand))) {
    assert.ok((s.match(/Testbrand/g) ?? []).length <= 1, s);
  }
});

test("sales copy has no staccato fragments", () => {
  for (const s of strings(salesCopy(brand))) {
    assert.ok(!/^Card needed|^Cancel any time\.$/.test(s), s);
  }
});

test("the disclosure block says the uncomfortable things once, plainly", () => {
  const d = salesCopy(brand).disclosure.paragraphs.join(" ");
  assert.match(d, /linked device/);
  assert.match(d, /not the official WhatsApp Business API/);
  assert.match(d, /restrict or ban/);
  assert.match(d, /can't promise/);
  assert.match(d, /dedicated business number/);
  const stop = salesCopy(brand).safety[2].body;
  assert.match(stop, /from that number/);
  assert.ok(!/from your account/.test(stop));
});

test("home FAQ ids are a subset of the twelve and leave out what the disclosure block says", () => {
  for (const id of HOME_FAQ_IDS) assert.ok((FAQ_IDS as readonly string[]).includes(id), id);
  assert.ok(!(HOME_FAQ_IDS as readonly string[]).includes("ban-risk"));
  assert.ok(!(HOME_FAQ_IDS as readonly string[]).includes("official-api"));
  assert.equal(HOME_FAQ_IDS.length, 7);
});

test("copy says GoHighLevel, not GHL, in customer-facing strings", () => {
  for (const s of strings(salesCopy(brand))) assert.ok(!/\bGHL\b/.test(s), s);
  for (const e of faqEntries(brand)) assert.ok(!/\bGHL\b/.test(e.answer), e.id);
  assert.ok(!/GHL/.test(readFileSync(join(process.cwd(), "src/components/site/samples/DashboardSample.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
});

const WEBSITE_ROOTS = [
  "src/app/(site)",
  "src/app/(app)",
  "src/components/site",
  "src/components/app",
  "src/components/auth",
  "src/lib/site",
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === "/" && next === "/" && source[i - 1] !== ":") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function websiteSources(): { file: string; text: string }[] {
  return WEBSITE_ROOTS.flatMap((r) => walk(r)).map((file) => ({
    file,
    text: stripComments(readFileSync(file, "utf8")),
  }));
}

test("sales page sources carry no invented proof", () => {
  const re = /testimonial|trusted by|★|\d+%|\d+,\d{3}\+? (users|agencies|messages)|as seen in/i;
  // proof.ts is the one place percentages may live (Ruling W25: cited research only; see site-proof.test.ts).
  // It is still held to every other check.
  const pct = /testimonial|trusted by|★|\d+,\d{3}\+? (users|agencies|messages)|as seen in/i;
  const hits = websiteSources()
    .filter((s) => (s.file.endsWith("src/lib/site/proof.ts") ? pct : re).test(s.text))
    .map((s) => s.file);
  assert.deepEqual(hits, []);
});

test("no literal currency or price outside src/lib/pricing.ts", () => {
  const re = /[£€$]\s?\d/;
  // Task 13C: comparison.ts quotes HighLevel's own USD figures verbatim (W33); it is the one exception.
  const hits = websiteSources()
    .filter((s) => !s.file.endsWith("src/lib/site/comparison.ts"))
    .filter((s) => re.test(s.text))
    .map((s) => s.file);
  assert.deepEqual(hits, []);
});
