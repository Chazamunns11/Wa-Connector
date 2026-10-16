import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pricingCopy } from "@/lib/site/pricing-copy";
import {
  CALCULATOR_PRESETS,
  formatMoney,
  monthlyCost,
  priceLine,
  pricingConfig,
} from "@/lib/pricing";

const KEYS = ["BRAND_PRICE_PER_NUMBER", "BRAND_CURRENCY", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const setProd = () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
};

const brand = { pricePerNumber: 29, currency: "GBP" };

test("monthlyCost(5, 29) = 145; (0) = 0; (-2) = 0; (2.7) = 58", () => {
  assert.equal(monthlyCost(5, 29), 145);
  assert.equal(monthlyCost(0, 29), 0);
  assert.equal(monthlyCost(-2, 29), 0);
  assert.equal(monthlyCost(2.7, 29), 58);
  assert.equal(monthlyCost(Number.NaN, 29), 0);
  assert.equal(monthlyCost(Infinity, 29), 0);
});

test("formatMoney(145,'GBP') = '£145'; (35.5,'GBP') = '£35.50'; (145,'EUR') contains '€'", () => {
  assert.equal(formatMoney(145, "GBP"), "£145");
  assert.equal(formatMoney(35.5, "GBP"), "£35.50");
  assert.ok(formatMoney(145, "EUR").includes("€"));
});

test("priceLine singular/plural: '1 number = £29/month', '5 numbers = £145/month'", () => {
  assert.equal(priceLine(1, brand), "1 number = £29/month");
  assert.equal(priceLine(5, brand), "5 numbers = £145/month");
});

test("CALCULATOR_PRESETS is [1,3,5,10,25]", () => {
  assert.deepEqual([...CALCULATOR_PRESETS], [1, 3, 5, 10, 25]);
});

test("pricingConfig defaults: 29 GBP", () => {
  for (const k of KEYS) delete process.env[k];
  assert.deepEqual(pricingConfig(), { pricePerNumber: 29, currency: "GBP" });
});

test("BRAND_PRICE_PER_NUMBER '35.50' parses to 35.5 and BRAND_CURRENCY lower-case is upper-cased", () => {
  process.env.BRAND_PRICE_PER_NUMBER = "35.50";
  process.env.BRAND_CURRENCY = "eur";
  assert.deepEqual(pricingConfig(), { pricePerNumber: 35.5, currency: "EUR" });
});

test("production with BRAND_PRICE_PER_NUMBER unset or blank throws", () => {
  setProd();
  delete process.env.BRAND_PRICE_PER_NUMBER;
  assert.throws(() => pricingConfig(), /BRAND_PRICE_PER_NUMBER must be a number/);
  process.env.BRAND_PRICE_PER_NUMBER = "  ";
  assert.throws(() => pricingConfig(), /BRAND_PRICE_PER_NUMBER must be a number/);
});

test("BRAND_PRICE_PER_NUMBER 'abc', '0x10', '-0' throw in any env", () => {
  for (const prod of [false, true]) {
    if (prod) setProd();
    for (const bad of ["abc", "0x10", "-0", "-5", "1e3"]) {
      process.env.BRAND_PRICE_PER_NUMBER = bad;
      assert.throws(() => pricingConfig(), /BRAND_PRICE_PER_NUMBER must be a number/, bad);
    }
  }
});

test("invalid BRAND_CURRENCY throws", () => {
  process.env.BRAND_PRICE_PER_NUMBER = "29";
  for (const bad of ["pounds", "G1P", "ZZZZ", "us", "AAA1"]) {
    process.env.BRAND_CURRENCY = bad;
    assert.throws(() => pricingConfig(), /BRAND_CURRENCY must be an ISO 4217 code/, bad);
  }
});

test("pricingCopy trial terms mention 7 days, card and 3 numbers", () => {
  const c = pricingCopy();
  const terms = c.trialTerms.join(" ");
  assert.match(terms, /7-day/);
  assert.match(terms, /card/i);
  assert.match(terms, /3 numbers/);
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

test("marketing code has no client JS beyond the two islands", () => {
  const allowed = new Set(["PricingCalculator.tsx", "AudienceTabs.tsx"]);
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
  assert.deepEqual(calculatorDisplay("5", brand), { line: "5 numbers = £145/month", note: null, empty: false });
  const hi = calculatorDisplay("600", brand);
  assert.equal(hi.line, "500 numbers = £14,500/month");
  assert.match(hi.note ?? "", /whole number from 1 to 500/);
  const lo = calculatorDisplay("0", brand);
  assert.equal(lo.line, "1 number = £29/month");
  assert.ok(lo.note);
  assert.equal(calculatorDisplay("2.7", brand).line, "2 numbers = £58/month");
  assert.ok(calculatorDisplay("2.7", brand).note);
  assert.equal(calculatorDisplay("-3", brand).line, "1 number = £29/month");
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

test("pricing copy follows the deck: one trial paragraph with 'per active number'", () => {
  const c = pricingCopy();
  assert.equal(c.trialTerms.length, 1);
  assert.match(c.trialTerms[0], /per active number/);
  assert.match(c.trialTerms[0], /charge nothing until the trial ends/);
  assert.equal(c.failedPayment.length, 2);
});
