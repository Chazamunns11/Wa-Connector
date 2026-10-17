import type { GhlRepository } from "@/lib/data/repository";
import type { BridgeOkResult } from "@/lib/whatsapp-bridge";

/** How long a cancelled account's stored WhatsApp credentials are kept before the hourly pass removes them. */
export const CANCELLED_CLEANUP_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export type CleanupRepo = Pick<
  GhlRepository,
  "listAccountsCancelledBefore" | "listGhlAccountsForAccount" | "setGhlActivated" | "updateAccountBilling" | "listLocationNumbers"
>;

export interface CleanupDeps {
  /** Unlinks the number and wipes its stored credentials on the bridge. */
  logout: (tenantId: string) => Promise<BridgeOkResult>;
  now: () => Date;
}

/**
 * Cancelled for 14+ days: log every location out of the bridge (which deletes
 * its stored credentials) and clear its activation. Multiple numbers (merge):
 * EVERY number of the location (`listLocationNumbers`, plus the location's
 * own default tenant), not only the default, so numbers 2-3 never stay
 * linked after cleanup. `cleanedUpAt` is written
 * only when every logout succeeded, so a bridge outage simply retries on the
 * next hourly pass; logout and clearing are both safe to repeat. Logs carry
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
      let tenantIds = [location.tenantId];
      try {
        const numbers = await repo.listLocationNumbers(location.locationId);
        tenantIds = [...new Set([location.tenantId, ...numbers.map((n) => n.tenantId)])];
      } catch {
        // Unknown number list: log out what we know and retry the rest next pass.
        failures += 1;
        clean = false;
      }
      for (const tenantId of tenantIds) {
        let ok = false;
        try {
          ok = (await deps.logout(tenantId)).ok;
        } catch {
          ok = false;
        }
        if (!ok) {
          failures += 1;
          clean = false;
        }
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
