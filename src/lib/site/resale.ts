import { formatMoney, monthlyCostPence, perNumberPence } from "@/lib/pricing";
import { CALC_MAX, CALC_MIN, calculatorValue } from "@/lib/site/calculator";

/** The agency resale calculator's logic. Pure; whole pence throughout. */

export const RESALE_DEFAULT_NUMBERS = "10";
/** Charlie's own figure: what agencies typically charge a client per number. An example, never a promise. */
export const RESALE_DEFAULT_PRICE = "50";
export const RESALE_EXAMPLE_PRICE_PENCE = 5000;
export const RESALE_EXAMPLE_COUNTS = [1, 5, 10, 25] as const;
/** Upper bound on the price field, in pounds, so a typo cannot print a silly figure. */
export const RESALE_PRICE_MAX = 1000;

const PRICE_HELP = `Enter a price per number, from 0 to ${RESALE_PRICE_MAX}. Pence are fine, like 19.99.`;

export interface ParsedPrice {
  /** Whole pence, or null when the text is blank or unusable. */
  pence: number | null;
  note: string | null;
}

/** Read the price field. Accepts "50", "19.99", "£45"; extra decimal places round to the penny. */
export function parseResalePrice(raw: string): ParsedPrice {
  const text = raw.trim().replace(/^£\s*/, "").replace(/,/g, "");
  if (text === "") return { pence: null, note: PRICE_HELP };
  if (!/^\d+(\.\d*)?$/.test(text)) return { pence: null, note: PRICE_HELP };
  const [whole, frac = ""] = text.split(".");
  const pounds = Number(whole);
  if (!Number.isFinite(pounds) || pounds > RESALE_PRICE_MAX) return { pence: null, note: PRICE_HELP };
  const digits = (frac + "00").slice(0, 2);
  let pence = pounds * 100 + Number(digits);
  const extra = frac.slice(2);
  const rounded = extra !== "" && Number(extra[0]) >= 5;
  if (rounded) pence += 1;
  if (pence > RESALE_PRICE_MAX * 100) return { pence: null, note: PRICE_HELP };
  const note = extra !== "" && /[1-9]/.test(extra) ? `Rounded to the nearest penny.` : null;
  return { pence, note };
}

export interface ResaleFigures {
  numbers: number;
  pricePence: number;
  revenuePence: number;
  costPence: number;
  /** Can be negative: reselling below our price loses money, and the page says so. */
  keepPence: number;
  keepYearPence: number;
}

export function resaleFigures(numbers: number, pricePence: number): ResaleFigures {
  const revenuePence = numbers * pricePence;
  const costPence = monthlyCostPence(numbers);
  const keepPence = revenuePence - costPence;
  return { numbers, pricePence, revenuePence, costPence, keepPence, keepYearPence: keepPence * 12 };
}

/** "£500" for whole pounds, "£79.90" otherwise: the way a person would say it. */
function pounds(pence: number, currency: string): string {
  const abs = Math.abs(pence);
  const text = formatMoney(abs / 100, currency);
  return abs % 100 === 0 ? text.replace(/\.00$/, "") : text;
}

export interface ResaleView {
  figures: ResaleFigures | null;
  /** The output, one sentence each; null until both fields are usable. */
  sentences: string[] | null;
  numbersNote: string | null;
  priceNote: string | null;
  /** Set when the price is at or below what the agency pays us per number. */
  warning: string | null;
  numbersEmpty: boolean;
  priceInvalid: boolean;
}

export function resaleView(rawNumbers: string, rawPrice: string, currency: string): ResaleView {
  const count = calculatorValue(rawNumbers);
  const price = parseResalePrice(rawPrice);
  const priceInvalid = price.pence === null;
  const base = {
    numbersNote: count.note,
    priceNote: price.note,
    numbersEmpty: count.empty,
    priceInvalid,
  };
  if (count.empty || price.pence === null) return { ...base, figures: null, sentences: null, warning: null };
  const f = resaleFigures(count.n, price.pence);
  const keepLine =
    f.keepPence > 0
      ? `You keep ${pounds(f.keepPence, currency)} a month (${pounds(f.keepYearPence, currency)} a year).`
      : f.keepPence === 0
        ? `You keep nothing: your price only covers what you pay us.`
        : `You lose ${pounds(f.keepPence, currency)} a month (${pounds(f.keepYearPence, currency)} a year).`;
  const ours = perNumberPence(f.numbers);
  const warning =
    price.pence < ours
      ? `That is below the ${pounds(ours, currency)} a month you pay us for each number at this size, so each number costs you money.`
      : null;
  return {
    ...base,
    figures: f,
    sentences: [
      `Your clients pay you ${pounds(f.revenuePence, currency)} a month.`,
      `You pay us ${pounds(f.costPence, currency)}.`,
      keepLine,
    ],
    warning,
  };
}

/** What you'd keep at the example price, for the no-JavaScript line. */
export function resaleExamples(currency: string): { numbers: number; keep: string }[] {
  return RESALE_EXAMPLE_COUNTS.map((n) => ({
    numbers: n,
    keep: pounds(resaleFigures(n, RESALE_EXAMPLE_PRICE_PENCE).keepPence, currency),
  }));
}

/** The example resale price as text, e.g. "£50". */
export function resaleExamplePrice(currency: string): string {
  return pounds(RESALE_EXAMPLE_PRICE_PENCE, currency);
}

export function resaleFallbackLine(currency: string): string {
  const ex = resaleExamples(currency).map((e) => `${e.keep} with ${e.numbers}`);
  const list = `${ex.slice(0, -1).join(", ")} and ${ex[ex.length - 1]}`;
  return `For example, at ${pounds(RESALE_EXAMPLE_PRICE_PENCE, currency)} a number you would keep ${list} numbers, each month.`;
}

export { CALC_MAX as RESALE_MAX_NUMBERS, CALC_MIN as RESALE_MIN_NUMBERS };
