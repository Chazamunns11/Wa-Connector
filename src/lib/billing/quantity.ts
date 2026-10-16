import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import type { retrieveSubscription, setSubscriptionItemQuantity } from "@/lib/stripe/billing";

export type QuantityRepo = Pick<GhlRepository, "countActivatedForAccount">;

export interface QuantityDeps {
  retrieveSubscription: typeof retrieveSubscription;
  setQuantity: typeof setSubscriptionItemQuantity;
  notify: (text: string) => void;
}

/**
 * Brings the Stripe subscription item quantity in line with the number of
 * activated numbers. Comped accounts and accounts with no subscription yet are
 * not an error. A Stripe failure is reported to Slack, never swallowed.
 */
export async function syncSubscriptionQuantity(
  repo: QuantityRepo,
  deps: QuantityDeps,
  account: Account,
): Promise<{ ok: true; quantity: number } | { ok: false; reason: "no_subscription" | "stripe_failed" }> {
  if (account.billingStatus === "comped" || !account.stripeSubscriptionId) {
    return { ok: false, reason: "no_subscription" };
  }
  const fail = (message: string) => {
    deps.notify(`Billing quantity sync failed for account ${account.id}: ${message}`);
    return { ok: false, reason: "stripe_failed" } as const;
  };
  const subscription = await deps.retrieveSubscription(account.stripeSubscriptionId);
  if (!subscription.ok) return fail(subscription.message);
  const itemId = subscription.data.itemId;
  if (!itemId) return fail("subscription has no item");
  const quantity = await repo.countActivatedForAccount(account.id);
  const set = await deps.setQuantity(itemId, quantity);
  if (!set.ok) return fail(set.message);
  return { ok: true, quantity };
}
