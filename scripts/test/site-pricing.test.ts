import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pricingCopy } from "@/lib/site/pricing-copy";
import {
  CALCULATOR_PRESETS,
  formatMoney,
  monthlyCost,
  monthlyCostPence,
  MAX_NUMBERS_PER_SUB_ACCOUNT,
  PRICE_PER_NUMBER_PENCE,
  pricePerNumber,
  priceLine,
  priceSentence,
  pricingConfig,
} from "@/lib/pricing";

const brand = { currency: "GBP" };

test("one flat price per WhatsApp number: 799p, no tiers (Charlie, Nov 2026); up to 3 numbers per sub-account", () => {
  assert.equal(PRICE_PER_NUMBER_PENCE, 799);
  assert.equal(MAX_NUMBERS_PER_SUB_ACCOUNT, 3);
  assert.equal(pricePerNumber("GBP"), "£7.99");
});

test("monthlyCostPence: n numbers x 799p at every size (no volume tiers)", () => {
  const cases: [number, number][] = [
    [1, 799],
    [3, 2397],
    [5, 3995],
    [10, 7990],
    [11, 8789],
    [25, 19975],
  ];
  for (const [n, pence] of cases) assert.equal(monthlyCostPence(n), pence, `${n} numbers`);
  assert.equal(monthlyCostPence(0), 0);
  assert.equal(monthlyCostPence(-2), 0);
  assert.equal(monthlyCostPence(2.7), 1598);
  assert.equal(monthlyCostPence(Number.NaN), 0);
  assert.equal(monthlyCostPence(Infinity), 0);
});

test("monthlyCost returns pounds from whole pence, with no float drift", () => {
  assert.equal(monthlyCost(3), 23.97);
  assert.equal(monthlyCost(10), 79.9);
  assert.equal(monthlyCost(25), 199.75);
});

test("formatMoney always shows pence: '£9.99', '£79.90', '£0.00'; EUR contains '€'", () => {
  assert.equal(formatMoney(9.99, "GBP"), "£9.99");
  assert.equal(formatMoney(79.9, "GBP"), "£79.90");
  assert.equal(formatMoney(869, "GBP"), "£869.00");
  assert.equal(formatMoney(0, "GBP"), "£0.00");
  assert.ok(formatMoney(145, "EUR").includes("€"));
});

test("priceLine singular/plural: '1 number = £7.99/month', '25 numbers = £199.75/month'", () => {
  assert.equal(priceLine(1, brand), "1 number = £7.99/month");
  assert.equal(priceLine(5, brand), "5 numbers = £39.95/month");
  assert.equal(priceLine(25, brand), "25 numbers = £199.75/month");
});

test("priceSentence states the one price plainly, the 3-per-sub-account limit, and no tiers", () => {
  assert.equal(
    priceSentence("GBP"),
    "£7.99 a month for each WhatsApp number you connect, up to 3 per sub-account. Every number costs the same, however many you run.",
  );
});

test("CALCULATOR_PRESETS is [1,3,10,25]", () => {
  assert.deepEqual([...CALCULATOR_PRESETS], [1, 3, 10, 25]);
});

test("pricingConfig is GBP and reads no environment variable", () => {
  const before = process.env.BRAND_PRICE_PER_NUMBER;
  delete process.env.BRAND_PRICE_PER_NUMBER;
  try {
    assert.deepEqual(pricingConfig(), { currency: "GBP" });
  } finally {
    if (before !== undefined) process.env.BRAND_PRICE_PER_NUMBER = before;
  }
  assert.ok(!/BRAND_PRICE_PER_NUMBER|BRAND_CURRENCY/.test(readFileSync(join(process.cwd(), "src/lib/pricing.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
});

test("BRAND_PRICE_PER_NUMBER is retired everywhere outside history docs", () => {
  for (const f of ["README.md", "docs/GO-LIVE-FOUNDATION.md", "scripts/site-walkthrough.cjs"]) {
    assert.ok(!/BRAND_PRICE_PER_NUMBER/.test(readFileSync(join(process.cwd(), f), "utf8")), f);
  }
});

test("pricingCopy trial terms mention 7 days, card and 3 sub-accounts", () => {
  const c = pricingCopy();
  const terms = c.trialTerms.join(" ");
  assert.match(terms, /7-day/);
  assert.match(terms, /card/i);
  assert.match(terms, /3 sub-accounts/);
  assert.match(c.cancel, /any time/i);
  assert.match(c.cancel, /end of/i);
  assert.match(c.cancel, /billing portal/i);
  const failed = c.failedPayment.join(" ");
  assert.match(failed, /retr/i);
  assert.match(failed, /continues/i);
  assert.match(failed, /banner/i);
  assert.match(failed, /pauses/i);
});

test("calculator fallback table lists 1, 3, 5, 10 and 25 numbers", () => {
  const src = readFileSync(join(process.cwd(), "src/components/site/PricingTable.tsx"), "utf8");
  assert.match(src, /CALCULATOR_PRESETS\s*\.map|CALCULATOR_PRESETS\.map/);
  assert.ok(src.includes("<noscript"));
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

test("marketing code has no client JS beyond the islands", () => {
  const allowed = new Set(["PricingCalculator.tsx", "AudienceTabs.tsx", "PrintButton.tsx", "ResaleCalculator.tsx"]);
  const files = [...walk("src/app/(site)"), ...walk("src/components/site")].filter((f) => /\.tsx?$/.test(f));
  const clients = files
    .filter((f) => /^\s*["']use client["']/m.test(readFileSync(f, "utf8")))
    .map((f) => basename(f));
  for (const c of clients) assert.ok(allowed.has(c), `${c} is an unexpected client island`);
});

import { calculatorDisplay, CALC_MIN, CALC_MAX } from "@/lib/site/calculator";

test("calculatorDisplay: valid, out of range, fractional and empty input", () => {
  assert.equal(CALC_MIN, 1);
  assert.equal(CALC_MAX, 500);
  assert.deepEqual(calculatorDisplay("5", brand), { line: "5 numbers = £39.95/month", note: null, empty: false });
  const hi = calculatorDisplay("600", brand);
  assert.equal(hi.line, "500 numbers = £3,995.00/month");
  assert.match(hi.note ?? "", /whole number from 1 to 500/);
  const lo = calculatorDisplay("0", brand);
  assert.equal(lo.line, "1 number = £7.99/month");
  assert.ok(lo.note);
  assert.equal(calculatorDisplay("2.7", brand).line, "2 numbers = £15.98/month");
  assert.ok(calculatorDisplay("2.7", brand).note);
  assert.equal(calculatorDisplay("-3", brand).line, "1 number = £7.99/month");
  const empty = calculatorDisplay("", brand);
  assert.equal(empty.empty, true);
  assert.equal(empty.line, "");
  assert.ok(empty.note);
});

// Task 13C additions.
import { calculatorValue } from "@/lib/site/calculator";

test("calculatorValue mirrors calculatorDisplay", () => {
  assert.deepEqual(calculatorValue("5"), { n: 5, note: null, empty: false });
  const hi = calculatorValue("600");
  assert.equal(hi.n, 500);
  assert.match(hi.note ?? "", /Showing the price for 500/);
  const lo = calculatorValue("0");
  assert.equal(lo.n, 1);
  assert.ok(lo.note);
  assert.equal(calculatorValue("2.7").n, 2);
  const empty = calculatorValue("");
  assert.equal(empty.empty, true);
  assert.ok(empty.note);
});

test("pricing page has no Card kit; fallback has no table; calculator is labelled and live", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(site)/pricing/page.tsx"), "utf8");
  assert.doesNotMatch(page, /@\/components\/ui\/Card/);
  const table = readFileSync(join(process.cwd(), "src/components/site/PricingTable.tsx"), "utf8");
  assert.doesNotMatch(table, /<table/);
  const calc = readFileSync(join(process.cwd(), "src/components/site/PricingCalculator.tsx"), "utf8");
  assert.ok(calc.includes('aria-live="polite"'));
  assert.ok(calc.includes("htmlFor"));
});

test("pricing copy: one trial paragraph that bills per WhatsApp number", () => {
  const c = pricingCopy();
  assert.equal(c.trialTerms.length, 1);
  assert.match(c.trialTerms[0], /for each WhatsApp number you connect/);
  assert.doesNotMatch(c.trialTerms[0], /per activated sub-account|tier you reach/);
  assert.match(c.trialTerms[0], /7-day free trial, no card needed/);
  assert.match(c.trialTerms[0], /sending pauses until you add one/);
  assert.doesNotMatch(c.trialTerms[0], /take a card/);
  assert.equal(c.failedPayment.length, 2);
});

test("pricing page: one big per-number price, the price sentence and the price list; calculator takes no price prop", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(site)/pricing/page.tsx"), "utf8");
  assert.match(page, /pricePerNumber\(/);
  assert.match(page, /priceSentence\(/);
  assert.match(page, /<TierList/);
  assert.match(page, /per WhatsApp number, per month/);
  const calc = readFileSync(join(process.cwd(), "src/components/site/PricingCalculator.tsx"), "utf8");
  assert.ok(!/pricePerNumber|PRICE_PER_NUMBER/.test(calc), "the calculator gets its price from monthlyCost, never a prop");
});

test("the price lives in code: BRAND_PRICE_PER_NUMBER / BRAND_PRICE are not read anywhere in src or scripts", () => {
  for (const f of [...walk("src"), ...walk("scripts")].filter((f) => /\.(tsx?|cjs)$/.test(f) && !f.endsWith("site-pricing.test.ts"))) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/BRAND_PRICE_PER_NUMBER|BRAND_PRICE\b/.test(text), f);
  }
});

test("no page still advertises the old tiers or per-sub-account pricing", () => {
  for (const f of [...walk("src/app"), ...walk("src/components"), ...walk("src/lib/site")].filter((f) => /\.tsx?$/.test(f))) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/£9\.99|£5\.99|tier you reach|numbers included|per activated sub-account/.test(text), f);
  }
});

