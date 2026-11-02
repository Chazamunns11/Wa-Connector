/**
 * Website pricing. A business decision kept in code, not an env var, in whole
 * pence, GBP.
 *
 * Nov 2026 (Charlie): the unit is a CONNECTED WHATSAPP NUMBER. GRADUATED:
 * the first FIRST_TIER_NUMBERS numbers cost PRICE_PER_NUMBER_PENCE each, and
 * every number after that costs LATER_PRICE_PER_NUMBER_PENCE. Adding a
 * number never makes the bill go down (no cliff at the threshold). A sub-account can
 * have up to MAX_NUMBERS_PER_SUB_ACCOUNT numbers. The Stripe subscription
 * quantity is the number of WhatsApp numbers on the account's activated
 * sub-accounts (src/lib/billing/quantity.ts). This replaced the W40 volume
 * tiers per activated sub-account.
 */
export interface PricingConfig {
  /** ISO 4217 upper-case. */
  currency: string;
}

export const CURRENCY = "GBP";
/** Nov 2026: one flat price per connected WhatsApp number (no tiers). The Stripe Price must match: see `stripeNumberPrice`. */
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

export const TRIAL_DAYS = 7;
/** The trial covers up to this many activated sub-accounts. */
/** Nov 2026: the free trial covers this many WhatsApp NUMBERS (it used to count sub-accounts), matching per-number pricing. */
export const TRIAL_MAX_NUMBERS = 3;

/** The one trial sentence every page uses (Nov 2026: a card is taken at sign-up and charged on day 7). */
export function trialSentence(): string {
  return `${TRIAL_DAYS}-day free trial for up to ${TRIAL_MAX_NUMBERS} WhatsApp numbers. Add your card when you start: nothing is charged for ${TRIAL_DAYS} days, then your card is charged automatically unless you cancel first.`;
}
export const CALCULATOR_PRESETS = [1, 3, 10, 25] as const;

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

/** "£7.99" */
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

/** e.g. "3 numbers = £23.97/month"; "1 number = £7.99/month". */
export function priceLine(numbers: number, pricing: PricingConfig): string {
  const n = Number.isFinite(numbers) && numbers > 0 ? Math.floor(numbers) : 0;
  return `${n} ${n === 1 ? "number" : "numbers"} = ${formatMoney(monthlyCost(n), pricing.currency)}/month`;
}
