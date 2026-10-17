import type { BillingStatus } from "@/lib/types";

/**
 * Stripe subscription status -> our `billing_status`. `null` means "do not
 * write": `incomplete` (first payment not yet resolved) and anything unknown
 * must leave the stored status untouched rather than write garbage.
 */
export function mapStripeSubscriptionStatus(status: string): BillingStatus | null {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
    case "paused":
      return "paused";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    default:
      return null;
  }
}
