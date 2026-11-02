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
  const tenantId = (await ownedLocation(repo, accountId, locationId))?.tenantId;
  if (!tenantId) return NOT_FOUND;
  return call(tenantId);
}

export type OwnedNumbersRepo = OwnedLocationsRepo & Pick<GhlRepository, "getLocationNumberBySlot">;

/** The ONE place an account's ownership of a sub-account is looked up; every dashboard WhatsApp and number action goes through it. */
async function ownedLocation(repo: OwnedLocationsRepo, accountId: string, locationId: string) {
  const owned = await repo.listGhlAccountsForAccount(accountId);
  return owned.find((a) => a.locationId === locationId);
}

/** True only when `locationId` is one of this account's own sub-accounts. Every dashboard number action checks this first. */
export async function ownsLocation(repo: OwnedLocationsRepo, accountId: string, locationId: string): Promise<boolean> {
  return (await ownedLocation(repo, accountId, locationId)) !== undefined;
}

/**
 * Like `runOwnedWhatsappAction`, for ONE number (slot 1-3) of an owned
 * sub-account. The tenant is looked up from the slot inside the owned
 * location only; the browser never names or sees a tenant id.
 */
export async function runOwnedNumberAction<T>(
  repo: OwnedNumbersRepo,
  accountId: string,
  locationId: string,
  slot: number,
  call: (tenantId: string) => Promise<T>,
): Promise<T | typeof NOT_FOUND> {
  if (!(await ownsLocation(repo, accountId, locationId))) return NOT_FOUND;
  const number = await repo.getLocationNumberBySlot(locationId, slot);
  if (!number) return NOT_FOUND;
  return call(number.tenantId);
}
