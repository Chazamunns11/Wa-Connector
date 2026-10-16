export interface PricingConfig {
  /** BRAND_PRICE_PER_NUMBER, a decimal in major units; dev default 29. */
  pricePerNumber: number;
  /** BRAND_CURRENCY, ISO 4217 upper-case; default "GBP". */
  currency: string;
}

const DEV_PRICE_PER_NUMBER = 29;
const DEFAULT_CURRENCY = "GBP";

/**
 * Website pricing from env, read at call time. Deliberately separate from
 * brandConfig() so a missing price can never break modules that read the
 * brand at load (e.g. GHL message sending).
 */
export function pricingConfig(): PricingConfig {
  const raw = process.env.BRAND_PRICE_PER_NUMBER?.trim();
  let pricePerNumber: number;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BRAND_PRICE_PER_NUMBER must be a number");
    }
    pricePerNumber = DEV_PRICE_PER_NUMBER;
  } else {
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) {
      throw new Error("BRAND_PRICE_PER_NUMBER must be a number");
    }
    pricePerNumber = Number(raw);
  }
  const currency = (process.env.BRAND_CURRENCY?.trim() || DEFAULT_CURRENCY).toUpperCase();
  let valid = /^[A-Z]{3}$/.test(currency);
  if (valid) {
    try {
      new Intl.NumberFormat("en-GB", { style: "currency", currency });
    } catch {
      valid = false;
    }
  }
  if (!valid) throw new Error("BRAND_CURRENCY must be an ISO 4217 code");
  return { pricePerNumber, currency };
}

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
export function priceLine(numbers: number, pricing: PricingConfig): string {
  const n = Number.isFinite(numbers) && numbers > 0 ? Math.floor(numbers) : 0;
  const cost = formatMoney(monthlyCost(n, pricing.pricePerNumber), pricing.currency);
  return `${n} ${n === 1 ? "number" : "numbers"} = ${cost}/month`;
}
