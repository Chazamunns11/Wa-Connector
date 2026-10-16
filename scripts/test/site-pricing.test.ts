import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALCULATOR_PRESETS,
  formatMoney,
  monthlyCost,
  priceLine,
} from "@/lib/pricing";
import type { BrandConfig } from "@/lib/brand-config";

const brand = { pricePerNumber: 29, currency: "GBP" } as BrandConfig;

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
