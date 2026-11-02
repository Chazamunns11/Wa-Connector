import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import type { retrieveSubscription, setSubscriptionItemQuantity } from "@/lib/stripe/billing";

export type QuantityRepo = Pick<GhlRepository, "listGhlAccountsForAccount" | "countNumbersByLocation">;

/**
 * Per-number billing (Nov 2026, £7.99 per WhatsApp number): what the account
 * pays for is every number on every ACTIVATED sub-account. An activated
 * sub-account always counts at least 1 (its default number row is created on
 * install), so a single-number account bills exactly what it did before.
 * Inactive sub-accounts cost nothing, whatever their numbers.
 */
export function billableNumbers(locations: { activated: boolean; numbers: number }[]): number {
  return locations.reduce((sum, l) => sum + (l.activated ? Math.max(1, Number.isFinite(l.numbers) ? l.numbers : 1) : 0), 0);
}

export async function countBillableNumbers(repo: QuantityRepo, accountId: string): Promise<number> {
  const locations = await repo.listGhlAccountsForAccount(accountId);
  const activated = locations.filter((l) => l.activatedAt !== null);
  if (activated.length === 0) return 0;
  const counts = await repo.countNumbersByLocation(activated.map((l) => l.locationId));
  return billableNumbers(activated.map((l) => ({ activated: true, numbers: counts[l.locationId] ?? 0 })));
}

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
  const quantity = await countBillableNumbers(repo, account.id);
  // Already correct: skip the write so our own updates cannot echo back as endless webhook events.
  if (subscription.data.quantity === quantity) return { ok: true, quantity };
  const set = await deps.setQuantity(itemId, quantity);
  if (!set.ok) return fail(set.message);
  return { ok: true, quantity };
}
