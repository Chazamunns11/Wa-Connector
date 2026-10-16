/**
 * GHL custom conversation provider, Phase 1 (WAGHL replacement —
 * docs/GHL-PROVIDER-PLAN.md) — step 1 of installing this provider onto a GHL
 * sub-account: mint a signed state and bounce the browser to GHL's own
 * "choose location" consent screen.
 *
 * A GET ROUTE, NOT A SERVER ACTION — same reasoning as
 * src/app/api/calendar/google/start/route.ts: the whole job is a redirect to
 * a third-party origin, which a server action can't do from a form post
 * without a client-side hop, and which needs to survive being opened in a
 * new tab.
 *
 * OWNER OR ACCOUNT SESSION: an owner installs for the operator (state
 * `{ accountId: null }`); a signed-in customer account installs for itself
 * (`{ accountId }`), and the callback stamps that account on the location. An
 * anonymous browser is refused (the sessionless Marketplace install does not
 * go through here — GHL sends it straight to the callback).
 *
 * NO LOCATION IN THE URL, DELIBERATELY: there is no way to name a GHL location in
 * this URL — GHL's OWN "choose location" flow is what asks WHICH sub-account
 * (mirrors `googleAuthUrl`'s "whose calendar" boundary — see that route's
 * JSDoc), so this route's only job is proving the browser making the
 * request is an authenticated owner before ever redirecting to GHL. The
 * signed state carries no payload (`{}`) — there is nothing
 * location-specific to prove ahead of time; see `SignedStateKind`'s
 * `'ghl-install'` JSDoc (src/lib/onboarding.ts) for why.
 */
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ghlAuthUrl, isGhlConfigured } from "@/lib/ghl";
import { signKindedState } from "@/lib/signed-state";
import { brandConfig } from "@/lib/brand-config";

export const dynamic = "force-dynamic";

function currentBase(): string {
  return brandConfig().appUrl;
}

/** Where a failure sends the owner back to, with a reason the setup-links page renders as a friendly line. */
function back(reason: string, path = "/admin"): NextResponse {
  return NextResponse.redirect(new URL(`${path}?ghl=${reason}`, currentBase()));
}

export async function GET() {
  if (!isGhlConfigured()) return back("unavailable");

  const session = await getSession();
  const isAccount = !!session && session.role === "account" && !!session.accountId;
  if (!session || (session.role !== "owner" && !isAccount)) return back("forbidden");
  const dest = isAccount ? "/dashboard" : "/admin";
  const accountId = isAccount ? session.accountId : null;

  const state = signKindedState("ghl-install", { accountId });
  const url = ghlAuthUrl(state);
  if (!url) return back("unavailable", dest);

  return NextResponse.redirect(url);
}
