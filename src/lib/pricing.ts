/**
 * Website pricing. A business decision kept in code, not an env var
 * (Ruling W40, revised 17 Oct 2026): volume pricing in whole pence, GBP.
 *
 * The unit is an ACTIVATED SUB-ACCOUNT, not a number. Up to
 * NUMBERS_INCLUDED WhatsApp numbers per sub-account are included on every
 * tier. Volume pricing: the tier the total lands in prices EVERY
 * sub-account, not just the ones above the threshold.
 *
 *  - 1 to 10 sub-accounts:  STANDARD_PENCE each, per month
 *  - 11 to 24 sub-accounts: MID_PENCE each
 *  - 25 or more:            VOLUME_PENCE each
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
/** First sub-account count that gets the middle price. */
export const MID_FROM = 11;
/** First sub-account count that gets the lowest price. */
export const VOLUME_FROM = 25;
/** WhatsApp numbers included with every activated sub-account. */
export const NUMBERS_INCLUDED = 3;

export function pricingConfig(): PricingConfig {
  return { currency: CURRENCY };
}

export const TRIAL_DAYS = 7;
/** The trial covers up to this many activated sub-accounts. */
export const TRIAL_MAX_SUB_ACCOUNTS = 3;
export const CALCULATOR_PRESETS = [1, 3, 10, 11, 25] as const;

/** Pence charged per sub-account, per month, when `subAccounts` are activated. */
export function perSubAccountPence(subAccounts: number): number {
  if (subAccounts >= VOLUME_FROM) return VOLUME_PENCE;
  if (subAccounts >= MID_FROM) return MID_PENCE;
  return STANDARD_PENCE;
}

/** Monthly cost in whole pence. Invalid input costs 0; fractions floor. */
export function monthlyCostPence(subAccounts: number): number {
  if (!Number.isFinite(subAccounts) || subAccounts < 0) return 0;
  const n = Math.floor(subAccounts);
  return n * perSubAccountPence(n);
}

/** Monthly cost in major units, from whole pence (no float drift). */
export function monthlyCost(subAccounts: number): number {
  return monthlyCostPence(subAccounts) / 100;
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

/** The 1 to 10 sub-account price per sub-account, e.g. "£9.99". */
export function standardPrice(currency: string): string {
  return money(STANDARD_PENCE, currency);
}

/** The 11 to 24 sub-account price per sub-account, e.g. "£7.99". */
export function midPrice(currency: string): string {
  return money(MID_PENCE, currency);
}

/** The 25-or-more price per sub-account, e.g. "£9.99". */
export function volumePrice(currency: string): string {
  return money(VOLUME_PENCE, currency);
}

/** The pricing in plain sentences. Says outright that the tier price applies to every sub-account. */
export function tierSentence(currency: string): string {
  return `${standardPrice(currency)} a month per sub-account, with up to ${NUMBERS_INCLUDED} WhatsApp numbers included. ${MID_FROM} to ${VOLUME_FROM - 1} sub-accounts: ${midPrice(currency)} each. ${VOLUME_FROM} or more sub-accounts: ${volumePrice(currency)} each. The tier you reach applies to every sub-account.`;
}

/** The transparent tier list. */
export function tierRows(currency: string): { range: string; each: string }[] {
  return [
    { range: `1 to ${MID_FROM - 1} sub-accounts`, each: standardPrice(currency) },
    { range: `${MID_FROM} to ${VOLUME_FROM - 1} sub-accounts`, each: midPrice(currency) },
    { range: `${VOLUME_FROM} or more sub-accounts`, each: volumePrice(currency) },
  ];
}

/** e.g. "10 sub-accounts = £99.90/month"; "1 sub-account = £9.99/month". */
export function priceLine(subAccounts: number, pricing: PricingConfig): string {
  const n = Number.isFinite(subAccounts) && subAccounts > 0 ? Math.floor(subAccounts) : 0;
  return `${n} ${n === 1 ? "sub-account" : "sub-accounts"} = ${formatMoney(monthlyCost(n), pricing.currency)}/month`;
}
