import type { GhlRepository } from "@/lib/data/repository";
import { ActivationCapError, canActivate, type ActivateRefusal } from "./activation";
import { cancelNumber, subscribeNumbers, syncNumberPrices, type NumberBillingDeps } from "./numbers";

export type ActivateRepo = Pick<
  GhlRepository,
  | "getGhlAccountByLocationId"
  | "getAccountById"
  | "countActivatedAll"
  | "setGhlActivated"
  | "listNumberBillingForAccount"
  | "updateNumberBilling"
>;

export interface ActivateDeps extends NumberBillingDeps {
  now: () => Date;
  platformCap: () => number | null;
}

export type ActivateOutcome = { ok: true } | { ok: false; reason: ActivateRefusal | "not_found" | "stripe_failed" };

/**
 * Activates one of the account's locations, which starts billing every one of
 * its WhatsApp numbers (each its own subscription with its own trial). The
 * location must belong to `accountId` (never trust the caller's location id).
 * activated_at is written first, cap-checked and conditional in the database
 * so two parallel activations cannot both land; a number still cannot send
 * until its own subscription exists (the sending gate checks it). If any
 * subscription cannot be created, the ones made here are cancelled and the
 * activation is undone. Then every number is re-priced if the tier moved.
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

  const verdict = canActivate({
    billingStatus: account.billingStatus,
    alreadyActive: location.activatedAt !== null,
    platformActive: await repo.countActivatedAll(),
    platformCap: deps.platformCap(),
  });
  if (!verdict.ok) return verdict;
  // A billable account with nothing to bill against must not get a free number.
  if (account.billingStatus !== "comped" && !account.stripeCustomerId) return { ok: false, reason: "stripe_failed" };

  let matched: number;
  try {
    matched = await repo.setGhlActivated(locationId, deps.now().toISOString(), { platformCap: deps.platformCap() });
  } catch (err) {
    if (err instanceof ActivationCapError) return { ok: false, reason: err.reason };
    throw err;
  }
  if (matched === 0) return { ok: false, reason: "already_active" };
  if (account.billingStatus === "comped") return { ok: true };

  const undo = async (created: string[]) => {
    for (const n of await repo.listNumberBillingForAccount(accountId)) {
      if (n.stripeSubscriptionId && created.includes(n.stripeSubscriptionId)) await cancelNumber(repo, deps, n);
    }
    await repo.setGhlActivated(locationId, null);
  };
  const tenantIds = (await repo.listNumberBillingForAccount(accountId)).filter((n) => n.locationId === locationId).map((n) => n.tenantId);
  let subscribed: { ok: boolean; created: string[] };
  try {
    subscribed = await subscribeNumbers(repo, deps, account, tenantIds);
  } catch (err) {
    await repo.setGhlActivated(locationId, null);
    throw err;
  }
  if (!subscribed.ok) {
    await undo(subscribed.created);
    return { ok: false, reason: "stripe_failed" };
  }
  await syncNumberPrices(repo, deps, account);
  return { ok: true };
}

/**
 * Deactivates a location: sending stops first (activated_at cleared), then each
 * of its numbers' subscriptions is cancelled now and the rest re-priced if the
 * tier moved. A Stripe failure is reported to Slack and returned as
 * `billingSynced: false`.
 */
export async function deactivateLocation(
  repo: ActivateRepo,
  deps: ActivateDeps,
  accountId: string,
  locationId: string,
): Promise<{ ok: true; billingSynced: boolean } | { ok: false; reason: "not_found" }> {
  const location = await repo.getGhlAccountByLocationId(locationId);
  if (!location || location.accountId !== accountId) return { ok: false, reason: "not_found" };
  const account = await repo.getAccountById(accountId);
  if (!account) return { ok: false, reason: "not_found" };

  await repo.setGhlActivated(locationId, null);
  let billingSynced = true;
  for (const n of await repo.listNumberBillingForAccount(accountId)) {
    if (n.locationId === locationId && !(await cancelNumber(repo, deps, n))) billingSynced = false;
  }
  if (!(await syncNumberPrices(repo, deps, account)).ok) billingSynced = false;
  return { ok: true, billingSynced };
}
