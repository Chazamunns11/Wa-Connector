/**
 * Website pricing. A business decision kept in code, not an env var
 * (Ruling W40): volume pricing in whole pence, GBP.
 *
 *  - fewer than VOLUME_FROM numbers: STANDARD_PENCE each, per month
 *  - VOLUME_FROM numbers or more:    VOLUME_PENCE each, for ALL of them
 *
 * Every price the site shows is built from these constants.
 */
export interface PricingConfig {
  /** ISO 4217 upper-case. */
  currency: string;
}

export const CURRENCY = "GBP";
export const STANDARD_PENCE = 1499;
export const VOLUME_PENCE = 799;
export const VOLUME_FROM = 10;

export function pricingConfig(): PricingConfig {
  return { currency: CURRENCY };
}

export const TRIAL_DAYS = 7;
export const TRIAL_MAX_NUMBERS = 3;
export const CALCULATOR_PRESETS = [1, 3, 5, 10, 25] as const;

/** Pence charged per number, per month, when `numbers` are connected. */
export function perNumberPence(numbers: number): number {
  return numbers >= VOLUME_FROM ? VOLUME_PENCE : STANDARD_PENCE;
}

/** Monthly cost in whole pence. Invalid input costs 0; fractions floor. */
export function monthlyCostPence(numbers: number): number {
  if (!Number.isFinite(numbers) || numbers < 0) return 0;
  const n = Math.floor(numbers);
  return n * perNumberPence(n);
}

/** Monthly cost in major units, from whole pence (no float drift). */
export function monthlyCost(numbers: number): number {
  return monthlyCostPence(numbers) / 100;
}

/** en-GB currency string, always with pence: "£14.99", "£79.90". */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

const money = (pence: number, currency: string) => formatMoney(pence / 100, currency);

/** The standard per-number price, e.g. "£14.99". */
export function standardPrice(currency: string): string {
  return money(STANDARD_PENCE, currency);
}

/** The volume per-number price, e.g. "£7.99". */
export function volumePrice(currency: string): string {
  return money(VOLUME_PENCE, currency);
}

/** The pricing in two plain sentences. */
export function tierSentence(currency: string): string {
  return `${standardPrice(currency)} a month per number. Connect ${VOLUME_FROM} or more and every number drops to ${volumePrice(currency)} a month.`;
}

/** The transparent tier list. */
export function tierRows(currency: string): { range: string; each: string }[] {
  return [
    { range: `1 to ${VOLUME_FROM - 1} numbers`, each: standardPrice(currency) },
    { range: `${VOLUME_FROM} or more numbers`, each: volumePrice(currency) },
  ];
}

/** e.g. "5 numbers = £74.95/month"; "1 number = £14.99/month". */
export function priceLine(numbers: number, pricing: PricingConfig): string {
  const n = Number.isFinite(numbers) && numbers > 0 ? Math.floor(numbers) : 0;
  return `${n} ${n === 1 ? "number" : "numbers"} = ${formatMoney(monthlyCost(n), pricing.currency)}/month`;
}
