import { priceLine, type PricingConfig } from "@/lib/pricing";

export const CALC_MIN = 1;
export const CALC_MAX = 500;

export interface CalculatorDisplay {
  /** The price line, clamped to CALC_MIN..CALC_MAX; empty while the field is empty. */
  line: string;
  /** Help sentence when the input is empty, out of range or not whole; announced with the price. */
  note: string | null;
  /** True while the field is empty ("no price yet"). */
  empty: boolean;
}

const HELP = `Enter a whole number from ${CALC_MIN} to ${CALC_MAX}.`;

export interface CalculatorValue {
  /** The clamped count, CALC_MIN..CALC_MAX (CALC_MIN while the field is empty). */
  n: number;
  note: string | null;
  empty: boolean;
}

/** Clamp the raw field text and say what to tell the visitor. Pure. */
export function calculatorValue(raw: string): CalculatorValue {
  if (raw.trim() === "") return { n: CALC_MIN, note: HELP, empty: true };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { n: CALC_MIN, note: HELP, empty: true };
  const n = Math.min(CALC_MAX, Math.max(CALC_MIN, Math.floor(value)));
  const exact = Number.isInteger(value) && value >= CALC_MIN && value <= CALC_MAX;
  return { n, note: exact ? null : `${HELP} Showing the price for ${n}.`, empty: false };
}

/** Decide what the calculator shows for the raw field text. Pure. */
export function calculatorDisplay(raw: string, pricing: PricingConfig): CalculatorDisplay {
  const { n, note, empty } = calculatorValue(raw);
  return { line: empty ? "" : priceLine(n, pricing), note, empty };
}
