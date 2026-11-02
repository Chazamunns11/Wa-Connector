/**
 * Website pricing. A business decision kept in code, not an env var
 * (Ruling W40, revised 2 Nov 2026): volume pricing in whole pence, GBP.
 *
 * The unit is a WHATSAPP NUMBER. Every number is its own monthly Stripe
 * subscription with its own 7-day free trial, renewing on the day its trial
 * ended. Volume pricing: the tier the account's total of billed numbers lands
 * in prices EVERY number, not just the ones above the threshold.
 *
 *  - 1 to 10 numbers:  STANDARD_PENCE each, per month
 *  - 11 to 24 numbers: MID_PENCE each
 *  - 25 or more:       VOLUME_PENCE each
 *
 * Every price the site shows is built from these constants.
 */
export interface PricingConfig {
  /** ISO 4217 upper-case. */
  currency: string;
}

export const CURRENCY = "GBP";
export const STANDARD_PENCE = 999;
export const MID_PENCE = 799;
export const VOLUME_PENCE = 599;
/** First number count that gets the middle price. */
export const MID_FROM = 11;
/** First number count that gets the lowest price. */
export const VOLUME_FROM = 25;

export function pricingConfig(): PricingConfig {
  return { currency: CURRENCY };
}

/** Each number's own free trial. */
export const TRIAL_DAYS = 7;
export const CALCULATOR_PRESETS = [1, 3, 10, 11, 25] as const;

/** Pence charged per number, per month, when the account has `numbers` billed numbers. */
export function perNumberPence(numbers: number): number {
  if (numbers >= VOLUME_FROM) return VOLUME_PENCE;
  if (numbers >= MID_FROM) return MID_PENCE;
  return STANDARD_PENCE;
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

/** en-GB currency string, always with pence: "£9.99", "£79.90". */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

const money = (pence: number, currency: string) => formatMoney(pence / 100, currency);

/** The 1 to 10 number price per number, e.g. "£9.99". */
export function standardPrice(currency: string): string {
  return money(STANDARD_PENCE, currency);
}

/** The 11 to 24 number price per number, e.g. "£7.99". */
export function midPrice(currency: string): string {
  return money(MID_PENCE, currency);
}

/** The 25-or-more price per number, e.g. "£5.99". */
export function volumePrice(currency: string): string {
  return money(VOLUME_PENCE, currency);
}

/** The pricing in plain sentences. Says outright that the tier price applies to every number. */
export function tierSentence(currency: string): string {
  return `${standardPrice(currency)} a month per WhatsApp number, each with its own ${TRIAL_DAYS}-day free trial. ${MID_FROM} to ${VOLUME_FROM - 1} numbers: ${midPrice(currency)} each. ${VOLUME_FROM} or more numbers: ${volumePrice(currency)} each. The tier you reach applies to every number.`;
}

/** The transparent tier list. */
export function tierRows(currency: string): { range: string; each: string }[] {
  return [
    { range: `1 to ${MID_FROM - 1} numbers`, each: standardPrice(currency) },
    { range: `${MID_FROM} to ${VOLUME_FROM - 1} numbers`, each: midPrice(currency) },
    { range: `${VOLUME_FROM} or more numbers`, each: volumePrice(currency) },
  ];
}

/** e.g. "10 numbers = £99.90/month"; "1 number = £9.99/month". */
export function priceLine(numbers: number, pricing: PricingConfig): string {
  const n = Number.isFinite(numbers) && numbers > 0 ? Math.floor(numbers) : 0;
  return `${n} ${n === 1 ? "number" : "numbers"} = ${formatMoney(monthlyCost(n), pricing.currency)}/month`;
}
