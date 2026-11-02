/**
 * Website pricing. A business decision kept in code, not an env var, in whole
 * pence, GBP.
 *
 * Nov 2026 (Charlie): the unit is a CONNECTED WHATSAPP NUMBER, at one flat
 * price, PRICE_PER_NUMBER_PENCE a month, with no tiers. A sub-account can
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
export const PRICE_PER_NUMBER_PENCE = 799;
/** The most WhatsApp numbers one sub-account can have (ghl_location_numbers.slot is 1-3). */
export const MAX_NUMBERS_PER_SUB_ACCOUNT = 3;

export function pricingConfig(): PricingConfig {
  return { currency: CURRENCY };
}

export const TRIAL_DAYS = 7;
/** The trial covers up to this many activated sub-accounts. */
/** Nov 2026: the free trial covers this many WhatsApp NUMBERS (it used to count sub-accounts), matching per-number pricing. */
export const TRIAL_MAX_NUMBERS = 3;
export const CALCULATOR_PRESETS = [1, 3, 10, 25] as const;

/** What `numbers` WhatsApp numbers cost a month, in pence. Same price for every number. */
export function monthlyCostPence(numbers: number): number {
  if (!Number.isFinite(numbers) || numbers < 0) return 0;
  return Math.floor(numbers) * PRICE_PER_NUMBER_PENCE;
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

/** The one pricing sentence every page uses. */
export function priceSentence(currency: string): string {
  return `${pricePerNumber(currency)} a month for each WhatsApp number you connect, up to ${MAX_NUMBERS_PER_SUB_ACCOUNT} per sub-account. Every number costs the same, however many you run.`;
}

/** e.g. "3 numbers = £23.97/month"; "1 number = £7.99/month". */
export function priceLine(numbers: number, pricing: PricingConfig): string {
  const n = Number.isFinite(numbers) && numbers > 0 ? Math.floor(numbers) : 0;
  return `${n} ${n === 1 ? "number" : "numbers"} = ${formatMoney(monthlyCost(n), pricing.currency)}/month`;
}
