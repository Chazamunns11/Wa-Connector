import type { GhlRepository } from "@/lib/data/repository";
import type { retrieveSubscription, setSubscriptionItemQuantity } from "@/lib/stripe/billing";
import { canActivate, type ActivateRefusal } from "./activation";
import { syncSubscriptionQuantity } from "./quantity";

export type ActivateRepo = Pick<
  GhlRepository,
  "getGhlAccountByLocationId" | "getAccountById" | "countActivatedForAccount" | "countActivatedAll" | "setGhlActivated"
>;

export interface ActivateDeps {
  retrieveSubscription: typeof retrieveSubscription;
  setQuantity: typeof setSubscriptionItemQuantity;
  notify: (text: string) => void;
  now: () => Date;
  platformCap: () => number | null;
}

export type ActivateOutcome = { ok: true } | { ok: false; reason: ActivateRefusal | "not_found" | "stripe_failed" };

/**
 * Activates one of the account's locations. The location must belong to
 * `accountId` (never trust the caller's location id). Stripe's quantity is
 * raised BEFORE activated_at is written, so a number is never active but
 * unbilled; if the write then fails the quantity is put back and the error
 * rethrown.
 */
export async function activateLocation(
  repo: ActivateRepo,
  deps: ActivateDeps,
  accountId: string,
  locationId: string,
): Promise<ActivateOutcome> {
  const location = await repo.getGhlAccountByLocationId(locationId);
  if (!location || location.accountId !== accountId) return { ok: false, reason: "not_found" };
  const account = await repo.getAccountById(accountId);
  if (!account) return { ok: false, reason: "not_found" };

  const [accountActive, platformActive] = await Promise.all([
    repo.countActivatedForAccount(accountId),
    repo.countActivatedAll(),
  ]);
  const verdict = canActivate({
    billingStatus: account.billingStatus,
    alreadyActive: location.activatedAt !== null,
    accountActive,
    platformActive,
    platformCap: deps.platformCap(),
  });
  if (!verdict.ok) return verdict;

  let itemId: string | null = null;
  if (account.billingStatus !== "comped") {
    // A billable account with nothing to bill against must not get a free number.
    if (!account.stripeSubscriptionId) return { ok: false, reason: "stripe_failed" };
    const subscription = await deps.retrieveSubscription(account.stripeSubscriptionId);
    if (!subscription.ok || !subscription.data.itemId) return { ok: false, reason: "stripe_failed" };
    itemId = subscription.data.itemId;
    const raised = await deps.setQuantity(itemId, accountActive + 1);
    if (!raised.ok) return { ok: false, reason: "stripe_failed" };
  }

  try {
    await repo.setGhlActivated(locationId, deps.now().toISOString());
  } catch (err) {
    if (itemId) {
      try {
        await deps.setQuantity(itemId, accountActive);
      } catch {
        deps.notify(`Billing quantity re-sync failed after a failed activation for account ${accountId}`);
      }
    }
    throw err;
  }
  return { ok: true };
}

/**
 * Deactivates a location: sending stops first (activated_at cleared), then the
 * Stripe quantity is synced. A Stripe failure is reported to Slack by the sync
 * and returned as `quantitySynced: false` for the next reconcile.
 */
export async function deactivateLocation(
  repo: ActivateRepo,
  deps: ActivateDeps,
  accountId: string,
  locationId: string,
): Promise<{ ok: true; quantitySynced: boolean } | { ok: false; reason: "not_found" }> {
  const location = await repo.getGhlAccountByLocationId(locationId);
  if (!location || location.accountId !== accountId) return { ok: false, reason: "not_found" };
  const account = await repo.getAccountById(accountId);
  if (!account) return { ok: false, reason: "not_found" };

  await repo.setGhlActivated(locationId, null);
  const synced = await syncSubscriptionQuantity(
    repo,
    { retrieveSubscription: deps.retrieveSubscription, setQuantity: deps.setQuantity, notify: deps.notify },
    account,
  );
  return { ok: true, quantitySynced: synced.ok || synced.reason === "no_subscription" };
}
