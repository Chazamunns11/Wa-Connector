import type { GhlRepository } from "@/lib/data/repository";
import type { Account, NumberBilling, NumberBillingStatus } from "@/lib/types";
import { perNumberPence } from "@/lib/pricing";
import type { cancelSubscription, createNumberSubscription, retrieveSubscription, setSubscriptionItemPrice } from "@/lib/stripe/billing";
import { mapStripeSubscriptionStatus } from "./status";

/**
 * Per-number billing (migration 0020). Every WhatsApp number of an activated
 * sub-account is its own Stripe subscription; the account's count of billed
 * numbers picks the tier price that every one of them pays.
 */

export type NumberBillingRepo = Pick<GhlRepository, "listNumberBillingForAccount" | "updateNumberBilling">;

export interface NumberBillingDeps {
  createSubscription: typeof createNumberSubscription;
  retrieveSubscription: typeof retrieveSubscription;
  setPrice: typeof setSubscriptionItemPrice;
  cancel: typeof cancelSubscription;
  notify: (text: string) => void;
}

/** Statuses that count toward the tier (and may send). */
const COUNTED: ReadonlySet<NumberBillingStatus> = new Set(["trialing", "active", "past_due"]);
/** A subscription that is still running: never create a second one, re-price it, cancel it on removal. */
const RUNNING: ReadonlySet<NumberBillingStatus> = new Set(["trialing", "active", "past_due", "paused", "incomplete"]);

export const isRunning = (n: Pick<NumberBilling, "billingStatus" | "stripeSubscriptionId">): boolean =>
  !!n.stripeSubscriptionId && n.billingStatus !== null && RUNNING.has(n.billingStatus);

/** The account's billed numbers: the count that decides the tier. */
export function billedCount(numbers: NumberBilling[]): number {
  return numbers.filter((n) => n.billingStatus !== null && COUNTED.has(n.billingStatus)).length;
}

const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());

/**
 * Starts a subscription for each of `tenantIds` (numbers of `account`) that has
 * none running, at the tier price for the count INCLUDING them. A number that
 * has had a subscription before restarts without a trial (onboard.ts's old
 * "restart without a trial" rule, now per number). Stops at the first Stripe
 * failure and returns what it created so the caller can roll back. If the row
 * write fails after Stripe created the subscription, that subscription is
 * cancelled before the error is rethrown, so nothing bills unrecorded.
 */
export async function subscribeNumbers(
  repo: NumberBillingRepo,
  deps: NumberBillingDeps,
  account: Account,
  tenantIds: string[],
): Promise<{ ok: boolean; created: string[] }> {
  const created: string[] = [];
  if (!account.stripeCustomerId) return { ok: false, created };
  const numbers = await repo.listNumberBillingForAccount(account.id);
  const targets = numbers.filter((n) => tenantIds.includes(n.tenantId) && !isRunning(n));
  if (targets.length === 0) return { ok: true, created };
  const price = perNumberPence(billedCount(numbers) + targets.length);
  for (const n of targets) {
    const r = await deps.createSubscription({
      customerId: account.stripeCustomerId,
      accountId: account.id,
      locationId: n.locationId,
      tenantId: n.tenantId,
      unitAmountPence: price,
      trial: n.stripeSubscriptionId === null,
    });
    if (!r.ok) {
      deps.notify(`Number subscription could not be created for account ${account.id}: ${r.message}`);
      return { ok: false, created };
    }
    const sub = r.data;
    try {
      await repo.updateNumberBilling(n.tenantId, {
        stripeSubscriptionId: sub.id,
        billingStatus: mapStripeSubscriptionStatus(sub.status),
        trialEndsAt: sub.status === "trialing" ? iso(sub.trialEnd) : null,
        pricePence: sub.unitAmount ?? price,
      });
    } catch (err) {
      const undone = await deps.cancel(sub.id);
      if (!undone.ok) deps.notify(`Stripe subscription ${sub.id} was created but not recorded, and could not be cancelled: cancel it by hand`);
      throw err;
    }
    created.push(sub.id);
  }
  return { ok: true, created };
}

/**
 * Cancels a number's running subscription now and records it cancelled. A
 * subscription Stripe no longer has counts as cancelled. False (and Slack) on
 * a Stripe failure, so the caller can refuse or report it.
 */
export async function cancelNumber(repo: NumberBillingRepo, deps: NumberBillingDeps, number: NumberBilling): Promise<boolean> {
  if (!isRunning(number)) return true;
  const r = await deps.cancel(number.stripeSubscriptionId!);
  if (!r.ok && r.code !== "resource_missing") {
    deps.notify(`Stripe subscription ${number.stripeSubscriptionId} could not be cancelled: ${r.message}`);
    return false;
  }
  await repo.updateNumberBilling(number.tenantId, { billingStatus: "cancelled", trialEndsAt: null });
  return true;
}

/**
 * Puts every running number subscription of the account on the tier price for
 * its current billed count, with NO proration (from each one's next invoice).
 * Only numbers whose recorded price differs touch Stripe, so a settled account
 * costs one database read and our own updates cannot echo into a loop. Comped
 * accounts and accounts with no Stripe customer have nothing to sync. Each
 * failure goes to Slack; the next webhook or change retries it.
 */
export async function syncNumberPrices(repo: NumberBillingRepo, deps: NumberBillingDeps, account: Account): Promise<{ ok: boolean }> {
  if (account.billingStatus === "comped" || !account.stripeCustomerId) return { ok: true };
  const numbers = await repo.listNumberBillingForAccount(account.id);
  const price = perNumberPence(billedCount(numbers));
  let ok = true;
  for (const n of numbers) {
    if (!isRunning(n) || n.pricePence === price) continue;
    const live = await deps.retrieveSubscription(n.stripeSubscriptionId!);
    if (!live.ok || !live.data.itemId) {
      ok = false;
      deps.notify(`Number price sync failed for account ${account.id}: ${live.ok ? "subscription has no item" : live.message}`);
      continue;
    }
    if (live.data.unitAmount !== price) {
      const set = await deps.setPrice(live.data.itemId, price);
      if (!set.ok) {
        ok = false;
        deps.notify(`Number price sync failed for account ${account.id}: ${set.message}`);
        continue;
      }
    }
    await repo.updateNumberBilling(n.tenantId, { pricePence: price });
  }
  return { ok };
}
