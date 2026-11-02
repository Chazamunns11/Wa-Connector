import type { NumberBillingStatus } from "@/lib/types";

/**
 * Stripe subscription status -> a number's `billing_status`. `null` means "do
 * not write": anything unknown must leave the stored status untouched rather
 * than write garbage. `incomplete` (a no-trial restart whose first charge has
 * not gone through) is stored so it is never subscribed twice; it may not send.
 */
export function mapStripeSubscriptionStatus(status: string): NumberBillingStatus | null {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "incomplete":
      return "incomplete";
    // `paused`: the trial ended with no card. `unpaid`: payment retries ran out.
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
