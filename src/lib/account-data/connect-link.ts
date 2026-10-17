import { repo } from "@/lib/data";
import { brandConfig } from "@/lib/brand-config";
import { isConnectLinkConfigured, mintConnectLinkToken } from "@/lib/ghl-connect-link";

/**
 * A fresh 7-day connect link for a location the account owns, or null when
 * connect links are not configured or the location is not the account's. The
 * token is minted on demand for the page render and never put in a URL.
 */
export async function connectLinkForOwnedLocation(accountId: string, locationId: string): Promise<string | null> {
  if (!isConnectLinkConfigured()) return null;
  const location = await repo.getGhlAccountByLocationId(locationId);
  if (!location || location.accountId !== accountId || location.connectLinkVersion === null) return null;
  return `${brandConfig().appUrl}/connect/${mintConnectLinkToken(locationId, location.connectLinkVersion, "send")}`;
}
