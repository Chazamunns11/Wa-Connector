import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import { MAX_NUMBERS_PER_SUB_ACCOUNT, TRIAL_MAX_NUMBERS } from "@/lib/pricing";
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

export type ChargeRepo = QuantityRepo & Pick<GhlRepository, "getGhlAccountByLocationId" | "getAccountById">;

export type ChargeOutcome = { ok: true; charged: boolean } | { ok: false; reason: "declined" | "stripe_failed" | "trial_cap" };

/**
 * Before a number is added: raise Stripe by one and take the payment NOW
 * (`refuseIfUnpaid`). If the card can't pay, Stripe changes nothing and the
 * caller must not add the number, so nobody gets a number they haven't paid
 * for. Nothing to charge (comped account, no subscription, sub-account not
 * active, already at the limit) is `{ ok: true, charged: false }` and the
 * normal add-number rules then decide. The caller re-syncs afterwards, which
 * credits the charge back if the add itself then fails.
 */
export async function chargeForNewNumber(
  repo: ChargeRepo,
  deps: Pick<QuantityDeps, "retrieveSubscription" | "setQuantity">,
  locationId: string,
): Promise<ChargeOutcome> {
  const location = await repo.getGhlAccountByLocationId(locationId);
  if (!location?.accountId || !location.activatedAt) return { ok: true, charged: false };
  const counts = await repo.countNumbersByLocation([locationId]);
  if ((counts[locationId] ?? 1) >= MAX_NUMBERS_PER_SUB_ACCOUNT) return { ok: true, charged: false };
  const account = await repo.getAccountById(location.accountId);
  if (!account || account.billingStatus === "comped") return { ok: true, charged: false };
  // The free trial covers TRIAL_MAX_NUMBERS numbers in total (Nov 2026).
  if (account.billingStatus === "trialing" && (await countBillableNumbers(repo, account.id)) >= TRIAL_MAX_NUMBERS) {
    return { ok: false, reason: "trial_cap" };
  }
  if (!account.stripeSubscriptionId) return { ok: true, charged: false };
  const subscription = await deps.retrieveSubscription(account.stripeSubscriptionId);
  if (!subscription.ok || !subscription.data.itemId) return { ok: false, reason: "stripe_failed" };
  const target = (await countBillableNumbers(repo, account.id)) + 1;
  const set = await deps.setQuantity(subscription.data.itemId, target, undefined, { refuseIfUnpaid: true });
  if (!set.ok) return { ok: false, reason: set.status === 402 ? "declined" : "stripe_failed" };
  return { ok: true, charged: true };
}
