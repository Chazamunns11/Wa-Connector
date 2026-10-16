import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
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
