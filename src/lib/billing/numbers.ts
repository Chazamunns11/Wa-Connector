import type { GhlRepository } from "@/lib/data/repository";
import type { Account, NumberBilling, NumberBillingStatus } from "@/lib/types";
import { numberPricePence } from "@/lib/pricing";
import type { cancelSubscription, createNumberSubscription, retrieveSubscription, setSubscriptionItemPrice } from "@/lib/stripe/billing";
import { mapStripeSubscriptionStatus } from "./status";

/**
 * Per-number billing (migration 0020). Every WhatsApp number of an activated
 * sub-account is its own Stripe subscription. Graduated price: the account's
 * oldest FIRST_TIER_NUMBERS billed numbers pay the first-tier price, the rest
 * the lower one (`numberPricePence`), so the account total always equals
 * `monthlyCostPence(billed)`.
 */

export type NumberBillingRepo = Pick<
  GhlRepository,
  "listNumberBillingForAccount" | "updateNumberBilling" | "claimNumberTrial" | "releaseNumberTrial"
>;

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

const counted = (n: Pick<NumberBilling, "billingStatus">) => n.billingStatus !== null && COUNTED.has(n.billingStatus);

export const isRunning = (n: Pick<NumberBilling, "billingStatus" | "stripeSubscriptionId">): boolean =>
  !!n.stripeSubscriptionId && n.billingStatus !== null && RUNNING.has(n.billingStatus);

/** The account's billed numbers: the count that decides the price. */
export function billedCount(numbers: NumberBilling[]): number {
  return numbers.filter(counted).length;
}

/**
 * The price each running number should pay: billed numbers by age (oldest
 * first) take ranks 1, 2, ...; a running but not billed one (paused,
 * incomplete) is priced as the next rank, what it would cost if it came back.
 */
export function targetPrices(numbers: NumberBilling[]): Map<string, number> {
  const byAge = (a: NumberBilling, b: NumberBilling) => a.createdAt.localeCompare(b.createdAt) || a.tenantId.localeCompare(b.tenantId);
  const billed = numbers.filter(counted).sort(byAge);
  const out = new Map(billed.map((n, i) => [n.tenantId, numberPricePence(i + 1)]));
  for (const n of numbers) if (isRunning(n) && !out.has(n.tenantId)) out.set(n.tenantId, numberPricePence(billed.length + 1));
  return out;
}

const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());

/**
 * Starts a subscription for each of `tenantIds` (numbers of `account`) that has
 * none running, priced at its rank after the numbers already billed.
 *
 * Trials (no farming): a number gets a TRIAL_DAYS trial only if it has never
 * had a subscription AND its sub-account can claim one (`claimNumberTrial`:
 * trials granted there stay below the sub-account's current number count, so
 * removing and re-adding a number never earns a second trial, while a
 * genuinely extra number does). Otherwise it is charged now.
 *
 * Stops at the first Stripe failure (releasing that number's trial claim) and
 * returns what it created so the caller can roll back. If the row write fails
 * after Stripe created the subscription, that subscription is cancelled before
 * the error is rethrown, so nothing bills unrecorded.
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
  const perLocation = (locationId: string) => numbers.filter((n) => n.locationId === locationId).length;
  let rank = billedCount(numbers);
  for (const n of targets) {
    rank += 1;
    const price = numberPricePence(rank);
    const trial = n.stripeSubscriptionId === null && (await repo.claimNumberTrial(n.locationId, perLocation(n.locationId)));
    const r = await deps.createSubscription({
      customerId: account.stripeCustomerId,
      accountId: account.id,
      locationId: n.locationId,
      tenantId: n.tenantId,
      unitAmountPence: price,
      trial,
    });
    if (!r.ok) {
      if (trial) await repo.releaseNumberTrial(n.locationId);
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
        // Re-subscribed inside the cleanup grace: nothing is wiped.
        cancelledAt: null,
        cleanedUpAt: null,
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
 * Cancels a number's running subscription now and records it cancelled (from
 * now, for the credential cleanup grace). A subscription Stripe no longer has
 * counts as cancelled. False (and Slack) on a Stripe failure, so the caller
 * can refuse or report it.
 */
export async function cancelNumber(
  repo: NumberBillingRepo,
  deps: NumberBillingDeps,
  number: NumberBilling,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isRunning(number)) return true;
  const r = await deps.cancel(number.stripeSubscriptionId!);
  if (!r.ok && r.code !== "resource_missing") {
    deps.notify(`Stripe subscription ${number.stripeSubscriptionId} could not be cancelled: ${r.message}`);
    return false;
  }
  await repo.updateNumberBilling(number.tenantId, { billingStatus: "cancelled", trialEndsAt: null, cancelledAt: now.toISOString() });
  return true;
}

/**
 * Puts every running number subscription of the account on its graduated
 * price (`targetPrices`), with NO proration (from each one's next invoice).
 * Only numbers whose recorded price differs touch Stripe, so a settled account
 * costs one database read and our own updates cannot echo into a loop. Comped
 * accounts and accounts with no Stripe customer have nothing to sync. Each
 * failure goes to Slack; the next webhook or change retries it.
 */
export async function syncNumberPrices(repo: NumberBillingRepo, deps: NumberBillingDeps, account: Account): Promise<{ ok: boolean }> {
  if (account.billingStatus === "comped" || !account.stripeCustomerId) return { ok: true };
  const numbers = await repo.listNumberBillingForAccount(account.id);
  const targets = targetPrices(numbers);
  let ok = true;
  for (const n of numbers) {
    const price = targets.get(n.tenantId);
    if (price === undefined || !isRunning(n) || n.pricePence === price) continue;
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
