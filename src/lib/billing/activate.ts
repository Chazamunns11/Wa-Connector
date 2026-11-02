import type { GhlRepository } from "@/lib/data/repository";
import type { retrieveSubscription, setSubscriptionItemQuantity } from "@/lib/stripe/billing";
import { ActivationCapError, canActivate, type ActivateRefusal } from "./activation";
import { countBillableNumbers, syncSubscriptionQuantity } from "./quantity";

export type ActivateRepo = Pick<
  GhlRepository,
  | "getGhlAccountByLocationId"
  | "getAccountById"
  | "countActivatedForAccount"
  | "countActivatedAll"
  | "setGhlActivated"
  | "listGhlAccountsForAccount"
  | "countNumbersByLocation"
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
 * unbilled. The write is conditional and cap-checked in the database, so two
 * parallel activations cannot both land past the cap; whatever happens, Stripe
 * is then re-synced to the true activated count. A database cap refusal or a
 * no-op write is returned as a refusal; any other error is rethrown.
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

  // Per-number billing and trial: what is billed now, and what this
  // sub-account adds (its numbers, at least 1).
  const [platformActive, billedNow, counts] = await Promise.all([
    repo.countActivatedAll(),
    countBillableNumbers(repo, accountId),
    repo.countNumbersByLocation([locationId]),
  ]);
  const adding = Math.max(1, counts[locationId] ?? 1);
  const verdict = canActivate({
    billingStatus: account.billingStatus,
    alreadyActive: location.activatedAt !== null,
    numbersAfter: billedNow + adding,
    platformActive,
    platformCap: deps.platformCap(),
  });
  if (!verdict.ok) return verdict;

  let itemId: string | null = null;
  let written: number | null = null;
  if (account.billingStatus !== "comped") {
    // A billable account with nothing to bill against must not get a free number.
    if (!account.stripeSubscriptionId) return { ok: false, reason: "stripe_failed" };
    const subscription = await deps.retrieveSubscription(account.stripeSubscriptionId);
    if (!subscription.ok || !subscription.data.itemId) return { ok: false, reason: "stripe_failed" };
    itemId = subscription.data.itemId;
    // Per-number billing (Nov 2026): Stripe goes up by THIS sub-account's
    // numbers (at least 1), on top of what is already billed.
    const target = billedNow + adding;
    // Charged now; if the card can't pay, Stripe refuses and nothing is activated.
    const raised = await deps.setQuantity(itemId, target, undefined, { refuseIfUnpaid: true });
    if (!raised.ok) return { ok: false, reason: "stripe_failed" };
    written = target;
  }

  // Re-syncs Stripe to the true billable count (never a stale read plus one).
  const resync = async () => {
    if (!itemId) return;
    try {
      const count = await countBillableNumbers(repo, accountId);
      if (count === written) return;
      const set = await deps.setQuantity(itemId, count);
      if (!set.ok) deps.notify(`Billing quantity re-sync failed for account ${accountId}: ${set.message}`);
    } catch {
      deps.notify(`Billing quantity re-sync failed for account ${accountId}`);
    }
  };

  let matched: number;
  try {
    matched = await repo.setGhlActivated(locationId, deps.now().toISOString(), { platformCap: deps.platformCap() });
  } catch (err) {
    await resync();
    if (err instanceof ActivationCapError) return { ok: false, reason: err.reason };
    throw err;
  }
  if (matched === 0) {
    await resync();
    return { ok: false, reason: "already_active" };
  }
  await resync();
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
