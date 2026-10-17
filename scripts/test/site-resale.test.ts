import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RESALE_DEFAULT_NUMBERS,
  RESALE_DEFAULT_PRICE,
  RESALE_PRICE_MAX,
  parseResalePrice,
  resaleExamples,
  resaleFallbackLine,
  resaleFigures,
  resaleView,
} from "@/lib/site/resale";
import { faqEntries } from "@/lib/site/faq";
import { monthlyCostPence } from "@/lib/pricing";

const GBP = "GBP";
const brand = { name: "Testbrand" } as never;

test("defaults: 10 numbers at 50 pounds", () => {
  assert.equal(RESALE_DEFAULT_NUMBERS, "10");
  assert.equal(RESALE_DEFAULT_PRICE, "50");
});

test("W41 examples at 50 pounds: keep 40.01, 200.05, 400.10 and 1,100.25 a month", () => {
  const cases: [number, number][] = [
    [1, 4001],
    [5, 20005],
    [10, 40010],
    [25, 110025],
  ];
  for (const [n, keep] of cases) {
    const f = resaleFigures(n, 5000);
    assert.equal(f.keepPence, keep, `${n} numbers`);
    assert.equal(f.costPence, monthlyCostPence(n));
    assert.equal(f.revenuePence, n * 5000);
    assert.equal(f.keepYearPence, keep * 12);
  }
});

test("the 10-number sentence is the owner's, word for word", () => {
  const v = resaleView("10", "50", GBP);
  assert.equal(
    v.sentences?.join(" "),
    "Your clients pay you £500 a month. You pay us £99.90. You keep £400.10 a month (£4,801.20 a year).",
  );
  assert.equal(v.numbersNote, null);
  assert.equal(v.priceNote, null);
  assert.equal(v.warning, null);
});

test("blank or unreadable fields show no figures and say what to enter", () => {
  const a = resaleView("", "50", GBP);
  assert.equal(a.sentences, null);
  assert.match(a.numbersNote ?? "", /whole number/i);
  const b = resaleView("10", "", GBP);
  assert.equal(b.sentences, null);
  assert.match(b.priceNote ?? "", /price/i);
  const c = resaleView("10", "abc", GBP);
  assert.equal(c.sentences, null);
  assert.ok(c.priceNote);
});

test("zero numbers clamps to 1 and says so; 501 clamps to 500", () => {
  const z = resaleView("0", "50", GBP);
  assert.match(z.numbersNote ?? "", /1/);
  assert.ok(z.sentences);
  assert.equal(z.figures?.numbers, 1);
  const m = resaleView("501", "50", GBP);
  assert.equal(m.figures?.numbers, 500);
  assert.match(m.numbersNote ?? "", /500/);
  assert.equal(resaleView("500", "50", GBP).numbersNote, null);
});

test("price accepts decimals, a leading currency sign and rounds extra digits to the penny", () => {
  assert.equal(parseResalePrice("19.99").pence, 1999);
  assert.equal(parseResalePrice("£45").pence, 4500);
  assert.equal(parseResalePrice(" 12.5 ").pence, 1250);
  assert.equal(parseResalePrice("0.1").pence, 10);
  const r = parseResalePrice("10.005");
  assert.equal(r.pence, 1001);
  assert.ok(r.note);
  assert.equal(parseResalePrice("0").pence, 0);
  assert.equal(parseResalePrice("-5").pence, null);
  assert.ok(parseResalePrice("-5").note);
  assert.equal(parseResalePrice(String(RESALE_PRICE_MAX + 1)).pence, null);
  assert.equal(parseResalePrice(String(RESALE_PRICE_MAX)).pence, RESALE_PRICE_MAX * 100);
});

test("a resale price below ours shows a negative margin honestly", () => {
  const v = resaleView("10", "5", GBP);
  assert.equal(v.figures?.keepPence, 10 * 500 - 9990);
  assert.match(v.sentences?.join(" ") ?? "", /lose/i);
  assert.match(v.sentences?.join(" ") ?? "", /£49\.90 a month/);
  assert.match(v.sentences?.join(" ") ?? "", /£598\.80 a year/);
  assert.ok(v.warning, "warns that the price is below ours");
  assert.match(v.warning ?? "", /£9\.99/);
});

test("a price of nothing: you pay us, you keep nothing and lose the lot", () => {
  const v = resaleView("1", "0", GBP);
  assert.equal(v.figures?.keepPence, -999);
  assert.ok(v.warning);
});

test("break even says so", () => {
  const v = resaleView("10", "9.99", GBP);
  assert.equal(v.figures?.keepPence, 0);
  assert.match(v.sentences?.join(" ") ?? "", /nothing/i);
});

test("fallback line and examples at 50 pounds", () => {
  const ex = resaleExamples(GBP);
  assert.deepEqual(
    ex.map((e) => [e.numbers, e.keep]),
    [
      [1, "£40.01"],
      [5, "£200.05"],
      [10, "£400.10"],
      [25, "£1,100.25"],
    ],
  );
  const line = resaleFallbackLine(GBP);
  for (const s of ["£50", "£40.01", "£200.05", "£400.10", "£1,100.25"]) assert.ok(line.includes(s), s);
  assert.match(line, /example/i);
});

test("copy never promises income", () => {
  const v = resaleView("10", "50", GBP);
  const all = [...(v.sentences ?? []), resaleFallbackLine(GBP)].join(" ");
  assert.ok(!/guarantee|earn|profit|passive/i.test(all));
});

test("agency FAQ answer points to the calculator", () => {
  const e = faqEntries(brand).find((x) => x.id === "agency-or-single")!;
  assert.equal(e.link?.href, "/pricing#resale");
  assert.match(e.answer, /resell/i);
});

test("pricing page has the resale section, the home strip points to it, and the section is anchored", () => {
  const page = readFileSync("src/app/(site)/pricing/page.tsx", "utf8");
  assert.match(page, /<ResaleCalculator/);
  assert.match(page, /id="resale"/);
  const strip = readFileSync("src/components/site/PricingSummary.tsx", "utf8");
  assert.match(strip, /#resale/);
});
