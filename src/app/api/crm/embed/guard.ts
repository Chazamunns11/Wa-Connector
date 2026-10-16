/**
 * Shared guard for the three `/api/crm/embed/whatsapp/*` routes (connect,
 * status, logout) — the GHL Custom Page embed's bridge-facing calls made
 * AFTER `POST /api/crm/embed/session` has already minted a token (see that
 * route's own header for the session-mint step this guard does not do).
 *
 * NOW A THIN WRAPPER over `runBridgePanelGuard` (`src/lib/bridge-panel-guard.ts`,
 * built for the per-client connect-link feature —
 * docs/GHL-PROVIDER-CLIENT-MIGRATION.md — so that feature's own
 * `src/app/api/connect/guard.ts` could reuse this guard's exact reviewed
 * shape instead of a second hand-copied one). EVERY NAME THIS FILE EXPORTS,
 * AND THE EXACT VALUE OF EVERY RESULT `authorizeGhlEmbedRequest` RETURNS, IS
 * UNCHANGED BY THIS REFACTOR — this is the regression tripwire:
 * `scripts/test/ghl-embed.test.ts` and every existing route under
 * `src/app/api/crm/embed/whatsapp/*` must keep compiling and passing
 * UNTOUCHED. The four checks below, and their order, are restated from this
 * file's original header rather than re-derived, because that header's
 * reasoning (the kill-switch gap, why step 2 re-reads every time, the
 * kind-pinning guarantee) is still exactly correct — only WHERE the
 * orchestration code lives has moved.
 *
 * FOUR CHECKS, IN ORDER, ON EVERY CALL:
 *   0. `isGhlEmbedConfigured()` AND `isLiveMode()` — see "THE KILL-SWITCH
 *      GAP" below. Anything false is 503.
 *   1. `Authorization: Bearer <token>` must verify as a `"ghl-embed"`-kind
 *      state (`verifyGhlEmbedToken`, src/lib/ghl-embed.ts) — proves a recent
 *      GHL-signed SSO handshake vouched for the `locationId` inside it.
 *      Anything else (missing header, malformed token, expired, tampered,
 *      wrong kind) is 401.
 *   2. `getGhlAccountByLocationId(locationId)` is RE-READ from the database
 *      on THIS call — never cached from the mint, never trusted from the
 *      token payload beyond the bare id. A missing row or a `disabled`
 *      status is 403.
 *
 * WHY STEP 2 RE-READS EVERY TIME rather than trusting the token alone: this
 * is the revocation lever. An owner disabling a GHL location in
 * `GhlAccountsPanel` (src/components/owner/GhlAccountsPanel.tsx) must cut
 * that location's embed access off quickly — a 15-minute-lived token that
 * kept working purely because it was already minted would mean disabling an
 * account from the owner panel could take up to 15 minutes to actually bite.
 * Re-reading the account on every poll (the panel polls every 2.5s while
 * linking) means a disable takes effect within one poll tick instead.
 *
 * THE KILL-SWITCH GAP (adversarial review lens 4, finding 3 — MAJOR, fixed).
 * Check 0 used to exist ONLY on `POST /api/crm/embed/session` (the token-mint
 * step) — this guard checked nothing but token+DB. That meant flipping
 * `GHL_SSO_SHARED_SECRET` off as an emergency kill switch, or a demo/preview
 * deployment's env drifting mid-flight, did NOT stop an already-minted embed
 * token (up to `EMBED_TOKEN_TTL_MS` = 15 minutes old) from continuing to
 * fetch a live QR or log a number out through these three routes — only the
 * MINTING of new tokens was actually gated. Moving both checks into this
 * shared guard closes that for connect/status/logout at once, and
 * structurally: any future embed route that authorizes via this guard
 * inherits both checks automatically rather than needing to remember them.
 *
 * KIND-PINNING HOLDS STRUCTURALLY, NOT JUST BY CONVENTION: every
 * `ghl_accounts` row's `tenant_id` can only ever reference a
 * `whatsapp_tenants` row of kind `'ghl_location'` (0069's FK constraint —
 * see that migration and `GhlAccountsPanel.tsx`'s own header for the
 * "a GHL tenant id was never a coach id" restatement). So even in the
 * worst case — a forged or somehow-valid embed token naming a real
 * `locationId` — the tenant id this guard resolves and hands to the bridge
 * client can NEVER be a coach's personal WhatsApp tenant id. This embed path
 * structurally cannot reach anything but a GHL sub-account's own number.
 *
 * GENUINELY TOTAL, NOT JUST DOCUMENTED AS SUCH (adversarial review lens 4,
 * finding 6 — MINOR, fixed). This function's own contract has always
 * claimed "never throws" — `runBridgePanelGuard`'s own single try/catch is
 * what actually enforces that now (see `src/lib/bridge-panel-guard.ts`'s
 * header), same guarantee, new location.
 */
import type { GhlRepository } from "@/lib/data";
import { isGhlEmbedConfigured, verifyGhlEmbedToken } from "@/lib/ghl-embed";
import type { BridgeFailure, BridgeSessionResult, BridgeSessionSnapshot } from "@/lib/whatsapp-bridge";
import { runBridgePanelGuard, redactBridgeSessionResult as sharedRedactBridgeSessionResult, type PanelGuardAccount } from "@/lib/bridge-panel-guard";

/** The narrow repo slice this guard touches — every embed WhatsApp route drives this via `webhookRepo` (no user session exists on these routes; the token IS the session). */
export type GhlEmbedGuardRepo = Pick<GhlRepository, "getGhlAccountByLocationId">;

/**
 * What a successful guard result hands the route (adversarial review lens 4,
 * finding 5 — MINOR, fixed). Deliberately NOT `GhlAccount` — that type
 * carries `accessToken`/`refreshToken` and its own JSDoc says "Never return
 * this from a page, a server action's caller, or any client component". No
 * route serialized the guard's old `{ ok: true; account: GhlAccount }`
 * result today, but nothing stopped a future `NextResponse.json(auth.account)`
 * from doing exactly that. Narrowing to the three fields the routes actually
 * use makes that leak structurally impossible rather than merely
 * undiscovered.
 *
 * Structurally identical to `PanelGuardAccount` (src/lib/bridge-panel-guard.ts)
 * — kept as this file's own named alias so every existing import of
 * `GhlEmbedAccount` elsewhere in this codebase keeps compiling unchanged.
 */
export type GhlEmbedAccount = PanelGuardAccount;

export type GhlEmbedGuardResult =
  | { ok: true; account: GhlEmbedAccount }
  | { ok: false; status: 401; error: "missing_token" | "invalid_token" }
  | { ok: false; status: 403; error: "unknown_location" | "account_disabled" }
  | { ok: false; status: 503; error: "embed_not_configured" }
  | { ok: false; status: 500; error: "internal" };

/**
 * Run every check. Never throws — see `runBridgePanelGuard`'s own header,
 * "NEVER THROWS". A malformed `Authorization` header, an expired/tampered
 * token, an unconfigured/demo deployment, or a repo hiccup all resolve to
 * one of the typed failure variants above, which `guardFailureResponseBody`
 * below maps to a fixed-string JSON error response (never a stack trace).
 */
export async function authorizeGhlEmbedRequest(repo: GhlEmbedGuardRepo, authorizationHeader: string | null): Promise<GhlEmbedGuardResult> {
  return runBridgePanelGuard<{ locationId: string }, "embed_not_configured", "missing_token" | "invalid_token", "unknown_location" | "account_disabled">(
    authorizationHeader,
    {
      // Check 0 — see this file's header, "THE KILL-SWITCH GAP". Cheapest
      // checks first, same order `POST /api/crm/embed/session` already uses.
      gates: [
        { ok: isGhlEmbedConfigured, error: "embed_not_configured" },
      ],
      verifyToken: verifyGhlEmbedToken,
      missingTokenError: "missing_token",
      invalidTokenError: "invalid_token",
      resolveAccount: async (verified) => {
        const account = await repo.getGhlAccountByLocationId(verified.locationId);
        if (!account) return { ok: false, status: 403, error: "unknown_location" };
        if (account.status === "disabled") return { ok: false, status: 403, error: "account_disabled" };
        return { ok: true, account: { tenantId: account.tenantId, label: account.label, status: account.status } };
      },
      logPrefix: "[api/crm/embed/guard] authorizeGhlEmbedRequest",
    }
  );
}

/**
 * The uniform `{ ok: false, code, message }` body every one of the three
 * embed WhatsApp routes renders for a non-ok guard result — centralized here
 * so the JSON shape can never drift between routes, or drift out of sync
 * with `GhlEmbedGuardResult`'s own error union (a missing `switch` arm is a
 * compile error, not a silently-wrong response). `message` is deliberately
 * generic across every code: this is a public, unauthenticated-until-proven
 * surface, and none of these failure reasons are this endpoint's business to
 * explain in more detail than "try reloading inside HighLevel" — see
 * `decryptGhlSsoPayload`'s own "never hand an attacker an oracle" reasoning
 * (src/lib/ghl-embed.ts) for the same instinct applied here.
 */
export function guardFailureResponseBody(result: Exclude<GhlEmbedGuardResult, { ok: true }>): { ok: false; code: string; message: string } {
  switch (result.error) {
    case "missing_token":
    case "invalid_token":
    case "unknown_location":
    case "account_disabled":
      return { ok: false, code: result.error, message: "This linking session is no longer valid — reload this page inside HighLevel to reconnect." };
    case "embed_not_configured":
      return { ok: false, code: result.error, message: "WhatsApp linking from inside HighLevel isn't available on this deployment right now." };
    case "internal":
      return { ok: false, code: result.error, message: "Something went wrong. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// MAJOR 2 follow-on (adversarial review lens 4, finding 2 — the same leak
// class MAJOR 2 fixed on the session route, found while fixing it): `connect`
// and `status` (src/app/api/crm/embed/whatsapp/{connect,status}/route.ts)
// return the bridge's `BridgeSessionResult` verbatim, and
// `BridgeSessionSnapshot.coachId` (src/lib/whatsapp-bridge.ts) IS the same
// tenant id `session/route.ts`'s `summary.coachId` was — the exact id the
// bridge authorizes every call on. Those two routes' own headers already
// claim "nothing in this route's response echoes it back"; until this fix,
// that was false for exactly this field. `redactBridgeSessionResult` is the
// single choke point both routes call before their `NextResponse.json` —
// NOW SHARED with the connect-link feature's own routes via
// `src/lib/bridge-panel-guard.ts` (moved there verbatim; re-exported here
// unchanged so this file's existing named export keeps compiling).
// ---------------------------------------------------------------------------

export type GhlEmbedBridgeSessionSnapshot = Omit<BridgeSessionSnapshot, "coachId">;

export type GhlEmbedBridgeSessionResult = { ok: true; session: GhlEmbedBridgeSessionSnapshot } | BridgeFailure;

/** Strips `coachId` off a bridge session result before it is ever handed to `NextResponse.json` — see this section's header. A `BridgeFailure` (`ok: false`) carries no session at all and passes through untouched. Re-exported unchanged from `src/lib/bridge-panel-guard.ts`. */
export function redactBridgeSessionResult(result: BridgeSessionResult): GhlEmbedBridgeSessionResult {
  return sharedRedactBridgeSessionResult(result);
}
