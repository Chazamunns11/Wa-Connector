/**
 * `GET /api/crm/oauth/callback`'s per-location write, and the bulk-install
 * loop built on top of it (4 Aug 2026 fix — see `route.ts`'s own header and
 * `src/lib/ghl.ts`'s `GhlExchangeResult` JSDoc for the production bug this
 * closes: a Company-scoped/bulk-install token used to bounce the whole
 * callback with `no_location` instead of being exchanged into per-location
 * tokens). Extracted out of `route.ts` for the SAME reason
 * `src/app/api/connect/session/logic.ts` exists — see that file's own header
 * — this route's decision logic was previously wired directly into a
 * `NextRequest`/`NextResponse` handler that a plain `node --test` run cannot
 * construct, so it had no test coverage of its own beyond what a live GHL
 * install could exercise.
 *
 * DELIBERATELY ZERO NEXT IMPORTS, same discipline as
 * `src/app/api/connect/session/logic.ts` — this must stay loadable under
 * `scripts/test/alias-hook.mjs`'s plain-node loader. `route.ts` is the only
 * thing in this feature that imports `next/server`; this file imports only
 * `@/lib/ghl`'s types and `@/lib/data`'s `Repository` TYPE (erased at compile
 * time — no runtime dependency on `next/headers`, mirroring
 * `src/app/api/connect/guard.ts`'s identical `WebhookRepository` type-only
 * import).
 *
 * WHAT MOVED HERE FROM `route.ts`, AND WHAT DIDN'T: the install-vs-reinstall
 * upsert (`installGhlLocation`, verbatim logic, previously inline in the GET
 * handler) and the new bulk-install loop (`runGhlBulkInstall`) moved here.
 * The owner-session guard, the signed-state check, `exchangeGhlCode` itself,
 * `listGhlInstalledLocations`, and every redirect all stay in `route.ts` —
 * `getSession()` alone pulls in `next/headers` transitively, so ANY of that
 * moving here would break this file's whole reason for existing.
 */
import type { GhlRepository } from "@/lib/data";
import type { GhlTokens } from "@/lib/ghl";

/**
 * The narrow repo slice this file touches — exactly the three methods
 * `route.ts`'s original single-location install/reinstall logic used.
 * OWNER-SESSION-SCOPED (the real `repo`, not `webhookRepo`) in production,
 * same as `route.ts` always was — this feature has never run sessionless
 * (see `route.ts`'s own header, "THE authorisation").
 */
export type GhlOauthCallbackRepo = Pick<GhlRepository, "getGhlAccountByLocationId" | "upsertGhlAccount" | "createGhlTenant" | "claimGhlAccount">;

/**
 * The install (or reinstall) write for ONE GHL location — moved verbatim out
 * of `route.ts`'s GET handler, not rewritten, so today's single-location path
 * (a fresh install or a reinstall) behaves EXACTLY as it did before this fix.
 * The bulk-install loop below calls this SAME function once per location
 * precisely so a bulk install can never diverge from that already-reviewed
 * behaviour — see `route.ts`'s own header, "INSTALL VS. REINSTALL", for the
 * full contract this preserves (the tenant-mint-once-per-genuinely-new-
 * location rule, the known concurrent-callback race accepted as harmless,
 * the reinstall-keeps-its-label rule).
 *
 * Guards `locationId`/`refreshToken` internally rather than trusting the
 * caller to have already checked — `route.ts`'s single-location path DOES
 * check both before calling this (so it can redirect with the specific
 * `no_location`/`no_refresh_token` reason), but `runGhlBulkInstall` below
 * calls this once per location with whatever `getGhlLocationTokenFromAgency`
 * happened to return, and a per-location failure there should just count
 * against `failed`, not need its own distinguishable reason code. One
 * invariant, enforced in one place, satisfied by both callers.
 *
 * NEVER THROWS — every repo call is inside its own try/catch, matching
 * `route.ts`'s own "NEVER 500s" contract for the single-location path and
 * the "partial failure must not abort the batch" requirement the
 * multi-location path needs (see `runGhlBulkInstall`'s own JSDoc).
 */
/** `conflict`: the location already belongs to a different account, so nothing was written. */
export type InstallOutcome = "installed" | "conflict" | "failed";

export async function installGhlLocation(
  repo: GhlOauthCallbackRepo,
  tokens: GhlTokens,
  /**
   * The sub-account's real business name, when the caller happens to know it.
   *
   * ONLY the bulk path can supply this, and that asymmetry is GHL's, not
   * ours: `oauth/installedLocations` returns a `name` per location, whereas
   * the single-location token exchange returns ids and nothing else. Passing
   * it through means a bulk install lands as "12X Coaching" rather than
   * "GHL location szJkr15M4j4HcqbIFwuq" — which matters more than it sounds,
   * because the operator installs ~12 of these in one run and would otherwise
   * have to identify each opaque id by hand afterwards (we did exactly that
   * once, on 4 Aug 2026, and it is not worth repeating per client).
   *
   * Precedence below is deliberate: an existing label always wins, so a
   * reinstall or a bulk re-run can never overwrite a name the owner typed
   * themselves — see the "reinstall-keeps-its-label" rule in `route.ts`'s
   * header, which this extends rather than replaces.
   */
  locationName?: string | null,
  /**
   * The account installing, or null for an owner install or an unclaimed
   * Marketplace install. A location already owned by a DIFFERENT account is a
   * conflict (nothing written). A null account never changes ownership: it
   * refreshes tokens on any row and leaves account_id as it was.
   */
  accountId: string | null = null
): Promise<InstallOutcome> {
  if (!tokens.locationId || !tokens.refreshToken) return "failed";
  const locationId = tokens.locationId;
  const refreshToken = tokens.refreshToken;
  // Normalised to `undefined` rather than left as-is, because `??` only
  // falls through on null/undefined: an empty or whitespace-only `name`
  // (GHL returns one for sub-accounts whose business name was never filled
  // in) would otherwise be used verbatim and produce a BLANK row in the
  // owner panel — strictly worse than the id placeholder it replaced.
  const resolvedName = locationName?.trim() ? locationName.trim() : undefined;
  try {
    const existing = await repo.getGhlAccountByLocationId(locationId);
    if (accountId && existing?.accountId && existing.accountId !== accountId) return "conflict";
    // KNOWN RACE (adversarial-review finding 10, accepted as harmless/
    // cosmetic — not fixed here, carried over verbatim from `route.ts`):
    // two concurrent callbacks for the SAME genuinely-new `locationId` can
    // both see `existing === null` here and both call `createGhlTenant()`,
    // minting two `whatsapp_tenants` rows. `upsertGhlAccount`'s
    // `onConflict: "location_id"` guarantees only ONE of those tenant ids
    // ever ends up referenced by `ghl_accounts` (`location_id` is the
    // primary key — whichever upsert lands last wins), so the outcome is
    // correct; the LOSING tenant simply becomes an orphaned,
    // permanently-unreferenced `whatsapp_tenants` row. Pre-connect only,
    // harmless: an orphan row here costs one unused UUID forever, never a
    // mis-wired session. The bulk-install loop below makes this no more
    // likely than it already was — GHL never sends the same `locationId`
    // twice in one `installedLocations` response.
    const tenantId = existing ? existing.tenantId : await repo.createGhlTenant();

    await repo.upsertGhlAccount({
      locationId,
      tenantId,
      // Existing label first (never overwrite what the owner set, or what a
      // previous run resolved), then GHL's own business name when the caller
      // had one (bulk path only — see `locationName`'s JSDoc), then the id
      // placeholder as a last resort so the row is at least identifiable.
      label: existing?.label ?? resolvedName ?? `GHL location ${locationId}`,
      companyId: tokens.companyId,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      refreshToken,
    });
    // Stamp ownership only where the row is unowned. The claim is a conditional
    // UPDATE (account_id IS NULL), so losing a race to another account is a
    // conflict rather than a silent steal.
    if (accountId && !existing?.accountId) {
      const claimed = await repo.claimGhlAccount(locationId, accountId);
      if (!claimed) return "conflict";
    }
    return "installed";
  } catch (err) {
    console.error("[ghl/oauth/callback] could not save account:", err);
    return "failed";
  }
}

/**
 * The bulk-install loop's cap. GHL's own documented contract for a
 * Company-scoped ("Can agency bulk install the app?" = Yes) exchange is
 * worked through end-to-end for the first time by this fix — see
 * `src/lib/ghl.ts`'s `GhlExchangeResult` JSDoc and `route.ts`'s own header.
 * 25 is comfortably above the ~12 sub-accounts this operator actually needs
 * to onboard (the whole reason bulk install is switched on at all — see
 * `route.ts`'s header), while still keeping this request's worst case
 * bounded: each location costs one `oauth/locationToken` POST (bounded by
 * `src/lib/ghl.ts`'s own `TIMEOUT_MS`, 5s) plus one upsert, run SEQUENTIALLY
 * (see `runGhlBulkInstall`'s own header for why) — 25 × 5s ≈ 125s worst
 * case if every single exchange timed out, comfortably inside `route.ts`'s
 * own `maxDuration`.
 *
 * NOT A SILENT CAP (this repo's explicit convention): a company install
 * covering more than this many locations in one run reports
 * `skippedOverCap` rather than quietly dropping the rest — see
 * `GhlBulkInstallResult.skippedOverCap`'s own JSDoc and `route.ts`'s
 * `capped` redirect param.
 */
export const GHL_BULK_INSTALL_CAP = 25;

/** Every external dependency `runGhlBulkInstall` needs beyond the repo — injected so tests can fake per-location success/failure without a real GHL endpoint. `defaultGhlBulkInstallDeps`-equivalent wiring lives in `route.ts` itself (a one-line closure over the agency access token), not exported from here — there is nothing else to default. */
export interface GhlBulkInstallDeps {
  /** `getGhlLocationTokenFromAgency` (src/lib/ghl.ts) in production, bound to this callback's own agency access token — `null` means that ONE location's exchange failed and counts against `failed`, never aborts the run. */
  getLocationToken: (companyId: string, locationId: string) => Promise<GhlTokens | null>;
  /** Called with each location id skipped because another account owns it (the route sends the Slack note). */
  onConflict?: (locationId: string) => void;
}

export interface GhlBulkInstallResult {
  /** How many locations `route.ts` handed in — i.e. what `listGhlInstalledLocations` actually returned for this company, BEFORE the cap below is applied. What "hit the per-run cap" is measured against. */
  totalFound: number;
  installed: number;
  failed: number;
  /** Locations skipped because another account already owns them. */
  conflicts: number;
  /** `totalFound` minus however many were actually attempted this run. `> 0` means `GHL_BULK_INSTALL_CAP` was hit — these locations were never even tried, so they must never be folded into `failed` (that would claim GHL rejected them, which is false) or silently dropped (see `GHL_BULK_INSTALL_CAP`'s own JSDoc, "NOT A SILENT CAP"). */
  skippedOverCap: number;
}

/**
 * One call per location `route.ts` resolved from `listGhlInstalledLocations`,
 * capped at `cap` (`GHL_BULK_INSTALL_CAP` in production, overridable here
 * purely so tests can pin cap behaviour without constructing 26 fixture
 * locations).
 *
 * SEQUENTIAL, DELIBERATELY, NOT `Promise.all`: GHL rate-limits the token
 * endpoint, and a stampede of up to `cap` concurrent `oauth/locationToken`
 * POSTs the instant an operator's browser lands back on this callback is
 * exactly the shape of traffic a rate limiter exists to throttle — a 429 on
 * location #3 would then cascade into every location after it failing for a
 * reason that has nothing to do with that location. One at a time costs
 * latency (bounded — see `GHL_BULK_INSTALL_CAP`'s own arithmetic), not
 * correctness.
 *
 * PARTIAL FAILURE NEVER ABORTS THE BATCH: `deps.getLocationToken` and
 * `installGhlLocation` both already never throw (see their own contracts),
 * so this loop has nothing to catch — but the counting itself is the whole
 * point: "10 installed, 2 failed" must be an honest, complete number, never
 * an early return that silently drops the locations after the first
 * failure.
 */
export async function runGhlBulkInstall(
  repo: GhlOauthCallbackRepo,
  deps: GhlBulkInstallDeps,
  companyId: string,
  locations: { locationId: string; name: string | null }[],
  cap: number = GHL_BULK_INSTALL_CAP,
  accountId: string | null = null
): Promise<GhlBulkInstallResult> {
  const totalFound = locations.length;
  const toProcess = locations.slice(0, cap);
  let installed = 0;
  let failed = 0;
  let conflicts = 0;
  for (const location of toProcess) {
    const tokens = await deps.getLocationToken(companyId, location.locationId);
    if (!tokens) {
      failed++;
      continue;
    }
    // `location.name` is the whole reason the bulk path reads
    // `installedLocations` rather than working from ids alone — see
    // `installGhlLocation`'s `locationName` JSDoc.
    const outcome = await installGhlLocation(repo, tokens, location.name, accountId);
    if (outcome === "installed") installed++;
    else if (outcome === "conflict") {
      conflicts++;
      deps.onConflict?.(location.locationId);
    } else failed++;
  }
  return { totalFound, installed, failed, conflicts, skippedOverCap: totalFound - toProcess.length };
}
