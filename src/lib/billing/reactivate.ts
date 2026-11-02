import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import type { retrieveSubscription, settleInvoice } from "@/lib/stripe/billing";
import { mapStripeSubscriptionStatus } from "@/lib/billing/status";

export interface ReactivateDeps {
  retrieveSubscription: typeof retrieveSubscription;
  settleInvoice: typeof settleInvoice;
}

export type ReactivateOutcome = "paid" | "payment_failed" | "nothing_due";

/** Stripe statuses where money is owed and a card change should pay it. */
const OWING = new Set(["unpaid", "past_due"]);

/**
 * After a new card is saved: if the subscription is `unpaid` or `past_due`,
 * pay its latest invoice with that card (drafts finalised first, see
 * `settleInvoice`). Stripe then marks the subscription `active`.
 *
 * The account's billing_status is then re-read from Stripe's subscription and
 * written straight away, so sending restarts the moment the payment goes
 * through instead of waiting for the `customer.subscription.updated` webhook
 * (which still arrives and writes the same value). billing_status is still
 * only ever set from Stripe's own subscription object, mapped.
 *
 * Earlier unpaid invoices are left open: paying the most recent one is what
 * reactivates the subscription (docs.stripe.com/billing/subscriptions/overview).
 * A decline is `payment_failed`, never thrown: the account stays paused and
 * the daily reminder carries on.
 */
export async function payWhatsDue(
  repo: Pick<GhlRepository, "updateAccountBilling">,
  deps: ReactivateDeps,
  account: Pick<Account, "id" | "stripeSubscriptionId">,
  paymentMethod?: string,
): Promise<ReactivateOutcome> {
  if (!account.stripeSubscriptionId) return "nothing_due";
  const live = await deps.retrieveSubscription(account.stripeSubscriptionId);
  if (!live.ok) throw new Error(`reactivate: retrieve subscription failed: ${live.message}`);
  if (!OWING.has(live.data.status) || !live.data.latestInvoice) return "nothing_due";

  const paid = await deps.settleInvoice(live.data.latestInvoice, paymentMethod ? { paymentMethod } : {});
  if (!paid.ok || paid.data.status !== "paid") return "payment_failed";

  const after = await deps.retrieveSubscription(account.stripeSubscriptionId);
  if (after.ok) {
    const status = mapStripeSubscriptionStatus(after.data.status);
    if (status !== null) await repo.updateAccountBilling(account.id, { billingStatus: status });
  }
  return "paid";
}
