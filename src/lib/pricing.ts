/**
 * Website pricing. A business decision kept in code, not an env var, in whole
 * pence, GBP.
 *
 * Nov 2026 (Charlie): the unit is a WHATSAPP NUMBER, and every number is its
 * own monthly Stripe subscription with its own TRIAL_DAYS free trial, renewing
 * on the day its trial ended (src/lib/billing/numbers.ts). GRADUATED: the
 * account's first FIRST_TIER_NUMBERS billed numbers cost PRICE_PER_NUMBER_PENCE
 * each and every number after that costs LATER_PRICE_PER_NUMBER_PENCE
 * (`numberPricePence`), so adding a number never makes the bill go down. A
 * sub-account can have up to MAX_NUMBERS_PER_SUB_ACCOUNT numbers.
 */
export interface PricingConfig {
  /** ISO 4217 upper-case. */
  currency: string;
}

export const CURRENCY = "GBP";
/** The price of each of the account's first FIRST_TIER_NUMBERS billed numbers. */
export const PRICE_PER_NUMBER_PENCE = 999;
/** How many numbers are charged at PRICE_PER_NUMBER_PENCE before the lower price starts. */
export const FIRST_TIER_NUMBERS = 10;
/** The price of the 11th number onwards. */
export const LATER_PRICE_PER_NUMBER_PENCE = 799;
/** The most WhatsApp numbers one sub-account can have (ghl_location_numbers.slot is 1-3). */
export const MAX_NUMBERS_PER_SUB_ACCOUNT = 3;

export function pricingConfig(): PricingConfig {
  return { currency: CURRENCY };
}

/** Each number's own free trial. */
export const TRIAL_DAYS = 7;

/** The one trial sentence every page uses (per-number trials, card saved first). */
export function trialSentence(): string {
  return `${TRIAL_DAYS}-day free trial on every WhatsApp number. Save your card when you start: nothing is charged until a number's trial ends, then that number is charged automatically each month unless you remove it.`;
}
export const CALCULATOR_PRESETS = [1, 3, 10, 25] as const;

/** The monthly price of the account's `rank`-th billed number (1-based, oldest first). */
export function numberPricePence(rank: number): number {
  return rank <= FIRST_TIER_NUMBERS ? PRICE_PER_NUMBER_PENCE : LATER_PRICE_PER_NUMBER_PENCE;
}

/** What `numbers` WhatsApp numbers cost a month, in pence: £9.99 each for the first 10, £7.99 each after. */
export function monthlyCostPence(numbers: number): number {
  if (!Number.isFinite(numbers) || numbers < 0) return 0;
  const n = Math.floor(numbers);
  const first = Math.min(n, FIRST_TIER_NUMBERS);
  return first * PRICE_PER_NUMBER_PENCE + (n - first) * LATER_PRICE_PER_NUMBER_PENCE;
}

export function monthlyCost(numbers: number): number {
  return monthlyCostPence(numbers) / 100;
}

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** "£9.99" */
export function pricePerNumber(currency: string): string {
  return formatMoney(PRICE_PER_NUMBER_PENCE / 100, currency);
}

/** "£7.99", the price of each number after the first FIRST_TIER_NUMBERS. */
export function laterPricePerNumber(currency: string): string {
  return formatMoney(LATER_PRICE_PER_NUMBER_PENCE / 100, currency);
}

/** The one pricing sentence every page uses. */
export function priceSentence(currency: string): string {
  return `${pricePerNumber(currency)} a month for each of your first ${FIRST_TIER_NUMBERS} WhatsApp numbers, then ${laterPricePerNumber(currency)} for every number after that. Up to ${MAX_NUMBERS_PER_SUB_ACCOUNT} numbers per sub-account.`;
}

/** e.g. "3 numbers = £29.97/month"; "1 number = £9.99/month". */
export function priceLine(numbers: number, pricing: PricingConfig): string {
  const n = Number.isFinite(numbers) && numbers > 0 ? Math.floor(numbers) : 0;
  return `${n} ${n === 1 ? "number" : "numbers"} = ${formatMoney(monthlyCost(n), pricing.currency)}/month`;
}
