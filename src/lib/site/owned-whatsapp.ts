import type { GhlRepository } from "@/lib/data/repository";

export type OwnedLocationsRepo = Pick<GhlRepository, "listGhlAccountsForAccount">;

export const NOT_FOUND = { ok: false, code: "invalid_coach_id", message: "That sub-account could not be found." } as const;

/**
 * Runs a bridge call for a location only if the account owns it. The tenant id
 * sent to the bridge is read off the owned row, never supplied by the client.
 */
export async function runOwnedWhatsappAction<T>(
  repo: OwnedLocationsRepo,
  accountId: string,
  locationId: string,
  call: (tenantId: string) => Promise<T>,
): Promise<T | typeof NOT_FOUND> {
  const owned = await repo.listGhlAccountsForAccount(accountId);
  const tenantId = owned.find((a) => a.locationId === locationId)?.tenantId;
  if (!tenantId) return NOT_FOUND;
  return call(tenantId);
}
