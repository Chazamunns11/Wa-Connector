/**
 * Claim token: proves a GoHighLevel sub-account (location) asked to sign up,
 * so `/signup?claim=...` can link that install to the new account. Signed with
 * the shared kinded-state machinery under kind `ghl-claim`, 30-minute TTL.
 * Requires the dedicated ONBOARD_STATE_SECRET, never the CRON_SECRET fallback
 * (same rule as ghl-embed).
 */
import { signKindedState, verifyKindedState } from "@/lib/signed-state";

export const CLAIM_TOKEN_TTL_MS = 30 * 60 * 1000;

export function isClaimConfigured(): boolean {
  return Boolean(process.env.ONBOARD_STATE_SECRET);
}

export function mintClaimToken(locationId: string): string {
  if (!isClaimConfigured()) {
    throw new Error("mintClaimToken called with ONBOARD_STATE_SECRET unset — refusing the CRON_SECRET fallback.");
  }
  return signKindedState("ghl-claim", { locationId }, CLAIM_TOKEN_TTL_MS);
}

export function verifyClaimToken(token: string): { locationId: string } | null {
  if (!isClaimConfigured()) return null;
  const d = verifyKindedState("ghl-claim", token);
  if (!d || typeof d.locationId !== "string" || d.locationId.length === 0) return null;
  return { locationId: d.locationId };
}

export function claimSignupUrl(appUrl: string, locationId: string): string {
  return `${appUrl}/signup?claim=${encodeURIComponent(mintClaimToken(locationId))}`;
}
