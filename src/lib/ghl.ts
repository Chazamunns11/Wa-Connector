/**
 * GHL custom conversation provider (WAGHL replacement, Phase 1 — see
 * docs/GHL-PROVIDER-PLAN.md). The only module in the Next app that talks to
 * GoHighLevel: OAuth URL construction, code exchange, on-demand token
 * refresh, the Update Message Status call, and the pure webhook-signature
 * verifier plus two send-path pure helpers. Holds NO opinion about WHEN to
 * send or how to resolve a location to a tenant — that is
 * `src/lib/ghl-provider.ts` (Phase 2, not part of this file), the only
 * caller of the send path.
 *
 * NO SDK, same rationale as `src/lib/google-calendar.ts`: a handful of
 * documented REST endpoints don't justify a dependency's transitive supply
 * chain on a codebase that already treats "plain fetch" as the house style
 * for every third-party integration (this file, google-calendar.ts,
 * slack.ts, whatsapp-bridge.ts).
 *
 * ============ CONFIG GATE ============
 * Every export that talks to GHL degrades to `null`/a fail-closed result
 * when `GHL_CLIENT_ID` + `GHL_CLIENT_SECRET` + `GHL_WEBHOOK_PUBLIC_KEY` are
 * unset — all three, all-or-nothing (`ghlEnv()`), so a half-configured
 * deployment (e.g. OAuth creds set but the webhook key not yet copied in)
 * fails the same way as fully unconfigured rather than half-working. This is
 * what lets this ship to production DARK per the plan's operator checklist:
 * nothing can install, and the (Phase 2) webhook route 503s, until an
 * operator sets all three.
 *
 * ============ VERIFICATION IS FAIL-CLOSED, NOT FAIL-OPEN ============
 * `verifyGhlSignature` is a PURE function — it takes the public key as a
 * parameter rather than reading env itself, so it is independently testable
 * with a synthetic keypair (no live GHL webhook needed) and so its caller
 * (the Phase 2 webhook route) owns the "key unset" decision explicitly:
 * unset + live => 503 (fail-closed, matches the Stripe webhook route's
 * pattern in src/app/api/webhooks/stripe/route.ts), unset + demo => warn and
 * continue. This module does not make that call itself.
 *
 * ============ NEVER THROWS ============
 * Every network-calling export here returns a discriminated result (or
 * `null`) rather than throwing, mirroring google-calendar.ts's
 * `CalendarMutation`/never-throws contract — a GHL outage or a malformed
 * response must never surface as an uncaught rejection in the OAuth routes
 * or (Phase 2) the webhook route.
 */
import { createHash, verify as cryptoVerify } from "crypto";
import { brandConfig } from "@/lib/brand-config";

/**
 * CONFIRMED against the marketplace app's own "Install link" on 3 Aug 2026,
 * not guessed: GHL generates `/v2/oauth/chooselocation` and it is NOT
 * interchangeable with the `/oauth/chooselocation` this file used to build.
 * The old path failed with `error.noAppVersionIdFound` plus "No integration
 * found with the id", because it carries no `version_id` (see
 * `ghlAuthUrl`) — symptoms that read like an app-configuration problem and
 * cost an hour of looking in the wrong place.
 */
const AUTH_ENDPOINT = "https://marketplace.gohighlevel.com/v2/oauth/chooselocation";
const TOKEN_ENDPOINT = "https://services.leadconnectorhq.com/oauth/token";
const API_BASE = "https://services.leadconnectorhq.com";

/**
 * ASSUMED, not confirmed by the docs fetch (plan §0) — GHL's REST API
 * versioning header value for the conversations endpoints this module
 * calls. Sent explicitly on every call rather than omitted, so a wrong value
 * fails loudly (a 4xx from GHL, surfaced via this module's discriminated
 * result) instead of silently drifting with a moving default.
 */
const API_VERSION = "2021-04-15";

/**
 * Confirmed 16 Oct 2026 against GoHighLevel's official OpenAPI spec
 * (GoHighLevel/highlevel-api-docs, apps/contacts.json): the contacts
 * endpoints (`POST /contacts/upsert`, `PUT /contacts/{id}` with
 * `dndSettings`) take `Version: 2021-07-28`, a DIFFERENT value than the
 * conversations endpoints `API_VERSION` above serves. Kept as its own constant rather than
 * reusing `API_VERSION` so the two can diverge without a misleading shared
 * name — flagged verify-at-first-go-live exactly like `API_VERSION` itself
 * (see `docs/GHL-PROVIDER-GO-LIVE.md`'s Part 7).
 */
const CONTACTS_API_VERSION = "2021-07-28";

/**
 * CONFIRMED against GHL's own docs on 4 Aug 2026 (the bulk-install contract this file didn't
 * originally implement — see this file's header intro and `getGhlLocationTokenFromAgency`/
 * `listGhlInstalledLocations` below) — the `Version` header both of those "agency token ->
 * per-location" endpoints want. Its own constant, not a reuse of `CONTACTS_API_VERSION`, even
 * though the two currently share a value: that one is an ASSUMED value for a different, unrelated
 * endpoint family (see its own comment above) — collapsing the two into one constant would make a
 * future divergence between "confirmed" and "assumed" invisible in the diff the moment either one
 * actually changes.
 */
const OAUTH_AGENCY_API_VERSION = "2021-07-28";

/**
 * Scopes requested at install (plan's operator checklist step 1) — the
 * narrowest set the provider's three jobs need: read/send conversations,
 * resolve/create contacts. `conversations/message.readonly` is requested
 * alongside `.write` because GHL's own docs list it next to `.write` for a
 * conversation provider app; nothing in this phase (or Phase 2) actually
 * calls a read-only messages endpoint.
 */
const SCOPES = [
  "conversations/message.write",
  "conversations.readonly",
  "conversations.write",
  "contacts.readonly",
  "contacts.write",
  "conversations/message.readonly",
];

/** GHL is a hard dependency of nothing here — bound every call so a hung request can't hold an OAuth route or a status report open. Matches `whatsapp-bridge.ts`'s own `BRIDGE_TIMEOUT_MS`. */
const TIMEOUT_MS = 5000;

/** The bridge's own text limit (`services/whatsapp-bridge/src/server.ts`'s `MAX_TEXT_LENGTH`) — `buildOutboundText` refuses rather than truncates past this; see its JSDoc. */
const MAX_WHATSAPP_TEXT_LENGTH = 4096;

/** Mirrors the bridge's own idempotency-key contract (`services/whatsapp-bridge/src/server.ts`'s `IDEMPOTENCY_KEY_RE`) — kept as a literal copy rather than a cross-package import (the portal and the bridge share no code), with this comment as the tripwire if the bridge's ever changes. */
const BRIDGE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface GhlEnv {
  clientId: string;
  clientSecret: string;
  webhookPublicKeyPem: string;
}

function ghlEnv(): GhlEnv | null {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  const webhookPublicKeyPem = process.env.GHL_WEBHOOK_PUBLIC_KEY;
  if (!clientId || !clientSecret || !webhookPublicKeyPem) return null;
  return { clientId, clientSecret, webhookPublicKeyPem };
}

/** The single "is this switched on at all?" check every GHL surface asks before rendering or attempting anything — mirrors `isGoogleCalendarConfigured`/`isWhatsappBridgeConfigured`. */
export function isGhlConfigured(): boolean {
  return ghlEnv() !== null;
}

/**
 * The webhook public key an operator copies from GHL's docs into
 * `GHL_WEBHOOK_PUBLIC_KEY` (plan's operator checklist step 3), PEM included
 * — exposed so the Phase 2 webhook route can make its own unset/live-vs-demo
 * decision (see this file's VERIFICATION IS FAIL-CLOSED note) without this
 * module hiding that branch inside a verify call. `null` when unset.
 */
export function ghlWebhookPublicKeyPem(): string | null {
  return ghlEnv()?.webhookPublicKeyPem ?? null;
}

/**
 * GHL provider Phase 3, plan §Q1 — the marketplace app's Conversation
 * Provider id, minted ONCE per app (all 11 locations install the same app,
 * so this is one value, not per-location — see the plan for why it isn't in
 * the OAuth token response and there is no location-token API to look it
 * up). Deliberately read STANDALONE, not folded into `ghlEnv()`'s
 * all-or-nothing triple: adding it there would retroactively 503 the
 * (already working) outbound webhook on a deployment that simply hasn't set
 * this yet — outbound never needs it.
 *
 * THE GATE IS ON THIS VALUE ALONE, BEFORE ANY ACCOUNT IS EVEN READ
 * (adversarial-review finding 6 — the JSDoc here previously implied an
 * account override could rescue an unset env var; it cannot):
 * `src/lib/ghl-inbound.ts`'s drain checks THIS function's return value at
 * the very top of every pass (its STEP 0), and if it is `null` the WHOLE
 * pass returns immediately — zero accounts read, zero overrides consulted.
 * A location whose own `ghl_accounts.conversation_provider_id` override
 * (0069) IS set gets nothing either, because the pass never gets far enough
 * to look at it. The override only matters, and only wins
 * (`account.conversationProviderId ?? envProviderId`), on a PER-ROW basis
 * once a pass is already running — i.e. once this function has already
 * returned non-null. Fail-closed, self-healing the moment this env var is
 * set — see that module's file header.
 */
export function ghlConversationProviderId(): string | null {
  return process.env.GHL_CONVERSATION_PROVIDER_ID ?? null;
}

/**
 * The OAuth redirect URI — must match a value registered in the GHL
 * marketplace app EXACTLY. Same `NEXT_PUBLIC_APP_URL` + production-fallback
 * convention every absolute URL in this codebase uses (`googleRedirectUri`,
 * `portalFeedThreadUrl`).
 */
export function ghlRedirectUri(): string {
  const base = brandConfig().appUrl;
  return `${base}/api/crm/oauth/callback`;
}

/**
 * Where to send an owner to install this provider onto one of their GHL
 * sub-accounts. GHL's own "choose location" flow is what asks WHICH
 * sub-account — deliberately: there is no way to name a location in this
 * URL, mirroring `googleAuthUrl`'s "whose calendar" boundary (see the
 * `/api/crm/oauth/start` route's own JSDoc).
 */
export function ghlAuthUrl(state: string): string | null {
  const env = ghlEnv();
  if (!env) return null;
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: ghlRedirectUri(),
    client_id: env.clientId,
    scope: SCOPES.join(" "),
    // GHL resolves an app VERSION, not just an app. Omit this and the
    // install dies on `error.noAppVersionIdFound` before the operator ever
    // sees a location picker. Derived rather than configured: GHL's client
    // ids are `<appId>-<keySuffix>` and the app id IS the version id in the
    // install link GHL generates for this app — one less env var to get
    // wrong, and it cannot drift out of step with the client id it belongs
    // to. Verified against that generated link on 3 Aug 2026.
    version_id: appVersionIdFromClientId(env.clientId),
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** `6a70…d2cd-msdoi2ke` -> `6a70…d2cd`. Falls back to the whole string if GHL ever stops using the `<appId>-<suffix>` shape, which fails loudly at GHL rather than silently here. */
export function appVersionIdFromClientId(clientId: string): string {
  const dash = clientId.indexOf("-");
  return dash > 0 ? clientId.slice(0, dash) : clientId;
}

export interface GhlTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  /** GHL's own sub-account id — present on an install/reinstall exchange (what the OAuth callback route needs to know WHICH location was just authorised). Not relied on for a plain token refresh — `refreshGhlToken`'s caller already knows the `locationId` from `ghl_accounts`. */
  locationId: string | null;
  companyId: string | null;
}

/**
 * PRODUCTION LOG, 4 Aug 2026 (the bug this type exists to fix) —
 * `tokensFrom`'s own diagnostic fired on the FIRST real install attempt:
 *
 *   [ghl] token has no location — authClass: Company | body keys:
 *   access_token,token_type,expires_in,refresh_token,scope,refreshTokenId,
 *   userType,companyId,isBulkInstallation,userId,installToFutureLocations,
 *   approveAllLocations
 *
 * ROOT CAUSE, confirmed against GHL's own docs the same day: the marketplace
 * app's "Can agency bulk install the app?" setting is Yes — deliberately, the
 * operator has ~12 sub-accounts to onboard, not one — and WITH that setting
 * on, GHL does not hand back a location token at all. It hands back a
 * Company-scoped one (the exact shape logged above: `companyId` +
 * `isBulkInstallation` + `approveAllLocations` + `installToFutureLocations`,
 * no `locationId` anywhere), and the app is EXPECTED to exchange that for
 * per-location tokens itself via `oauth/locationToken` — see
 * `getGhlLocationTokenFromAgency` below. `exchangeGhlCode` used to treat a
 * token with no `locationId` as an unrecoverable failure (`no_location`,
 * bouncing the callback) — that was the bug, not GHL's response.
 *
 * This type is what makes a Company-scoped exchange REPRESENTABLE instead of
 * collapsing it into that same failure: `GhlTokens` keeps meaning exactly
 * what it always meant — "a usable, location-scoped token" — every existing
 * caller (`refreshGhlToken`, the single-location OAuth callback path) still
 * gets that guarantee unchanged. The `"company"` branch is a DIFFERENT shape
 * on purpose, not `GhlTokens` with more nullable fields bolted on, so no
 * existing caller can accidentally start handling an agency token as if it
 * were a location one.
 */
export type GhlExchangeResult =
  | { kind: "location"; tokens: GhlTokens }
  | {
      kind: "company";
      accessToken: string;
      /** The agency's OWN refresh token — never stored or used again once this callback exchanges it for per-location tokens (each carries its own, saved via `installGhlLocation`), so callers have no reason to persist this. Carried through anyway rather than dropped, matching this file's "never guess, always parse what GHL actually sent" habit. */
      refreshToken: string | null;
      expiresAt: string;
      companyId: string;
      /** `json.isBulkInstallation === true` on the raw exchange response — diagnostic only (nothing here branches on it; a Company-scoped token is handled identically whether or not this is set), kept because it is the ONE field in the production log above that explains WHY GHL chose to issue a Company token at all. */
      isBulkInstall: boolean;
    };

/**
 * Final cross-phase review, finding 1 — `postForm` used to collapse EVERY
 * failure (a network throw, the 5s timeout, a 429, a 5xx, AND a genuine
 * `invalid_grant` refresh-token rejection) into a bare `null`, and
 * `resolveGhlAccessToken` (src/lib/ghl-provider.ts) treated any `null` from
 * `refreshGhlToken` as "GHL rejected the refresh token" — permanently
 * flipping the account to `needs_reauth` on a single slow response from
 * GHL's token endpoint. Plan D2 scopes `needs_reauth` explicitly to
 * "refresh failure WITH `invalid_grant`" — nothing else. This now returns a
 * discriminated result so the caller can tell the two apart: `invalid_grant`
 * (GHL definitively rejected the refresh token — a 4xx body with
 * `error: "invalid_grant"`) is the ONLY case that should ever mark an
 * account `needs_reauth`; everything else (a timeout, a network throw, a
 * non-`invalid_grant` 4xx, a 5xx, an unparseable body) is `transient` — the
 * account's status is left untouched and the existing retry machinery
 * (every subsequent send/drain pass calls this again) self-heals once GHL
 * recovers.
 */
type PostFormResult = { ok: true; json: Record<string, unknown> } | { ok: false; kind: "invalid_grant" | "transient" };

async function postForm(body: Record<string, string>): Promise<PostFormResult> {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const errorCode = typeof json?.error === "string" ? json.error : null;
      console.error("[ghl] token endpoint rejected:", res.status, errorCode ?? json?.message ?? "");
      // Only a genuine `invalid_grant` — GHL's own name for "this refresh
      // token is no longer good" — is the permanent case. A 429/other 4xx/5xx
      // says nothing about whether the refresh token itself still works.
      if (errorCode === "invalid_grant") return { ok: false, kind: "invalid_grant" };
      return { ok: false, kind: "transient" };
    }
    if (!json) return { ok: false, kind: "transient" };
    return { ok: true, json };
  } catch (err) {
    console.error("[ghl] token endpoint unreachable:", err);
    return { ok: false, kind: "transient" };
  }
}

/**
 * Reads GHL's own claims out of an access token. GHL issues JWTs, and the
 * install exchange on 4 Aug 2026 came back WITHOUT a top-level `locationId`
 * — the callback bounced on `no_location` while holding a perfectly good
 * token. The location is in the token's payload either way, so this is the
 * dependable source rather than a second guess at the body's field names.
 *
 * Deliberately trusting-but-not-verifying: we are reading a token GHL just
 * handed us over TLS in response to our own client-secret-authenticated
 * request, purely to learn which location it belongs to. Nothing here is an
 * authentication decision, so there is no signature to check.
 */
function claimsFromAccessToken(accessToken: string): Record<string, unknown> | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function tokensFrom(json: Record<string, unknown>): GhlTokens | null {
  const accessToken = typeof json.access_token === "string" ? json.access_token : null;
  if (!accessToken) return null;
  // GHL access tokens are assumed ~24h (plan §0) — a safe fallback only,
  // never relied on when GHL actually answers with `expires_in`.
  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 86400;
  const claims = claimsFromAccessToken(accessToken) ?? {};
  // `authClassId` is the id of whatever the token authenticates — the
  // location id when `authClass` is "Location", which is what our
  // `user_type: "Location"` exchange asks for.
  const locationFromClaims = claims.authClass === "Location" ? claims.authClassId : undefined;
  const locationId = firstString(json.locationId, json.location_id, claims.locationId, locationFromClaims);
  const companyId = firstString(json.companyId, json.company_id, claims.companyId);
  if (!locationId) {
    // UPDATED 4 Aug 2026 (see `GhlExchangeResult`'s own JSDoc for the full
    // diagnosis): a token with no location is EXPECTED, not broken, when a
    // `companyId` IS present — that is exactly the shape of a Company-scoped
    // agency-bulk-install exchange, and `exchangeGhlCode` below now routes it
    // into the location-token exchange instead of treating this as a dead
    // end. Kept at `console.log` (not `.error`) for that case — it is what
    // happened, not what went wrong. Names only in either branch, never
    // values — this object holds the access and refresh tokens.
    if (companyId) {
      console.log("[ghl] token is Company-scoped (agency/bulk install) — companyId present, no locationId | body keys:", Object.keys(json).join(","));
    } else {
      // Neither a location NOR a company id — genuinely unexplained, unlike
      // the companyId branch above. Kept loud.
      console.error(
        "[ghl] token has no location AND no companyId — authClass:",
        typeof claims.authClass === "string" ? claims.authClass : "(none)",
        "| body keys:",
        Object.keys(json).join(","),
        "| claim keys:",
        Object.keys(claims).join(","),
      );
    }
  }
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    locationId,
    companyId,
  };
}

/**
 * Exchange the one-time `?code=` from the install redirect. `null` on any failure — the callback
 * route shows a friendly error, never a 500. `user_type: "Location"` is what this file always
 * asked for; GHL still overrides it with a Company-scoped token when the marketplace app's "Can
 * agency bulk install the app?" setting is on (see `GhlExchangeResult`'s own JSDoc) — so a
 * `"company"` result here is a NORMAL outcome of this call, not a degraded one, and the caller
 * (the OAuth callback route) is expected to branch on `kind` rather than treat anything but
 * `"location"` as a failure.
 *
 * The one case this still folds into a plain `null`: an access token that parsed but carries
 * NEITHER a `locationId` NOR a `companyId` (`tokensFrom`'s own "genuinely unexplained" branch,
 * logged there at `.error`). That shape has never been observed against a real GHL response, and
 * there is no third `GhlExchangeResult` kind worth adding for a case this module cannot currently
 * name — the caller's generic `exchange_failed` copy is accurate enough for it.
 */
export async function exchangeGhlCode(code: string): Promise<GhlExchangeResult | null> {
  const env = ghlEnv();
  if (!env) return null;
  const result = await postForm({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: ghlRedirectUri(),
    user_type: "Location",
  });
  if (!result.ok) return null;
  const tokens = tokensFrom(result.json);
  if (!tokens) return null;
  if (tokens.locationId) return { kind: "location", tokens };
  if (!tokens.companyId) return null; // neither shape — see this function's own JSDoc.
  return {
    kind: "company",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    companyId: tokens.companyId,
    isBulkInstall: result.json.isBulkInstallation === true,
  };
}

/**
 * Trade a refresh token for a fresh access token. Discriminated result
 * (final cross-phase review finding 1 — see `postForm`'s own JSDoc for the
 * full reasoning): `{ ok: false, kind: "invalid_grant" }` means GHL
 * definitively rejected the refresh token itself — the ONLY case the caller
 * should mark the account `needs_reauth` (`Repository.markGhlNeedsReauth`).
 * `{ ok: false, kind: "transient" }` covers everything else (timeout,
 * network error, a non-`invalid_grant` 4xx, a 5xx, an unparseable/incomplete
 * response) — the caller must leave the account's status untouched and try
 * again on the next call; nothing here is evidence the refresh token itself
 * is bad. Mirrors `refreshGoogleToken`'s carry-through-refresh-token shape
 * exactly: GHL's refresh response is ASSUMED to sometimes omit
 * `refresh_token` (plan §0 — "assumed to rotate on use"), so the caller must
 * never write a null over a working credential; this function guarantees the
 * returned `refreshToken` is never null when the overall result is `ok`.
 */
export type RefreshGhlTokenResult = { ok: true; tokens: GhlTokens } | { ok: false; kind: "invalid_grant" | "transient" };

export async function refreshGhlToken(refreshToken: string): Promise<RefreshGhlTokenResult> {
  const env = ghlEnv();
  // Unconfigured is a deployment/config state, not evidence the refresh
  // token is bad — transient (self-heals the moment the env vars are set).
  if (!env) return { ok: false, kind: "transient" };
  const result = await postForm({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    user_type: "Location",
  });
  if (!result.ok) return result;
  const tokens = tokensFrom(result.json);
  if (!tokens) return { ok: false, kind: "transient" };
  return { ok: true, tokens: { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken } };
}

/**
 * The marketplace app's own id, needed as `listGhlInstalledLocations`'s `appId` query param.
 * DERIVED, not a new env var — `appVersionIdFromClientId`'s own comment already establishes that
 * GHL client ids are `<appId>-<suffix>` and that the app id IS the same version id `ghlAuthUrl`
 * sends as `version_id`; reusing that one function here means this can never drift out of step
 * with the client id it is derived from, unlike a second hand-copied env var would. `null` under
 * the SAME "unconfigured" gate as everything else in this file (`ghlEnv()`).
 */
export function ghlAppId(): string | null {
  const env = ghlEnv();
  return env ? appVersionIdFromClientId(env.clientId) : null;
}

/**
 * `POST /oauth/locationToken` — the other half of the bulk-install contract `GhlExchangeResult`'s
 * `"company"` kind exists to represent: trade a Company-scoped (agency) access token for a
 * Location-scoped one for ONE named location. CONFIRMED against GHL's own docs on 4 Aug 2026 (the
 * same investigation that diagnosed the production `no_location` bug — see this file's header and
 * `GhlExchangeResult`'s own JSDoc).
 *
 * Never throws — `null` on any non-2xx response, an unparseable body, or a parsed body that (per
 * `tokensFrom`) still carries no `locationId` — that last case would mean GHL accepted the request
 * but somehow still didn't scope the result to the location asked for, which this function treats
 * exactly like any other failure rather than handing the caller a token it can't attribute to a
 * location. Same never-log-the-token-or-body discipline as every other export here: only HTTP
 * status is ever logged on failure, never the agency token, the response body, or the derived
 * token.
 */
export async function getGhlLocationTokenFromAgency(agencyAccessToken: string, companyId: string, locationId: string): Promise<GhlTokens | null> {
  try {
    const res = await fetch(`${API_BASE}/oauth/locationToken`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agencyAccessToken}`,
        Version: OAUTH_AGENCY_API_VERSION,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ companyId, locationId }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[ghl] oauth/locationToken rejected: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return null;
    const tokens = tokensFrom(json);
    if (!tokens || !tokens.locationId) return null;
    return tokens;
  } catch (err) {
    console.error("[ghl] oauth/locationToken unreachable:", err);
    return null;
  }
}

/** One entry from `GET /oauth/installedLocations` — redacted down to what the bulk-install loop actually needs (`name` is display-only, never relied on for anything security-relevant). */
export interface GhlInstalledLocation {
  locationId: string;
  name: string | null;
}

/**
 * Pure parse for `GET /oauth/installedLocations`'s response body — split out from
 * `listGhlInstalledLocations` below (same "network wrapper around a pure parse" shape as
 * `tokensFrom`/`postForm`) so `scripts/test/ghl.test.ts` can pin every shape variant with a plain
 * object literal, no `fetch` stub required.
 *
 * TREAT THIS SHAPE AS LESS CERTAIN THAN `oauth/locationToken`'s (explicit call in the brief this
 * shipped against — GHL's own docs for this endpoint are thinner): accepts a `{ locations: [...] }`
 * envelope OR a bare array at the response root; accepts `_id` OR `id` per entry; treats
 * `isInstalled` being ABSENT as installed (only an explicit `false` filters a row out — see the
 * per-entry comment below for why "absent" and "false" are deliberately not the same signal). A
 * malformed individual entry is skipped, not fatal to the whole batch — but a response that isn't
 * shaped like a locations collection AT ALL (not an array, no `locations` array inside it) returns
 * `null`, logging the top-level KEY NAMES ONLY (never values), same diagnostic precedent as
 * `tokensFrom`'s own `no_location` log.
 */
export function parseGhlInstalledLocations(json: unknown): GhlInstalledLocation[] | null {
  const rawList: unknown = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).locations)
      ? (json as Record<string, unknown>).locations
      : null;
  if (!Array.isArray(rawList)) {
    console.error(
      "[ghl] oauth/installedLocations returned an unrecognised shape — top-level keys:",
      json && typeof json === "object" ? Object.keys(json as Record<string, unknown>).join(",") : typeof json,
    );
    return null;
  }
  const locations: GhlInstalledLocation[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue; // a malformed entry is skipped, not fatal — see this function's own JSDoc.
    const row = entry as Record<string, unknown>;
    // `isInstalled === false` is the ONLY value that excludes a row — absent
    // (a field this thinner-documented endpoint might simply not send on
    // every entry) is treated as installed, per this function's own JSDoc.
    if (row.isInstalled === false) continue;
    const locationId = firstString(row._id, row.id);
    if (!locationId) continue;
    locations.push({ locationId, name: firstString(row.name) });
  }
  return locations;
}

/**
 * `GET /oauth/installedLocations` — which locations a Company-scoped (agency/bulk) install
 * actually covers, so the OAuth callback route knows what to loop
 * `getGhlLocationTokenFromAgency` over. CONFIRMED endpoint/verb/headers against GHL's own docs on
 * 4 Aug 2026; see `parseGhlInstalledLocations`'s own JSDoc for why the RESPONSE SHAPE itself is
 * handled far more defensively than `oauth/locationToken`'s. Never throws — `null` on any non-2xx
 * response or a body `parseGhlInstalledLocations` can't make sense of.
 */
export async function listGhlInstalledLocations(agencyAccessToken: string, companyId: string, appId: string): Promise<GhlInstalledLocation[] | null> {
  try {
    const params = new URLSearchParams({ companyId, appId });
    const res = await fetch(`${API_BASE}/oauth/installedLocations?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${agencyAccessToken}`,
        Version: OAUTH_AGENCY_API_VERSION,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[ghl] oauth/installedLocations rejected: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json().catch(() => null);
    return parseGhlInstalledLocations(json);
  } catch (err) {
    console.error("[ghl] oauth/installedLocations unreachable:", err);
    return null;
  }
}

/**
 * `crypto.verify(null, ...)` reads the algorithm off the Ed25519 key itself
 * — Node's documented way to verify Ed25519, since (unlike RSA/ECDSA) there
 * is no separate digest algorithm to name. PURE — see this file's header on
 * why the key is a parameter here rather than read from env.
 *
 * RAW BYTES, NOT RE-SERIALISED JSON: `rawBody` must be the EXACT bytes GHL
 * signed — same rule as the Stripe webhook route
 * (src/app/api/webhooks/stripe/route.ts), and the reason the Phase 2 webhook
 * route must read `request.text()` before ever parsing. Signing the
 * `JSON.parse`-then-`JSON.stringify` round trip of an equivalent object
 * would very likely still verify most of the time and occasionally not
 * (key-order-dependent) — the caller must pass the literal string received
 * over the wire.
 *
 * FAIL-CLOSED on every malformed input (missing header, non-base64 header,
 * malformed PEM) — returns `false` rather than throwing, so a hostile or
 * broken request can never crash the caller into a 500 that might read as
 * "verification skipped".
 */
export function verifyGhlSignature(rawBody: string, signatureHeader: string | null, publicKeyPem: string): boolean {
  if (!signatureHeader) return false;
  try {
    const signature = Buffer.from(signatureHeader, "base64");
    return cryptoVerify(null, Buffer.from(rawBody, "utf8"), publicKeyPem, signature);
  } catch {
    return false;
  }
}

/**
 * `PUT /conversations/messages/:messageId/status` — "only able to be updated
 * by the conversation provider marketplace application tokens" (plan §0), so
 * `accessToken` must be THIS install's own OAuth access token, never a
 * shared secret. `errorMessage` is only meaningful (and only sent) when
 * `status === 'failed'`. Never throws — returns whether GHL accepted it, so
 * Phase 2's drain can leave a row unreported (`report_error` stamped) for
 * the next pass rather than crashing it.
 */
export async function updateGhlMessageStatus(
  accessToken: string,
  messageId: string,
  status: "delivered" | "failed" | "pending" | "read",
  errorMessage?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const body: Record<string, unknown> = { status };
    if (status === "failed" && errorMessage) body.error = { message: errorMessage };
    const res = await fetch(`${API_BASE}/conversations/messages/${encodeURIComponent(messageId)}/status`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Version: API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Adversarial-review finding 13: the RAW response body is logged
      // (diagnosable from Vercel logs) but never returned — the caller
      // writes this string into `ghl_outbound_messages.report_error`, and
      // `src/lib/ghl-provider.ts`'s own header commits to "every string this
      // module ever passes to updateGhlMessageStatus's errorMessage or
      // writes to report_error is a fixed string" for exactly this reason:
      // an arbitrary upstream response slice is untrusted text with no
      // shape guarantee, sitting in a column this codebase otherwise treats
      // as fixed-vocabulary. The HTTP status code alone is safe to include —
      // it's a small closed set of integers, not attacker/upstream-shaped
      // free text.
      const text = await res.text().catch(() => "");
      console.error(`[ghl] status update rejected: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`);
      return { ok: false, error: `GHL status update rejected (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    // Same rule — log the real error, return a fixed string.
    console.error("[ghl] updateGhlMessageStatus unreachable:", err);
    return { ok: false, error: "GHL status update request failed" };
  }
}

// ---------------------------------------------------------------------------
// Pure send-path helpers (plan's D3/D6) — no network, no env read. Exported
// for direct unit testing (Phase 2's test suite — scripts/test/ghl.test.ts —
// is out of scope for this phase, but these are written pure specifically so
// that suite needs no fixtures beyond plain strings).
// ---------------------------------------------------------------------------

/**
 * GHL's `messageId` verbatim when it already fits the bridge's idempotency
 * key contract; otherwise its sha256 hex digest of a DOMAIN-SEPARATED input
 * (`"T|" + ghlMessageId`, QA Minor 8 fix — see below), deterministic, 64
 * lowercase hex chars, always valid against the bridge's regex. GHL message
 * ids are unique per message and stable across webhook redelivery (plan's
 * D3) — that stability is what makes "a redelivered webhook or a drain
 * retry hits the bridge's replay path, never a second send" true regardless
 * of which branch this takes.
 *
 * QA Minor 8 (collision-proof claim was unproven): this function's hash
 * branch and `deriveAttachmentIdempotencyKey`'s hash both fed sha256 the
 * SAME string space with no domain separator — a `ghlMessageId` literally
 * equal to `"X:a0"` (which fails the verbatim-passthrough regex, so hashes
 * here) hashed the exact string `sha256("X:a0")`, identical to
 * `deriveAttachmentIdempotencyKey("X", 0)`'s own `sha256("X:a0")` — a real,
 * if wildly improbable, collision between a message's text part and an
 * unrelated message's attachment 0. Prefixing each function's hash input
 * with a distinct literal (`"T|"` here, `"A|"` there) makes the two input
 * spaces disjoint by construction: no string starting `"T|"` can ever equal
 * one starting `"A|"`. Safe to change now — nothing is live (0 GHL
 * locations connected as of writing).
 */
export function deriveIdempotencyKey(ghlMessageId: string): string {
  if (BRIDGE_IDEMPOTENCY_KEY_RE.test(ghlMessageId)) return ghlMessageId;
  return createHash("sha256").update(`T|${ghlMessageId}`, "utf8").digest("hex");
}

/**
 * Media plan (docs/MEDIA-PLAN.md §5.1, decision O1) — the attachment-part
 * idempotency key. ALWAYS the sha256 hex digest of a domain-separated input
 * (`"A|" + seq + "|" + ghlMessageId`, QA Minor 8 fix — see
 * `deriveIdempotencyKey`'s JSDoc for the collision this closes) — unlike
 * `deriveIdempotencyKey` above, which passes a regex-valid GHL id through
 * VERBATIM, this never does. That's deliberate: the whole point is a key
 * that can never collide with the TEXT part's own key. Deterministic (same
 * seq -> same key, always) and regex-valid by construction (64 lowercase
 * hex chars), so a GHL webhook redelivery re-derives the identical key for
 * the identical attachment position and lands on the bridge's own replay
 * path, exactly like the text part's key does.
 */
export function deriveAttachmentIdempotencyKey(ghlMessageId: string, seq: number): string {
  return createHash("sha256").update(`A|${seq}|${ghlMessageId}`, "utf8").digest("hex");
}

/**
 * QA Major 6 fix — the content-preserving fallback idempotency key (see
 * `resolveMediaDisabledFallback` in `src/lib/ghl-provider.ts`): the SAME
 * domain-separation discipline as the two functions above, its own `"F|"`
 * prefix so it can never collide with either the text part's key or any
 * attachment part's key for the same `ghlMessageId`. One fallback send per
 * GHL message — no `seq`, since every media-disabled attachment URL for a
 * message folds into ONE fallback text send, not one each.
 */
export function deriveMediaFallbackIdempotencyKey(ghlMessageId: string): string {
  return createHash("sha256").update(`F|${ghlMessageId}`, "utf8").digest("hex");
}

/**
 * Media plan (docs/MEDIA-PLAN.md §8) — the PORTAL's own outbound master
 * switch, read from `WA_MEDIA_OUTBOUND_ENABLED`. Deliberately the SAME env
 * var name as the bridge's `WA_MEDIA_OUTBOUND_ENABLED`
 * (services/whatsapp-bridge/src/config.ts) but a SEPARATE env read on a
 * separate deployment (Vercel vs Railway) — the two must each be flipped on
 * independently before attachment sends actually leave the building; either
 * one left off means every attachment part hits a terminal, fixed-reason
 * refusal (this flag off: `handleProviderOutboundMessage` never builds
 * attachment parts at all — see that function's flags-off regression
 * guarantee; the bridge's own flag off: every `sendAttachment` call this
 * module makes gets back the bridge's `media_outbound_disabled` 422, mapped
 * to a fixed refusal reason like any other terminal bridge failure code).
 * Strict "true"/anything-else parse (never throws) — unset, empty, or any
 * value other than exactly "true" (case-insensitive, trimmed) is `false`,
 * matching the bridge's own fail-safe-off `boolWithDefault` posture.
 */
export function isMediaOutboundEnabled(): boolean {
  return (process.env.WA_MEDIA_OUTBOUND_ENABLED ?? "").trim().toLowerCase() === "true";
}

export type BuildOutboundTextResult = { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" };

/**
 * Plain text, plus (plan's D6) one attachment URL per line appended after
 * it — WhatsApp renders them as tappable links; content is degraded but
 * PRESENT, never silently dropped. An attachments-only message (empty
 * `message`) is just the URLs. Refuses (never truncates) past the bridge's
 * 4096-char limit — see `reason: "too_long"` — because truncating would
 * silently drop URLs a caller explicitly asked to send, which is worse than
 * an honest failure the owner can see reflected as a `failed` status in GHL.
 * `reason: "empty"` covers the degenerate case of no text and no
 * attachments at all, which the bridge itself would refuse as `invalid_text`.
 */
export function buildOutboundText(message: string, attachments: string[]): BuildOutboundTextResult {
  const lines = [message, ...attachments].map((s) => s.trim()).filter((s) => s.length > 0);
  const text = lines.join("\n");
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (text.length > MAX_WHATSAPP_TEXT_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

/**
 * Pure query-filter builder for `Repository.getWhatsappMessagesByTenantKeys`
 * (`src/lib/data/supabase.ts`) — adversarial-review finding 2. That query
 * must bound itself to the WANTED idempotency keys, not just the tenant ids
 * involved: `whatsapp_messages` is never purged, and a query filtered on
 * tenant id alone can, at scale, return more rows than PostgREST's default
 * 1000-row cap allows, silently truncating the exact rows a drain pass wants
 * out of the response before the caller's own pair-matching filter ever
 * runs. Exported and unit-tested HERE (rather than only inline in
 * supabase.ts, which imports `next/headers` and cannot run under plain
 * `node --test`) so the dedupe this fix depends on is pinned independently
 * of a live Supabase call — `getWhatsappMessagesByTenantKeys` is required to
 * apply BOTH arrays this returns as `.in()` filters, never `tenantIds` alone.
 */
export function ghlTenantKeyQueryFilters(pairs: { tenantId: string; idempotencyKey: string }[]): {
  tenantIds: string[];
  idempotencyKeys: string[];
} {
  return {
    tenantIds: [...new Set(pairs.map((p) => p.tenantId))],
    idempotencyKeys: [...new Set(pairs.map((p) => p.idempotencyKey))],
  };
}

// ---------------------------------------------------------------------------
// GHL custom conversation provider, Phase 3 (inbound — WhatsApp replies into
// the client's GHL conversation). Two more network calls plus a pure media
// placeholder helper, same never-throws / fixed-reason-string / 5s-timeout
// conventions as everything else in this file. Driven exclusively by
// `src/lib/ghl-inbound.ts`'s `drainGhlInboundReplies` — see that module's
// file header for the full claim/retry contract these two calls sit inside.
// ---------------------------------------------------------------------------

export type UpsertGhlContactResult =
  | { ok: true; contactId: string; isNew: boolean }
  | { ok: false; kind: "rejected" | "rate_limited" | "unreachable"; error: string };

/**
 * `POST /contacts/upsert` — GHL's own server-side dedupe-by-phone endpoint
 * (Phase 3 plan §Q2): two overlapping callers upserting the SAME phone both
 * get the SAME `contactId` back, which is what makes it safe to call this
 * BEFORE the inbound-row claim — idempotent, unlike `addGhlInboundMessage`
 * below. Payload is `locationId` + `phone` ONLY — no name, no tags, no
 * source guessing; the client enriches their own contact (plan §Q2's "never
 * a guessed match" rule). `CONTACTS_API_VERSION`, not `API_VERSION` — see
 * that constant's own comment; flagged verify-at-first-go-live exactly like
 * the endpoint shape itself (`docs/GHL-PROVIDER-GO-LIVE.md` Part 7). Every
 * failure `kind` is treated as EQUALLY retryable by the caller (plan's Q5
 * table, "429 / 5xx / network error | retryable, pre-claim") — the split
 * here is diagnostic only (what `push_error` records), never a different
 * retry decision.
 */
export async function upsertGhlContact(accessToken: string, locationId: string, phoneE164: string): Promise<UpsertGhlContactResult> {
  return postGhlContactUpsert(accessToken, { locationId, phone: phoneE164 });
}

/** The tag every group contact carries, so a client can leave group contacts out of an "SMS everyone" workflow. */
export const GHL_GROUP_CONTACT_TAG = "whatsapp-group";
const GHL_GROUP_CONTACT_SUFFIX = " (WhatsApp group)";
/** GHL contact names are kept to 100 characters, suffix included. */
const GHL_GROUP_CONTACT_NAME_MAX = 100;

/** `ghlGroupContactKey`'s shape: the JID's digits (`-` kept), `-`, 8 lowercase hex. */
const GHL_GROUP_CONTACT_KEY_RE = /^[0-9]{1,64}(-[0-9]{1,64})?-[0-9a-f]{8}$/;

/**
 * The key behind a group contact's placeholder email, PER NUMBER: the group
 * JID without `@g.us` (its `-` kept, so `12-345` and `123-45` stay distinct;
 * `-` is valid in an email local part), then `-` and the first 8 hex chars of
 * sha256(tenantId). The same group seen by two of a location's numbers
 * therefore gets two GHL contacts, each routed to its own number, rather
 * than one contact both numbers post into. Hashed so the raw tenant id never
 * reaches GHL (no tenant id in anything outside the service-role boundary).
 */
export function ghlGroupContactKey(groupJid: string, tenantId: string): string {
  const jidPart = groupJid.replace(/@g\.us$/, "");
  const tenantPart = createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  return `${jidPart}-${tenantPart}`;
}

/**
 * Opt-in WhatsApp groups — the ONE GHL contact standing for a group (GHL's
 * inbound-message API needs a contact and has no group concept). Same
 * endpoint, request conventions and fixed error strings as `upsertGhlContact`
 * (it shares `postGhlContactUpsert`).
 *   - name `<group name> (WhatsApp group)`, the group name trimmed by whole
 *     characters so the total is at most 100;
 *   - tag `whatsapp-group`;
 *   - NO phone: a made-up number could collide with a real contact or be
 *     texted by an SMS step;
 *   - a placeholder email `group-<groupKey>@groups.pingwren.invalid`
 *     (`.invalid` can never deliver, RFC 2606). It is there because GHL may
 *     refuse a contact with neither phone nor email — not yet confirmed
 *     against a live location — and it also gives GHL's upsert something to
 *     dedupe on, so a retried create returns the same contact.
 * `groupKey` is `ghlGroupContactKey`'s output; anything else is refused
 * without a request, so only digits, `-` and lowercase hex ever reach the
 * email.
 */
export async function upsertGhlGroupContact(
  accessToken: string,
  locationId: string,
  input: { name: string; groupKey: string }
): Promise<UpsertGhlContactResult> {
  if (!GHL_GROUP_CONTACT_KEY_RE.test(input.groupKey)) {
    return { ok: false, kind: "rejected", error: "GHL group contact key is not a WhatsApp group id" };
  }
  const groupName = Array.from(input.name.trim())
    .slice(0, GHL_GROUP_CONTACT_NAME_MAX - GHL_GROUP_CONTACT_SUFFIX.length)
    .join("")
    .trim();
  return postGhlContactUpsert(accessToken, {
    locationId,
    name: groupName ? `${groupName}${GHL_GROUP_CONTACT_SUFFIX}` : "WhatsApp group",
    email: `group-${input.groupKey}@groups.pingwren.invalid`,
    tags: [GHL_GROUP_CONTACT_TAG],
  });
}

/** `POST /contacts/upsert` with `payload` — the shared request, response parsing and fixed-string failure mapping behind both contact upserts above. */
async function postGhlContactUpsert(accessToken: string, payload: Record<string, unknown>): Promise<UpsertGhlContactResult> {
  try {
    const res = await fetch(`${API_BASE}/contacts/upsert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Version: CONTACTS_API_VERSION,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      console.error(`[ghl] contacts/upsert rejected: HTTP ${res.status}${json ? ` — ${JSON.stringify(json).slice(0, 300)}` : ""}`);
      const kind = res.status === 429 ? "rate_limited" : "rejected";
      return { ok: false, kind, error: `GHL contact upsert rejected (HTTP ${res.status})` };
    }
    // GHL's own upsert response shape wasn't confirmed by the docs fetch
    // (plan §7 risk 1) — read both a nested `{ contact: { id, ... } }` and a
    // flat `{ id, ... }` defensively rather than assume one.
    const contactObj = ((json?.contact as Record<string, unknown> | undefined) ?? json ?? {}) as Record<string, unknown>;
    const contactId = typeof contactObj.id === "string" ? contactObj.id : null;
    if (!contactId) {
      console.error("[ghl] contacts/upsert returned 2xx with no readable contact id:", JSON.stringify(json).slice(0, 300));
      return { ok: false, kind: "rejected", error: "GHL contact upsert response had no contact id" };
    }
    const isNew = json?.new === true || contactObj.new === true;
    return { ok: true, contactId, isNew: Boolean(isNew) };
  } catch (err) {
    console.error("[ghl] contacts/upsert unreachable:", err);
    return { ok: false, kind: "unreachable", error: "GHL contact upsert request failed" };
  }
}

/** A GHL contact reduced to what inviting needs. Never logged. */
export type GhlContactLite = { id: string; firstName: string | null; name: string | null; phone: string | null; tags: string[] };

const GHL_CONTACT_SEARCH_PAGE_SIZE = 100;
/** Paging stops here even if GHL keeps returning full pages; hitting it sets `truncated`. */
const GHL_CONTACT_SEARCH_MAX_PAGES = 20;

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Reads one GHL contact object defensively (the response shapes are not confirmed against a live location). `null` when it has no id. */
function toGhlContactLite(raw: unknown): GhlContactLite | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const id = strOrNull(c.id);
  if (!id) return null;
  const firstName = strOrNull(c.firstName);
  const fullName = [firstName, strOrNull(c.lastName)].filter((p): p is string => p !== null).join(" ");
  const name = strOrNull(c.contactName) ?? strOrNull(c.name) ?? (fullName || null);
  const tags = Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : [];
  return { id, firstName, name, phone: strOrNull(c.phone), tags };
}

/**
 * `GET /contacts/{id}`. Same headers and version as the upserts. Never throws;
 * failures are fixed strings (no response body, no contact data in logs).
 */
export async function getGhlContact(accessToken: string, contactId: string): Promise<{ ok: true; contact: GhlContactLite } | { ok: false; error: string; notFound?: true }> {
  try {
    const res = await fetch(`${API_BASE}/contacts/${encodeURIComponent(contactId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Version: CONTACTS_API_VERSION },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[ghl] contact read rejected: HTTP ${res.status}`);
      return res.status === 404
        ? { ok: false, error: `GHL contact read rejected (HTTP ${res.status})`, notFound: true }
        : { ok: false, error: `GHL contact read rejected (HTTP ${res.status})` };
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const contact = toGhlContactLite(json?.contact ?? json);
    if (!contact) return { ok: false, error: "GHL contact read returned no contact" };
    return { ok: true, contact };
  } catch {
    console.error("[ghl] contact read unreachable");
    return { ok: false, error: "GHL contact read request failed" };
  }
}

/**
 * `POST /contacts/search` for a location, by tag (a `tags` filter, matched
 * case-insensitively — also re-checked here) and/or free text, paged up to
 * `limit` contacts (and at most 20 pages). `truncated` is true when more matched than `limit`.
 * Never throws; failures are fixed strings (no response body, no contact data
 * in logs).
 */
export async function searchGhlContacts(
  accessToken: string,
  locationId: string,
  query: { text?: string; tag?: string },
  limit: number
): Promise<{ ok: true; contacts: GhlContactLite[]; truncated: boolean } | { ok: false; error: string }> {
  const tag = query.tag?.trim().toLowerCase() || null;
  const text = query.text?.trim() || null;
  const contacts: GhlContactLite[] = [];
  let truncated = false;
  try {
    for (let page = 1; ; page++) {
      if (page > GHL_CONTACT_SEARCH_MAX_PAGES) {
        truncated = true;
        break;
      }
      const body: Record<string, unknown> = { locationId, page, pageLimit: GHL_CONTACT_SEARCH_PAGE_SIZE };
      if (text) body.query = text;
      if (tag) body.filters = [{ field: "tags", operator: "contains", value: [tag] }];
      const res = await fetch(`${API_BASE}/contacts/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Version: CONTACTS_API_VERSION },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`[ghl] contacts/search rejected: HTTP ${res.status}`);
        return { ok: false, error: `GHL contact search rejected (HTTP ${res.status})` };
      }
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const rows = Array.isArray(json?.contacts) ? (json.contacts as unknown[]) : [];
      for (const row of rows) {
        const c = toGhlContactLite(row);
        if (!c) continue;
        if (tag && !c.tags.some((t) => t.toLowerCase() === tag)) continue;
        if (contacts.length >= limit) {
          truncated = true;
          break;
        }
        contacts.push(c);
      }
      if (truncated || rows.length < GHL_CONTACT_SEARCH_PAGE_SIZE) break;
    }
    return { ok: true, contacts, truncated };
  } catch {
    console.error("[ghl] contacts/search unreachable");
    return { ok: false, error: "GHL contact search request failed" };
  }
}

/** T10 — opt-in switch for mirroring STOP/START onto the GoHighLevel contact's DND. Off unless exactly "true". */
export function isGhlDndSyncEnabled(): boolean {
  return process.env.GHL_SYNC_DND === "true";
}

/**
 * Sets (`dnd: true`) or clears (`dnd: false`) the contact's WhatsApp and SMS
 * Do-Not-Disturb via `PUT /contacts/{id}` with `dndSettings`. NOT otherwise
 * used in this codebase: shaped from GHL's documented "Update Contact"
 * (`dndSettings.<channel>.status` = "active" | "inactive"), so verify at first
 * go-live like `CONTACTS_API_VERSION`. The blanket `dnd` flag is deliberately
 * not sent (it would block every channel, e.g. email). Never throws, never
 * logs the token or the response body.
 */
export async function setGhlContactDnd(accessToken: string, contactId: string, dnd: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const status = dnd ? "active" : "inactive";
  const entry = dnd ? { status, message: "Opted out via WhatsApp reply", code: "STOP" } : { status };
  try {
    const res = await fetch(`${API_BASE}/contacts/${encodeURIComponent(contactId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Version: CONTACTS_API_VERSION,
      },
      body: JSON.stringify({ dndSettings: { WhatsApp: entry, SMS: entry } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[ghl] contacts dnd update rejected: HTTP ${res.status}`);
      return { ok: false, error: `dnd update rejected: HTTP ${res.status}` };
    }
    return { ok: true };
  } catch {
    console.error("[ghl] contacts dnd update unreachable");
    return { ok: false, error: "dnd update unreachable" };
  }
}

/**
 * Media plan (docs/MEDIA-PLAN.md §6.2, decision I2's stated fallback) — see
 * `addGhlInboundMessage`'s own JSDoc for the full rationale. This is
 * deliberately a source-level constant, not an env var: the plan calls it
 * "one boolean in ghl.ts's payload builder", flipped by hand once the first
 * real push to a live GHL location confirms or refutes the `attachments`
 * field (docs/GHL-PROVIDER-GO-LIVE.md Part 7's verify-first list).
 */
const GHL_SUPPORTS_ATTACHMENTS_FIELD = true;

export type AddGhlInboundMessageResult =
  | { ok: true }
  | { ok: false; kind: "rejected" | "rate_limited" | "server_error" | "unauthorized" | "unreachable" | "timeout_uncertain"; error: string };

/**
 * `POST /conversations/messages/inbound` — appends ONE message to the
 * client's GHL conversation; NOT idempotent (GHL offers no key on this
 * endpoint), unlike `updateGhlMessageStatus`'s PUT above. `timestampIso`,
 * when passed, carries the WhatsApp reply's own `received_at` — plan §Q7
 * flags whether GHL actually orders by it as verify-at-first-go-live;
 * omitted entirely (never guessed) when the caller has nothing to pass.
 *
 * "UNCERTAIN" IS THE DEFAULT, NOT THE EXCEPTION (adversarial-review finding
 * 1 — the at-most-once hole): a genuine `TimeoutError` (Node's
 * `AbortSignal.timeout` firing before a response arrives) is the textbook
 * ambiguous case, but it is NOT the only one — a socket that dies AFTER this
 * process has finished writing the request body (an LB restart, a connection
 * reset) throws a plain `TypeError` with `cause.code` like `UND_ERR_SOCKET`
 * or `ECONNRESET`, and GHL may well have already committed the message
 * before the reset. Demonstrated with a localhost probe: a server that reads
 * the full request then destroys the socket produces exactly that
 * `TypeError`/`UND_ERR_SOCKET` shape — indistinguishable, from here, from "it
 * landed." Classifying that as `"unreachable"` (retryable) was the bug: the
 * next drain pass would un-claim and re-POST, duplicating the reply in the
 * client's CRM — the exact outcome at-most-once refuses. So the default for
 * ANY catch that isn't a confirmed timeout is now `"timeout_uncertain"`
 * (terminal, never retried, same as a real timeout). Only PROVABLY
 * pre-flight failures — `cause.code` of `ENOTFOUND`/`ECONNREFUSED`/
 * `EAI_AGAIN` (DNS/connection-refused, which cannot happen after the request
 * was already sent) — are `"unreachable"` and genuinely retryable. Getting
 * this backwards duplicates a message in a client's CRM; getting it right at
 * worst loses a reply that stays readable in our DB for 90 days — an
 * intentionally asymmetric trade (at-most-once beats at-least-once here,
 * exactly the bridge's own `dispatch_attempted` philosophy for the identical
 * "did the far side already see this?" ambiguity).
 *
 * `upsertGhlContact` above does NOT need this same care: its catch collapses
 * every network-level failure into a single `"unreachable"` kind, and that
 * is deliberate, not an oversight — the upsert is IDEMPOTENT (GHL's own
 * server-side dedupe-by-phone), so retrying it after a possibly-successful
 * call is harmless (worst case: an extra upsert call that returns the SAME
 * contactId). Only THIS function's POST — which appends a new message on
 * every call, with no idempotency key — needs the pre-flight/uncertain split.
 *
 * MEDIA PLAN ADDITION (docs/MEDIA-PLAN.md §6.2, decision I2) — `attachments`,
 * when passed, is an array of signed storage URLs for a `media_status =
 * 'stored'` reply. `GHL_SUPPORTS_ATTACHMENTS_FIELD` below is the ONE
 * boolean the plan calls for: `true` is this module's ASSUMED-not-confirmed
 * bet that GHL's `POST /conversations/messages/inbound` accepts an
 * `attachments: string[]` field alongside `message` (plan §3's risk list,
 * item 1 — flip this to `false` the moment a real push comes back non-2xx
 * specifically because of that field, and `docs/GHL-PROVIDER-GO-LIVE.md`
 * Part 7 gains that as a verify-first item). When `false`, the exact same
 * information degrades to a plain link line appended to `message` — still a
 * strict improvement over the old placeholder-only path, never a silent
 * drop.
 */
export async function addGhlInboundMessage(
  accessToken: string,
  input: { contactId: string; conversationProviderId: string; body: string; timestampIso?: string; attachments?: string[] }
): Promise<AddGhlInboundMessageResult> {
  try {
    const attachments = input.attachments?.filter((url) => url.length > 0) ?? [];
    const payload: Record<string, unknown> = {
      type: "SMS",
      contactId: input.contactId,
      conversationProviderId: input.conversationProviderId,
      message:
        attachments.length > 0 && !GHL_SUPPORTS_ATTACHMENTS_FIELD
          ? [input.body, ...attachments].join("\n") // fallback: link line(s) appended to the body, same shape as buildOutboundText's own degrade.
          : input.body,
    };
    if (attachments.length > 0 && GHL_SUPPORTS_ATTACHMENTS_FIELD) payload.attachments = attachments;
    if (input.timestampIso) payload.timestamp = input.timestampIso;
    const res = await fetch(`${API_BASE}/conversations/messages/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Version: API_VERSION,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Same rule as updateGhlMessageStatus above: log the raw body, never
      // return it — every string this returns is one of the fixed literals
      // below, HTTP status int at most (finding-13 rule).
      const text = await res.text().catch(() => "");
      console.error(`[ghl] conversations/messages/inbound rejected: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`);
      if (res.status === 429) return { ok: false, kind: "rate_limited", error: `GHL inbound message rejected (HTTP ${res.status})` };
      // Final cross-phase review finding 6 — a 401/403 here is NOT evidence
      // this exact message was refused for a permanent reason: by the time
      // this call is made, `resolveGhlAccessToken` already believed the
      // token was fresh (or the loser of a concurrent refresh just re-read
      // one — see that function's own finding-6 fix), so a 401/403 means the
      // token was invalidated between that check and this request (a
      // concurrent re-auth, a clock-skew edge, an in-flight rotation) — not
      // that GHL will refuse this message forever. Retryable, same as
      // rate_limited/server_error: the row un-claims and a later pass
      // (which re-resolves the token from scratch) tries again, bounded by
      // the usual push_attempts cap.
      if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized", error: `GHL inbound message rejected (HTTP ${res.status})` };
      if (res.status >= 500) return { ok: false, kind: "server_error", error: `GHL inbound message rejected (HTTP ${res.status})` };
      return { ok: false, kind: "rejected", error: `GHL inbound message rejected (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error("[ghl] conversations/messages/inbound timed out — outcome uncertain:", err);
      return { ok: false, kind: "timeout_uncertain", error: "GHL inbound message request timed out — delivery uncertain" };
    }
    if (isPreFlightNetworkFailure(err)) {
      console.error("[ghl] conversations/messages/inbound unreachable (pre-flight — nothing reached the wire):", err);
      return { ok: false, kind: "unreachable", error: "GHL inbound message request failed" };
    }
    // Everything else — including a mid-flight socket reset AFTER the
    // request body was delivered — is treated as uncertain, never retried.
    // See this function's JSDoc ("UNCERTAIN IS THE DEFAULT") for why.
    console.error("[ghl] conversations/messages/inbound failed with an uncertain outcome — treating as possibly-delivered, not retrying:", err);
    return { ok: false, kind: "timeout_uncertain", error: "GHL inbound message request failed with an uncertain outcome — delivery uncertain" };
  }
}

/**
 * Provably PRE-FLIGHT failures only — the request never reached (or could
 * never have reached) GHL's servers, so a retry cannot possibly double-post.
 * `ENOTFOUND`/`EAI_AGAIN` (DNS resolution never completed) and
 * `ECONNREFUSED` (nothing was listening) both happen before a single byte of
 * the request is written. Deliberately narrow: `UND_ERR_SOCKET`,
 * `ECONNRESET`, and any other `cause.code` are NOT included here — those can
 * happen after the body was already sent, so they fall through to the
 * `"timeout_uncertain"` default above instead.
 */
function isPreFlightNetworkFailure(err: unknown): boolean {
  const PRE_FLIGHT_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && PRE_FLIGHT_CODES.has(code);
}

/** Every non-text messageType this bridge/portal pairing has ever recorded maps to a fixed string; anything else (a future Baileys content-type key) falls through to the generic default rather than throwing or guessing. */
const MEDIA_PLACEHOLDERS: Readonly<Record<string, string>> = {
  imageMessage: "[Photo received on WhatsApp — view it on the connected phone]",
  audioMessage: "[Voice note received on WhatsApp — view it on the connected phone]",
  pttMessage: "[Voice note received on WhatsApp — view it on the connected phone]",
  videoMessage: "[Video received on WhatsApp — view it on the connected phone]",
  stickerMessage: "[Sticker received on WhatsApp — view it on the connected phone]",
  documentMessage: "[Document received on WhatsApp — view it on the connected phone]",
};
const MEDIA_PLACEHOLDER_DEFAULT = "[WhatsApp message received — view it on the connected phone]";

/**
 * Plan §Q6 — pure, exported, unit-tested map of fixed strings.
 * `whatsapp_inbound_messages.body` is `null` for a non-text reply (0048) —
 * the bridge never stores media, and this drain never fetches it either
 * (media bytes are explicitly out of scope, same as outbound plan §D6). The
 * DB row's `body` stays `null` regardless of this call — the placeholder
 * exists ONLY in the text `src/lib/ghl-inbound.ts` posts to GHL.
 */
export function describeInboundMediaPlaceholder(messageType: string): string {
  return MEDIA_PLACEHOLDERS[messageType] ?? MEDIA_PLACEHOLDER_DEFAULT;
}

// ---------------------------------------------------------------------------
// Media plan (docs/MEDIA-PLAN.md §6.2/§6.3) — the label posted alongside a
// STORED media reply's attachment. Deliberately the placeholder minus the
// "view it on the connected phone" tail — that clause becomes false the
// moment a file is actually attached to the message.
// ---------------------------------------------------------------------------

const STORED_MEDIA_LABELS: Readonly<Record<string, string>> = {
  imageMessage: "Photo received on WhatsApp",
  audioMessage: "Voice note received on WhatsApp",
  pttMessage: "Voice note received on WhatsApp",
  videoMessage: "Video received on WhatsApp",
  documentMessage: "Document received on WhatsApp",
};
const STORED_MEDIA_LABEL_DEFAULT = "File received on WhatsApp";

/** Plan §6.2 step 2 — the fixed label for a `media_status = 'stored'` row (attachment present, so the placeholder's "view it on the connected phone" tail no longer applies). */
export function describeStoredMediaLabel(messageType: string): string {
  return STORED_MEDIA_LABELS[messageType] ?? STORED_MEDIA_LABEL_DEFAULT;
}

/** Plan §6.3's over-cap row — the honest placeholder survives, worded specifically for "we saw it, it was too big" rather than the generic "not fetched at all" wording `describeInboundMediaPlaceholder` uses. */
export function describeTooLargeMediaPlaceholder(messageType: string): string {
  const base = MEDIA_PLACEHOLDERS[messageType] ?? MEDIA_PLACEHOLDER_DEFAULT;
  return base.replace(/ — view it on the connected phone\]$/, " (too large to transfer — view it on the connected phone)]");
}
