import type { BrandConfig } from "@/lib/brand-config";

export const TRIAL_DAYS = 7;
export const TRIAL_MAX_NUMBERS = 3;
export const CALCULATOR_PRESETS = [1, 3, 5, 10, 25] as const;

/** Monthly cost for `numbers` WhatsApp numbers. Invalid input costs 0; fractions floor. */
export function monthlyCost(numbers: number, pricePerNumber: number): number {
  if (!Number.isFinite(numbers) || numbers < 0) return 0;
  return Math.floor(numbers) * pricePerNumber;
}

/** en-GB currency string: no decimals for whole amounts, two otherwise. */
export function formatMoney(amount: number, currency: string): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

/** e.g. "5 numbers = £145/month"; "1 number = £29/month". */
export function priceLine(numbers: number, brand: BrandConfig): string {
  const n = Number.isFinite(numbers) && numbers > 0 ? Math.floor(numbers) : 0;
  const cost = formatMoney(monthlyCost(n, brand.pricePerNumber), brand.currency);
  return `${n} ${n === 1 ? "number" : "numbers"} = ${cost}/month`;
}
