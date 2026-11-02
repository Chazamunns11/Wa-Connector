import type { BillingStatus, NumberBillingStatus } from "@/lib/types";

/** Fixed refusal shown in GoHighLevel when the sub-account has no activated number. */
export const REASON_NOT_ACTIVATED = "WhatsApp isn't activated for this sub-account";

/** Fixed refusal shown in GoHighLevel when the sending number's billing is not live. */
export function reasonSubscriptionInactive(brandName: string): string {
  return `${brandName} subscription inactive — the account owner needs to update billing`;
}

/** A number's subscription statuses that may send. `past_due` keeps sending while Stripe retries the card. */
const SENDING: ReadonlySet<NumberBillingStatus> = new Set(["trialing", "active", "past_due"]);

/**
 * `null` when the location may send from this number, otherwise the fixed
 * customer-facing refusal. Billing is per number: the sending number's own
 * subscription must be live, unless the owning account is comped (no Stripe).
 */
export function sendingGate(
  location: { accountId: string | null; activatedAt: string | null },
  accountStatus: BillingStatus | null,
  brandName: string,
  numberStatus: NumberBillingStatus | null,
): string | null {
  if (!location.accountId || !location.activatedAt) return REASON_NOT_ACTIVATED;
  if (accountStatus === "comped") return null;
  if (accountStatus === null || numberStatus === null || !SENDING.has(numberStatus)) return reasonSubscriptionInactive(brandName);
  return null;
}
