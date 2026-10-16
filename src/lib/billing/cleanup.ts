import type { GhlRepository } from "@/lib/data/repository";
import type { BridgeOkResult } from "@/lib/whatsapp-bridge";

/** How long a cancelled account's stored WhatsApp credentials are kept before the daily pass removes them. */
export const CANCELLED_CLEANUP_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export type CleanupRepo = Pick<
  GhlRepository,
  "listAccountsCancelledBefore" | "listGhlAccountsForAccount" | "setGhlActivated" | "updateAccountBilling"
>;

export interface CleanupDeps {
  /** Unlinks the number and wipes its stored credentials on the bridge. */
  logout: (tenantId: string) => Promise<BridgeOkResult>;
  now: () => Date;
}

/**
 * Cancelled for 14+ days: log every location out of the bridge (which deletes
 * its stored credentials) and clear its activation. `cleanedUpAt` is written
 * only when every logout succeeded, so a bridge outage simply retries on the
 * next daily pass; logout and clearing are both safe to repeat. Logs carry
 * counts only, never ids, emails, Stripe references or bridge error text.
 */
export async function purgeCancelledAccounts(
  repo: CleanupRepo,
  deps: CleanupDeps
): Promise<{ accounts: number; locations: number; failures: number }> {
  const now = deps.now();
  const accounts = await repo.listAccountsCancelledBefore(new Date(now.getTime() - CANCELLED_CLEANUP_AFTER_MS).toISOString());
  let locations = 0;
  let failures = 0;
  for (const account of accounts) {
    let clean = true;
    const owned = await repo.listGhlAccountsForAccount(account.id);
    for (const location of owned) {
      locations += 1;
      let ok = false;
      try {
        ok = (await deps.logout(location.tenantId)).ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        failures += 1;
        clean = false;
      }
      try {
        await repo.setGhlActivated(location.locationId, null);
      } catch {
        failures += 1;
        clean = false;
      }
    }
    if (clean) {
      await repo.updateAccountBilling(account.id, { cleanedUpAt: now.toISOString() });
    }
  }
  return { accounts: accounts.length, locations, failures };
}
