/**
 * Shared guard for the three `/api/connect/whatsapp/*` routes (connect,
 * status, logout) — the per-client connect-link feature's bridge-facing
 * calls made AFTER `POST /api/connect/session` has already exchanged a link
 * token for a session token (see that route's own header for the exchange
 * step this guard does not do). Built on `runBridgePanelGuard`
 * (`src/lib/bridge-panel-guard.ts`), extracted from
 * `src/app/api/crm/embed/guard.ts`'s original hand-written guard — same
 * shape, same "never throws" contract, same "re-read the account on every
 * call" revocation lever, ONE extra config gate and ONE extra 403 check this
 * feature needs that the embed guard does not (see below).
 *
 * SEVEN CHECKS, IN ORDER, ON EVERY CALL — never trust that
 * `/connect/[token]`'s server component already checked any of these; a
 * stale browser tab, a re-shared session token, or an env that drifted
 * mid-session must all be caught HERE, not assumed from an earlier render:
 *   1. `isConnectLinkConfigured()` — `ONBOARD_STATE_SECRET` unset -> 503.
 *      Deliberately NOT gated on `GHL_SSO_SHARED_SECRET` — see
 *      `src/lib/ghl-connect-link.ts`'s header, "ONBOARD_STATE_SECRET ONLY":
 *      this feature must not inherit the GHL embed's unrelated blocker.
 *   2. `isLiveMode()` — a demo/preview deployment must never drive a real
 *      bridge from this surface, identical rule to the embed guard's own
 *      check 0 and for the identical reason (`assertLiveMode()` throughout
 *      this codebase's other WhatsApp actions).
 *   3. `isWhatsappBridgeConfigured()` — THE ONE GATE THE EMBED GUARD DOES NOT
 *      HAVE. The embed WhatsApp routes call the bridge client functions
 *      regardless (those functions degrade gracefully to `{ ok: false, code:
 *      'unconfigured' }` on their own, per `src/lib/whatsapp-bridge.ts`'s own
 *      DEGRADE-GRACEFULLY CONTRACT) — but `POST /api/connect/session`
 *      (this feature's mint step) ALSO needs to know up front whether a
 *      bridge health probe is even worth attempting, and checking it here too
 *      keeps every `/api/connect/*` route consistent about "is this
 *      deployment able to do anything live at all" rather than one route in
 *      the family answering that question differently from its siblings.
 *   4. `Authorization: Bearer <token>` must verify as a `"ghl-connect-session"`
 *      kind (`verifyConnectSessionToken`, src/lib/ghl-connect-link.ts) —
 *      proves `/api/connect/session` genuinely minted this for a real,
 *      version-matched account at some point. Anything else (missing header,
 *      malformed, expired, tampered, wrong kind) is 401.
 *   5. `getGhlAccountByLocationId(locationId)` is RE-READ from the database
 *      on THIS call — never cached from the mint. A missing row is 403.
 *   6. `disabled` status is 403.
 *   7. `token.v === account.connectLinkVersion` (AND the column is non-null —
 *      see `GhlAccount.connectLinkVersion`'s own JSDoc, src/lib/types.ts, for
 *      why `null` fails closed rather than ever comparing-as-equal to
 *      anything) — THE OTHER CHECK THE EMBED GUARD DOES NOT HAVE. This is
 *      what makes "Revoke all links" (`revokeGhlConnectLinksAction`) cut off
 *      an ALREADY-EXCHANGED session token too, not just future link-token
 *      exchanges — a session token carries the SAME `v` the link token that
 *      minted it carried (`POST /api/connect/session`'s own header), so a
 *      version bump between two polls of an in-progress linking attempt is
 *      caught here on the very next call, exactly like a `disabled` flip is
 *      caught by check 6. Mismatch is 403 `link_revoked` — safe to name
 *      specifically (unlike `unknown_location`, which stays generic): the
 *      bearer already proved a genuine, at-some-point-valid session, so
 *      confirming "the link this came from has since been revoked" tells an
 *      attacker nothing they did not already have to prove first.
 *
 * NEVER RETURNS THE FULL `GhlAccount` — same `PanelGuardAccount` narrowing
 * the embed guard already uses (`tenantId`/`label`/`status` only), for the
 * identical reason (`GhlAccount`'s own JSDoc: never return this from a
 * route).
 */
import type { GhlRepository } from "@/lib/data";
import { isConnectLinkConfigured, verifyConnectSessionToken } from "@/lib/ghl-connect-link";
import { isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import { runBridgePanelGuard, type PanelGuardAccount } from "@/lib/bridge-panel-guard";

/** The narrow repo slice this guard touches — every connect WhatsApp route drives this via `webhookRepo` (no user session exists on these routes; the session token IS the session). */
export type ConnectGuardRepo = Pick<GhlRepository, "getGhlAccountByLocationId">;

/** Structurally identical to the embed guard's `GhlEmbedAccount` — see `PanelGuardAccount`'s own JSDoc (src/lib/bridge-panel-guard.ts). */
export type ConnectGuardAccount = PanelGuardAccount;

export type ConnectGuardResult =
  | { ok: true; account: ConnectGuardAccount }
  | { ok: false; status: 401; error: "missing_token" | "invalid_token" }
  | { ok: false; status: 403; error: "unknown_location" | "account_disabled" | "link_revoked" }
  | { ok: false; status: 503; error: "connect_not_configured" | "bridge_not_configured" }
  | { ok: false; status: 500; error: "internal" };

/**
 * Run every check. Never throws — see `runBridgePanelGuard`'s own header,
 * "NEVER THROWS". A malformed `Authorization` header, an expired/tampered
 * session token, an unconfigured/demo/bridge-less deployment, a revoked
 * link, or a repo hiccup all resolve to one of the typed failure variants
 * above, which `guardFailureResponseBody` below maps to a fixed-string JSON
 * error response (never a stack trace, never the token, never the account).
 */
export async function authorizeConnectRequest(repo: ConnectGuardRepo, authorizationHeader: string | null): Promise<ConnectGuardResult> {
  return runBridgePanelGuard<
    { locationId: string; v: number },
    "connect_not_configured" | "bridge_not_configured",
    "missing_token" | "invalid_token",
    "unknown_location" | "account_disabled" | "link_revoked"
  >(authorizationHeader, {
    gates: [
      { ok: isConnectLinkConfigured, error: "connect_not_configured" },
      { ok: isWhatsappBridgeConfigured, error: "bridge_not_configured" },
    ],
    verifyToken: (token) => {
      const result = verifyConnectSessionToken(token);
      return result.ok ? { locationId: result.locationId, v: result.v } : null;
    },
    missingTokenError: "missing_token",
    invalidTokenError: "invalid_token",
    resolveAccount: async (verified) => {
      const account = await repo.getGhlAccountByLocationId(verified.locationId);
      if (!account) return { ok: false, status: 403, error: "unknown_location" };
      if (account.status === "disabled") return { ok: false, status: 403, error: "account_disabled" };
      // See this file's header, check 7 — `null` (migration not applied, or a
      // malformed read) never compares equal to anything, including a
      // literal `0`, so a pre-0075 database fails this exactly like a
      // genuinely revoked link would.
      if (account.connectLinkVersion === null || verified.v !== account.connectLinkVersion) {
        return { ok: false, status: 403, error: "link_revoked" };
      }
      return { ok: true, account: { tenantId: account.tenantId, label: account.label, status: account.status } };
    },
    logPrefix: "[api/connect/guard] authorizeConnectRequest",
  });
}

/**
 * The uniform `{ ok: false, code, message }` body every one of the three
 * connect WhatsApp routes renders for a non-ok guard result — mirrors
 * `src/app/api/crm/embed/guard.ts`'s `guardFailureResponseBody` exactly
 * (same reasoning: a public, unauthenticated-until-proven surface, generic
 * messages, a missing `switch` arm is a compile error). `link_revoked` gets
 * its own honest sentence — see this file's header, check 7, for why naming
 * it specifically is safe here.
 */
export function guardFailureResponseBody(result: Exclude<ConnectGuardResult, { ok: true }>): { ok: false; code: string; message: string } {
  switch (result.error) {
    case "missing_token":
    case "invalid_token":
    case "unknown_location":
    case "account_disabled":
      return { ok: false, code: result.error, message: "This connect link is no longer valid — ask for a fresh one." };
    case "link_revoked":
      return { ok: false, code: result.error, message: "This connect link has been revoked — ask for a fresh one." };
    case "connect_not_configured":
    case "bridge_not_configured":
      return { ok: false, code: result.error, message: "WhatsApp linking by link isn't available on this deployment right now." };
    case "internal":
      return { ok: false, code: result.error, message: "Something went wrong. Please try again." };
  }
}

/**
 * Belt-and-braces scrub of `auth.account.tenantId` out of a bridge failure's
 * own free-form `message` string — adversarial review lens 5, finding 8
 * (MINOR, fixed). `redactBridgeSessionResult` (src/lib/bridge-panel-guard.ts,
 * SHARED with the GHL embed feature — deliberately left untouched by this
 * fix) strips `session.coachId` structurally on its SUCCESS branch, but a
 * `BridgeFailure` (`ok: false`) has no `session` object at all, only a
 * `message` string, and passes through unredacted — `connect`/`status`
 * routes' own headers claimed "the tenant id is never returned", which was
 * only true of the success path.
 *
 * VERIFIED, THEN MADE TRUE RATHER THAN JUST DOCUMENTED (per that finding's
 * own instruction). Read `services/whatsapp-bridge/src/server.ts`'s every
 * `sendError(...)` call site (read-only — that service is out of scope to
 * modify): none of them interpolate `coachId` into a `message` string, every
 * one is a fixed, generic sentence. So the claim happens to be true today —
 * but nothing enforced it structurally, which is exactly the kind of
 * guarantee a future bridge change could quietly break without this app ever
 * noticing. This function closes that gap for the connect feature
 * specifically (the embed feature's own guard/routes are untouched, per this
 * task's own constraints) without needing to touch the bridge itself: if the
 * tenant id this route is asking about happens to appear verbatim in a
 * failure message, it is redacted before the response is ever built.
 *
 * A literal substring match, not a smarter pattern — `tenantId` is a UUID
 * (0069's `whatsapp_tenants.id`), so a false-positive match inside an
 * unrelated sentence is not a realistic concern, and matching literally
 * means this can never itself become a source of a subtler bug.
 */
export function scrubTenantIdFromFailure<T extends { ok: false; message: string }>(failure: T, tenantId: string): T {
  if (!tenantId || !failure.message.includes(tenantId)) return failure;
  return { ...failure, message: failure.message.split(tenantId).join("[redacted]") };
}
