import type { BillingStatus } from "@/lib/types";

/** Fixed refusal shown in GoHighLevel when the sub-account has no activated number. */
export const REASON_NOT_ACTIVATED = "WhatsApp isn't activated for this sub-account";

/** Fixed refusal shown in GoHighLevel when the owning account's billing is not live. */
export function reasonSubscriptionInactive(brandName: string): string {
  return `${brandName} subscription inactive — the account owner needs to update billing`;
}

/** Statuses that may send. `past_due` keeps sending while Stripe retries the card. */
const SENDING: ReadonlySet<BillingStatus> = new Set(["trialing", "active", "past_due", "comped"]);

/** `null` when the location may send, otherwise the fixed customer-facing refusal. */
export function sendingGate(
  location: { accountId: string | null; activatedAt: string | null },
  billingStatus: BillingStatus | null,
  brandName: string,
): string | null {
  if (!location.accountId || !location.activatedAt) return REASON_NOT_ACTIVATED;
  if (billingStatus === null || !SENDING.has(billingStatus)) return reasonSubscriptionInactive(brandName);
  return null;
}
