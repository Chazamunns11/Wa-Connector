/**
 * GHL custom conversation provider, Phase 1 (WAGHL replacement —
 * docs/GHL-PROVIDER-PLAN.md) — step 2: GHL sends the browser back here with
 * a one-time `code`. Exchange it, map the GHL `locationId` it names to a
 * WhatsApp tenant (minting a fresh one on a genuinely new location, reusing
 * the existing one on a reinstall — see `installGhlLocation` in `./logic.ts`
 * and `Repository.upsertGhlAccount`'s JSDoc), store the tokens, and redirect
 * somewhere human.
 *
 * ============ WHY THE STATE IS RE-VERIFIED AGAINST THE SESSION ============
 * Mirrors `src/app/api/calendar/google/callback/route.ts`'s identical
 * rationale: a signed state proves the START route was hit recently by an
 * authenticated owner; it does NOT prove the browser arriving now is still
 * that owner (someone could capture the state and replay the callback from
 * a different session). So the current session is independently re-checked
 * to still be an owner before anything is written — two facts have to agree:
 * the signature, and who is actually signed in right now.
 *
 * ============ INSTALL VS. REINSTALL ============
 * `tokens.locationId` (from GHL's own token response, never anything this
 * app sent) is the ONLY thing that decides which branch this takes:
 * `getGhlAccountByLocationId` found nothing => a genuinely new location =>
 * `createGhlTenant()` mints a fresh `whatsapp_tenants` row and this becomes
 * that location's bridge session key forever. Found an existing row => a
 * reinstall (GHL re-authorising the same sub-account, e.g. after a token was
 * revoked) => the SAME tenant id is reused and only the tokens/label are
 * refreshed — `upsertGhlAccount`'s UPSERT on `location_id` makes this the
 * only possible outcome even under a concurrent double-callback, since
 * `ghl_accounts.location_id` is the primary key (0069). See `./logic.ts`'s
 * `installGhlLocation` — this is now the ONE place that contract lives, used
 * both for today's single-location exchange and for each location inside a
 * bulk install below.
 *
 * ============ AGENCY / BULK-INSTALL, 4 Aug 2026 ============
 * `src/lib/ghl.ts`'s own header and `GhlExchangeResult`'s JSDoc have the full
 * production-log diagnosis; the short version: the marketplace app's "Can
 * agency bulk install the app?" setting is Yes — deliberately, the operator
 * has ~12 sub-accounts to onboard, not one — and with that setting on, GHL
 * hands back a Company-scoped token instead of a location one.
 * `exchangeGhlCode` used to treat that as an unrecoverable failure
 * (`no_location`); it no longer does. `GhlExchangeResult.kind === "company"`
 * is a NORMAL outcome now: `listGhlInstalledLocations` reads which locations
 * the install actually covers, and `runGhlBulkInstall` (`./logic.ts`) walks
 * them one at a time, exchanging each for a location token
 * (`getGhlLocationTokenFromAgency`) and running the SAME
 * `installGhlLocation` the single-location path uses. A partial failure
 * (some locations installed, some didn't) is reported honestly via the
 * `installed`/`failed` redirect params, never silently swallowed into a bare
 * "connected" — see `back`'s own comment on why counts, not tokens/ids, are
 * the only things ever added to that redirect.
 */
import { NextResponse, type NextRequest } from "next/server";
import { repo } from "@/lib/data";
import { getSession } from "@/lib/auth";
import { exchangeGhlCode, getGhlLocationTokenFromAgency, ghlAppId, isGhlConfigured, listGhlInstalledLocations } from "@/lib/ghl";
import { claimSignupUrl, isClaimConfigured } from "@/lib/ghl-claim";
import { notifyText } from "@/lib/slack";
import { verifyKindedState } from "@/lib/signed-state";
import { brandConfig } from "@/lib/brand-config";
import { GHL_BULK_INSTALL_CAP, installGhlLocation, runGhlBulkInstall } from "./logic";

export const dynamic = "force-dynamic";

/**
 * 25 locations × `src/lib/ghl.ts`'s own 5s `TIMEOUT_MS` per
 * `oauth/locationToken` exchange ≈ 125s worst case if every single one timed
 * out (see `GHL_BULK_INSTALL_CAP`'s own JSDoc, `./logic.ts`) — plus the one
 * `oauth/installedLocations` read (another 5s worst case) and a handful of
 * fast DB upserts. 180s is generous headroom above that theoretical ceiling
 * without approaching this platform's own outer limit (see
 * `src/app/api/cron/reminders/route.ts`'s `maxDuration = 300` for the
 * existing precedent of setting this explicitly rather than trusting the
 * platform default, which this route never needed before bulk install
 * existed — a single-location exchange finishes in well under a second).
 */
export const maxDuration = 180;

function currentBase(): string {
  return brandConfig().appUrl;
}

/**
 * `extra` is ALWAYS a small closed set of plain counts (`installed`/`failed`/
 * `capped`) — never a token, code, `companyId`, or `locationId`, matching
 * this file's own header's "NEVER 500s" section's existing rule that nothing
 * sensitive is ever put in this redirect. A count is not sensitive; it's the
 * whole reason `/owner/setup-links` (`GhlAccountsPanel`'s result banner) can
 * say something truthful like "installed 10, 2 failed" instead of a bare
 * pass/fail.
 */
function back(reason: string, extra?: Record<string, string>, path = "/admin"): NextResponse {
  const url = new URL(`${path}?ghl=${reason}`, currentBase());
  if (extra) for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  if (!isGhlConfigured()) return back("unavailable");

  const params = request.nextUrl.searchParams;

  // The owner pressed "Cancel" on GHL's consent screen. Not an error — send
  // them back quietly rather than showing a failure.
  if (params.get("error")) return back("cancelled");

  const code = params.get("code");
  if (!code) return back("invalid");

  // ============ WHY A MISSING STATE IS TOLERATED (4 Aug 2026) ============
  // GHL has TWO install routes and only one of them can carry our state:
  //
  //   1. Portal-initiated (`/api/crm/oauth/start`) — we mint the state, so it
  //      arrives here and is verified below exactly as it always was.
  //   2. GHL-initiated, location-scoped — the URL the marketplace's
  //      "Test Link" dialog generates
  //      (`app.gohighlevel.com/v2/location/<id>/integration/<app>/versions/<v>`).
  //      GHL builds that URL itself and sends NO state.
  //
  // Route 2 is not a convenience — it is the ONLY route that can install to a
  // sub-account of our choosing, and therefore the only way to onboard a
  // client at all. Route 1 goes through GHL's `/oauth/chooselocation`, which
  // force-pins whichever location the marketplace session happens to hold,
  // OVERWRITES any `location_id` we pass, and renders a confirmation with no
  // Locations block — so it can only ever reach that one sub-account, and the
  // token comes back Company-scoped (`no_location`). All of that was proven
  // by experiment on 4 Aug 2026, including in a clean incognito session; see
  // docs/GHL-PROVIDER-CLIENT-MIGRATION.md. Requiring a state here made
  // installing the other eleven clients impossible.
  //
  // WHAT STILL PROTECTS THIS. The state was never the authorisation — the
  // session check below is, and it is unchanged. This file's header already
  // said as much: a signed state "does NOT prove the browser arriving now is
  // still that owner", which is exactly why the session is re-checked
  // independently. What the state additionally bought was CSRF and recency
  // proof. Residual risk once it is absent: someone holding a GHL
  // authorisation code for a location THEY control could induce a signed-in
  // owner's browser to hit this URL and get that location written into
  // `ghl_accounts`. That row is visible on /owner/setup-links and deletable,
  // it cannot send anything until a WhatsApp number is deliberately linked to
  // it, and 0069's kind-pinned FK still makes it impossible for it to resolve
  // to a coach's personal tenant. Accepted deliberately: a stray row an owner
  // can see and delete beats being unable to onboard clients at all.
  const state = params.get("state");
  const verified = state ? verifyKindedState("ghl-install", state) : null;
  if (state && !verified) {
    return back("expired"); // tampered, wrong kind, or older than the state TTL.
  }

  // THE authorisation — see this file's header, and the block above for why
  // it now carries the full weight on GHL-initiated installs.
  //
  // THREE CASES (accounts stage):
  //   - owner session: installs for the operator, accountId null, back to /admin;
  //   - account session: installs for that account, back to /dashboard;
  //   - no session AND no state: GHL's own Marketplace install. It installs an
  //     UNCLAIMED row (accountId null) and sends the browser to /signup, with a
  //     30-minute claim token when exactly one location was installed, so the
  //     new account can take it over. The token travels only in that redirect
  //     and is never logged.
  // A state with no matching session (expired login, other browser) is refused:
  // the state says a signed-in user started this, so that user must still be here.
  const session = await getSession();
  const sessionAccountId = session?.role === "account" ? session.accountId : null;
  if (session && session.role === "account" && !sessionAccountId) return back("forbidden");
  const marketplace = !session && !state;
  if (!marketplace) {
    if (!session) return back("forbidden");
    if (session.role !== "owner" && session.role !== "account") return back("forbidden");
    if (verified) {
      const stateAccountId = typeof verified.accountId === "string" ? verified.accountId : null;
      if (stateAccountId !== sessionAccountId) return back("forbidden");
    }
  }
  const accountId = sessionAccountId;
  const dest = marketplace ? "/signup" : accountId ? "/dashboard" : "/admin";
  const brandName = brandConfig().name;
  const fail = (reason: string): NextResponse => (marketplace ? finish(reason, {}) : back(reason, undefined, dest));
  const conflictNote = (locationId: string) =>
    void notifyText(`GHL location ${locationId} is already connected to another ${brandName} account; install by ${accountId} skipped.`);

  /** Final redirect: the Marketplace path goes to /signup (with a claim link for a single location), the others to their dashboard. */
  const finish = (reason: string, extra: Record<string, string>, claimLocationId?: string | null): NextResponse => {
    if (!marketplace) return back(reason, extra, dest);
    const url = new URL("/signup?from=ghl", currentBase());
    if (claimLocationId && isClaimConfigured()) {
      try {
        const claim = new URL(claimSignupUrl(currentBase(), claimLocationId));
        const token = claim.searchParams.get("claim");
        if (token) url.searchParams.set("claim", token);
      } catch {
        // No claim link: the customer can still sign up and connect from the dashboard.
      }
    }
    return NextResponse.redirect(url);
  };

  const exchange = await exchangeGhlCode(code);
  if (!exchange) return fail("exchange_failed");

  // ============ LOCATION-SCOPED — today's single-location path, unchanged ============
  if (exchange.kind === "location") {
    const tokens = exchange.tokens;
    // Structurally guaranteed by `exchangeGhlCode` itself now (a `"location"`
    // result is only ever constructed when `tokens.locationId` is truthy —
    // see its own JSDoc) — kept as an explicit check anyway rather than a
    // type assertion, same "never 500s" defence-in-depth as `appId` below.
    if (!tokens.locationId) return fail("no_location");
    // GHL's own OAuth exchange always returns a refresh token (unlike
    // Google's consent-dependent behaviour) — refusing rather than storing a
    // row that could never actually refresh is the same "better no
    // connection than a half-dead one" call the Google callback makes for
    // the same reason.
    if (!tokens.refreshToken) return fail("no_refresh_token");
    const outcome = await installGhlLocation(repo, tokens, null, accountId);
    if (outcome === "conflict") {
      conflictNote(tokens.locationId);
      return finish("conflict", { conflicts: "1" });
    }
    return outcome === "installed" ? finish("connected", {}, tokens.locationId) : fail("save_failed");
  }

  // ============ COMPANY-SCOPED — bulk install, 4 Aug 2026 fix (see this file's own header) ============
  const appId = ghlAppId();
  // Structurally can't happen — `isGhlConfigured()` already gated this whole
  // route above, and `ghlAppId()` fails only under the identical
  // unconfigured condition — but checked explicitly rather than asserted,
  // matching this file's own "never 500s" contract over "this can't happen".
  if (!appId) return fail("unavailable");

  const locations = await listGhlInstalledLocations(exchange.accessToken, exchange.companyId, appId);
  if (!locations) return fail("bulk_locations_failed");
  if (locations.length === 0) return fail("bulk_no_locations");

  const agencyAccessToken = exchange.accessToken;
  const result = await runGhlBulkInstall(
    repo,
    { getLocationToken: (companyId, locationId) => getGhlLocationTokenFromAgency(agencyAccessToken, companyId, locationId), onConflict: conflictNote },
    exchange.companyId,
    locations,
    GHL_BULK_INSTALL_CAP,
    accountId
  );

  const extra: Record<string, string> = { installed: String(result.installed) };
  if (result.failed > 0) extra.failed = String(result.failed);
  if (result.skippedOverCap > 0) extra.capped = String(result.skippedOverCap);
  if (result.conflicts > 0) extra.conflicts = String(result.conflicts);
  const reason = result.installed === 0 && result.failed === 0 && result.conflicts > 0 ? "conflict" : result.installed === 0 && result.failed > 0 ? "bulk_failed" : result.failed > 0 ? "bulk_partial" : "bulk_installed";
  return finish(reason, extra);
}
