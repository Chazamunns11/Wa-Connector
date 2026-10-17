/**
 * Generalised core for every "bearer-token-authenticated, WhatsApp-bridge-
 * driving" guard in this codebase — extracted from
 * `src/app/api/crm/embed/guard.ts` (the GHL Custom Page embed's guard, built
 * first) so that `src/app/api/connect/guard.ts` (the per-client connect-link
 * feature, docs/GHL-PROVIDER-CLIENT-MIGRATION.md) can reuse the SAME
 * reviewed machinery — the config-gate-then-token-then-fresh-account-re-read
 * shape, the discriminated failure variants, the "never throws" contract —
 * rather than a second hand-copied ~60-line guard that could silently drift
 * from the first one's security posture over time.
 *
 * DELIBERATELY ZERO NEXT IMPORTS, same discipline as `src/lib/live-mode.ts`
 * (see that file's own header for the full "why"): this must stay loadable
 * under a plain `node --test` run (`scripts/test/alias-hook.mjs`'s loader),
 * which is what makes `scripts/test/ghl-embed.test.ts` and
 * `scripts/test/ghl-connect-link.test.ts` able to exercise a real guard with
 * a fake repo and no Next runtime at all. Every actual dependency
 * (`isLiveMode`, `isGhlEmbedConfigured`/`verifyGhlEmbedToken`,
 * `isConnectLinkConfigured`/`verifyConnectSessionToken`,
 * `isWhatsappBridgeConfigured`, `repo.getGhlAccountByLocationId`) is
 * INJECTED by the caller (`gates`, `verifyToken`, `resolveAccount` below)
 * rather than imported here — this module holds zero opinions about WHICH
 * feature it is guarding, only the SHAPE every such guard shares. The only
 * imports below are `import type` — erased at compile time regardless of
 * what `@/lib/types`/`@/lib/whatsapp-bridge` themselves import, so they can
 * never reintroduce a runtime Next dependency by accident.
 *
 * THE SHAPE EVERY GUARD BUILT ON THIS SHARES (restated from
 * `authorizeGhlEmbedRequest`'s original header, now generalised):
 *   0. Every config gate in `gates`, IN ORDER, cheapest/most-global first —
 *      the first one whose `ok()` returns false wins, 503 with that gate's
 *      own `error` code. Checked BEFORE the token is even parsed.
 *   1. `Authorization: Bearer <token>` must verify via the caller's own
 *      `verifyToken` — anything else (missing header, malformed, expired,
 *      tampered, wrong kind) is 401 with `missingTokenError`/`invalidTokenError`.
 *   2. `resolveAccount(verified)` — a FRESH, per-call lookup the caller
 *      performs itself (never cached from the mint) — decides 403 vs ok. This
 *      is the revocation lever every guard built on this core inherits: an
 *      owner disabling an account, or bumping a connect link's version, cuts
 *      access off within one poll tick rather than waiting out a token's TTL
 *      — see `authorizeGhlEmbedRequest`'s own header for the fuller
 *      "WHY STEP 2 RE-READS EVERY TIME" argument, which applies identically
 *      here regardless of which feature is calling in.
 *   3. WHICH NUMBER (several WhatsApp numbers per location, Task 4). A GHL
 *      location now has up to three numbers (`ghl_location_numbers`, one
 *      `whatsapp_tenants` row each). `resolveSlot(verified)` names the
 *      number by SLOT — from the request body on the embed, from the signed
 *      token on a connect link — and is refused 400 `invalid_slot` unless it
 *      is exactly 1, 2 or 3. `lookupNumber(locationId, slot)` then resolves
 *      that slot to its tenant WITHIN THE LOCATION STEP 2 JUST PROVED, and a
 *      slot with no row is 404 `unknown_number`. This step runs strictly
 *      AFTER steps 0-2: an unauthenticated or revoked caller learns nothing
 *      about which slots exist, and the order of every older check is
 *      unchanged. THE TENANT ID IS STILL NEVER CLIENT-SUPPLIED: the client
 *      names a slot, a small integer that only means anything inside the
 *      location its own verified token already names, so there is no input
 *      that could reach another location's number. `runBridgePanelLocationGuard`
 *      is steps 0-2 alone, for routes that act on the location as a whole
 *      (adding a number) and must never be handed a tenant at all.
 *
 * NEVER THROWS — the whole body runs inside one try/catch, same "genuinely
 * total, not just documented as such" fix `authorizeGhlEmbedRequest` already
 * carries (a gate function, `verifyToken`, or `resolveAccount` can each throw
 * on an unexpected dependency hiccup — a partial Supabase env, a Postgres
 * error — and none of that may ever reach a public route as an unhandled 500
 * with a stack trace).
 */
import type { GhlAccountStatus } from "@/lib/types";
import type { BridgeFailure, BridgeSessionResult, BridgeSessionSnapshot } from "@/lib/whatsapp-bridge";
import type { LocationSlot, SlotParseResult } from "@/lib/location-numbers";

/** Parses `Authorization: Bearer <token>` — `null` when absent or a different scheme. Shared by every guard built on this core. */
export function bearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/**
 * The narrow account shape every guard built on this core hands its route —
 * deliberately NOT `GhlAccount` (which carries `accessToken`/`refreshToken`;
 * see that interface's own JSDoc, src/lib/types.ts, "Never return this from a
 * page..."). Identical to the embed guard's original `GhlEmbedAccount` — kept
 * under a feature-neutral name here since both the embed guard and the
 * connect guard now build this same shape.
 */
export interface PanelGuardAccount {
  /** The tenant of the ONE number `slot` names — see this file's header, step 3. Never serialise it. */
  tenantId: string;
  /** Which of the location's numbers this request is about. */
  slot: LocationSlot;
  label: string;
  status: GhlAccountStatus;
}

/**
 * Steps 0-2's result: the location the verified token proves, with NO tenant
 * id at all (the location-only guard's routes must never hold one they did
 * not explicitly look up). Same "never the full `GhlAccount`" narrowing as
 * `PanelGuardAccount`.
 */
export interface PanelGuardLocation {
  locationId: string;
  label: string;
  status: GhlAccountStatus;
}

/** One config gate, checked in the order supplied — see this file's header, step 0. */
export interface PanelGuardGate<TError extends string> {
  ok: () => boolean;
  error: TError;
}

/**
 * Every outcome `runBridgePanelGuard` can return. Generic over three of its
 * own type parameters so each caller's wrapper (`authorizeGhlEmbedRequest`,
 * `authorizeConnectRequest`) gets back its OWN exact literal-string error
 * union — `GhlEmbedGuardResult`/`ConnectGuardResult` are structurally
 * identical to (a specialisation of) this type, not a looser `string`-typed
 * approximation, so neither wrapper needs an unsafe cast to keep returning
 * the exact shape its own tests already assert with `deepEqual`.
 */
export type PanelLocationGuardResult<TConfigError extends string, TTokenError extends string, TAccountError extends string> =
  | { ok: true; location: PanelGuardLocation }
  | { ok: false; status: 401; error: TTokenError }
  | { ok: false; status: 403; error: TAccountError }
  | { ok: false; status: 503; error: TConfigError }
  | { ok: false; status: 500; error: "internal" };

export type PanelGuardResult<TConfigError extends string, TTokenError extends string, TAccountError extends string> =
  | { ok: true; account: PanelGuardAccount }
  | Exclude<PanelLocationGuardResult<TConfigError, TTokenError, TAccountError>, { ok: true }>
  | { ok: false; status: 400; error: "invalid_slot" }
  | { ok: false; status: 404; error: "unknown_number" };

export interface PanelLocationGuardOptions<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string> {
  /** Config gates, checked in order — see this file's header, step 0. */
  gates: PanelGuardGate<TConfigError>[];
  /** Verify the bearer token; `null` on any tamper/format/expiry/wrong-kind failure. */
  verifyToken: (token: string) => TVerified | null;
  /** 401 code when no `Authorization` header (or wrong scheme) is present at all. */
  missingTokenError: TTokenError;
  /** 401 code when a token IS present but `verifyToken` rejected it. */
  invalidTokenError: TTokenError;
  /**
   * The fresh, per-call account lookup — see this file's header, step 2.
   * Called ONLY after the token has verified; a 403 here is the guard's own
   * final result for that branch. An ok result returns the LOCATION only —
   * which number (and so which tenant) is step 3's job, not this lookup's.
   */
  resolveAccount: (verified: TVerified) => Promise<{ ok: true; location: PanelGuardLocation } | { ok: false; status: 403; error: TAccountError }>;
  /** Log-line prefix for the catch-all — see this file's header, "NEVER THROWS". Never includes the token, the account, or anything request-shaped, same discipline as the original embed guard. */
  logPrefix: string;
}

export interface PanelGuardOptions<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string>
  extends PanelLocationGuardOptions<TVerified, TConfigError, TTokenError, TAccountError> {
  /** Step 3 — which slot this request names (body or token; see this file's header). Called only after steps 0-2 passed. */
  resolveSlot: (verified: TVerified) => SlotParseResult;
  /** Step 3 — slot to tenant, within the location step 2 proved. `null` (no such number) is 404 `unknown_number`. */
  lookupNumber: (locationId: string, slot: LocationSlot) => Promise<{ tenantId: string } | null>;
}

type StepsZeroToTwo<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string> =
  | { ok: true; verified: TVerified; location: PanelGuardLocation }
  | Exclude<PanelLocationGuardResult<TConfigError, TTokenError, TAccountError>, { ok: true }>;

/** Steps 0-2 (see this file's header). MAY THROW — both public runners below wrap it in their own single try/catch. */
async function runStepsZeroToTwo<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string>(
  authorizationHeader: string | null,
  opts: PanelLocationGuardOptions<TVerified, TConfigError, TTokenError, TAccountError>
): Promise<StepsZeroToTwo<TVerified, TConfigError, TTokenError, TAccountError>> {
  for (const gate of opts.gates) {
    if (!gate.ok()) return { ok: false, status: 503, error: gate.error };
  }

  const token = bearerToken(authorizationHeader);
  if (!token) return { ok: false, status: 401, error: opts.missingTokenError };

  const verified = opts.verifyToken(token);
  if (!verified) return { ok: false, status: 401, error: opts.invalidTokenError };

  const resolved = await opts.resolveAccount(verified);
  if (!resolved.ok) return resolved;
  return { ok: true, verified, location: resolved.location };
}

/**
 * Steps 0-2 only — the location, no number, no tenant. For routes that act on
 * the location as a whole (the embed's add-a-number route). Never throws, same
 * contract as `runBridgePanelGuard`.
 */
export async function runBridgePanelLocationGuard<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string>(
  authorizationHeader: string | null,
  opts: PanelLocationGuardOptions<TVerified, TConfigError, TTokenError, TAccountError>
): Promise<PanelLocationGuardResult<TConfigError, TTokenError, TAccountError>> {
  try {
    const result = await runStepsZeroToTwo(authorizationHeader, opts);
    if (!result.ok) return result;
    return { ok: true, location: result.location };
  } catch (err) {
    // Same discipline as `runBridgePanelGuard`'s catch below.
    console.error(`${opts.logPrefix} failed unexpectedly:`, err);
    return { ok: false, status: 500, error: "internal" };
  }
}

/**
 * Run every check for one guarded request. See this file's header for the
 * full step-by-step contract. Dependency-injected and pure aside from
 * whatever `gates`/`verifyToken`/`resolveAccount`/`resolveSlot`/`lookupNumber`
 * themselves do — this function itself makes no network or database call.
 */
export async function runBridgePanelGuard<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string>(
  authorizationHeader: string | null,
  opts: PanelGuardOptions<TVerified, TConfigError, TTokenError, TAccountError>
): Promise<PanelGuardResult<TConfigError, TTokenError, TAccountError>> {
  try {
    const result = await runStepsZeroToTwo(authorizationHeader, opts);
    if (!result.ok) return result;

    // Step 3 — see this file's header. Only ever reached by a caller that
    // already passed every older check, in their original order.
    const slot = opts.resolveSlot(result.verified);
    if (!slot.ok) return { ok: false, status: 400, error: "invalid_slot" };
    const number = await opts.lookupNumber(result.location.locationId, slot.slot);
    if (!number) return { ok: false, status: 404, error: "unknown_number" };

    // Enumerated, never spread: `number` is a full `LocationNumber` in
    // production and nothing beyond its tenant id belongs on this object.
    return {
      ok: true,
      account: { tenantId: number.tenantId, slot: slot.slot, label: result.location.label, status: result.location.status },
    };
  } catch (err) {
    // NEVER logs the token, the account, or anything request-shaped — only
    // the fact that something threw, mirroring the original embed guard's
    // identical discipline.
    console.error(`${opts.logPrefix} failed unexpectedly:`, err);
    return { ok: false, status: 500, error: "internal" };
  }
}

/** The uniform body shape every guard-backed route renders for a non-ok result — the JSON shape itself is shared; the per-code MESSAGE text stays feature-specific (each feature's own `guardFailureResponseBody`-style function builds one of these). */
export interface GuardFailureBody {
  ok: false;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Bridge session redaction — generic over which feature is calling, since
// stripping `coachId` (the bridge's own tenant-authorising id, see
// `BridgeSessionSnapshot`'s own field, src/lib/whatsapp-bridge.ts) before a
// session snapshot is ever serialised is identical work regardless of
// whether the caller is the GHL embed or a connect-link session. Moved
// verbatim from `src/app/api/crm/embed/guard.ts`'s original
// `redactBridgeSessionResult` — see that file's original header (now
// restated here) for the full "MAJOR 2 follow-on" finding this closes.
// ---------------------------------------------------------------------------

export type PanelBridgeSessionSnapshot = Omit<BridgeSessionSnapshot, "coachId">;

export type PanelBridgeSessionResult = { ok: true; session: PanelBridgeSessionSnapshot } | BridgeFailure;

/** Strips `coachId` off a bridge session result before it is ever handed to `NextResponse.json` — see this section's header. A `BridgeFailure` (`ok: false`) carries no session at all and passes through untouched. */
export function redactBridgeSessionResult(result: BridgeSessionResult): PanelBridgeSessionResult {
  if (!result.ok) return result;
  const { status, phoneNumber, qr, sentToday, dailyCap, queueLength } = result.session;
  return { ok: true, session: { status, phoneNumber, qr, sentToday, dailyCap, queueLength } };
}

/**
 * Belt-and-braces scrub of a tenant id out of a bridge failure's own
 * free-form `message` string — adversarial review lens 5, finding 8 (MINOR,
 * fixed). Moved here verbatim from `src/app/api/connect/guard.ts` (which
 * re-exports it unchanged; see that file for the full finding) so the GHL
 * embed's routes can use the same choke point now that they too address
 * several numbers (Task 4). `redactBridgeSessionResult` strips
 * `session.coachId` structurally on its SUCCESS branch, but a
 * `BridgeFailure` has no `session` object, only a `message`, and would
 * otherwise pass through unredacted.
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

/**
 * The ONE thing a connect/status route hands `NextResponse.json`: the bridge
 * result minus `session.coachId`, with the tenant scrubbed out of a failure
 * message too. Every connect/status route on both surfaces (embed and
 * connect link) calls this, so "the tenant id is never returned" is enforced
 * in one tested place rather than restated per route.
 */
export function toPanelBridgeResponse(result: BridgeSessionResult, tenantId: string): PanelBridgeSessionResult {
  const redacted = redactBridgeSessionResult(result);
  return redacted.ok ? redacted : scrubTenantIdFromFailure(redacted, tenantId);
}

// ---------------------------------------------------------------------------
// Small JSON request bodies (Task 4). The bridge-driving routes used to take
// no body at all; they now take an optional `{ slot }` (and the embed numbers
// route a `{ label }`). Same pre-check + post-read byte cap discipline as
// `POST /api/crm/embed/session` (see that route's header, finding 10): a
// dishonest `Content-Length` is refused before buffering, and the real byte
// length is re-checked after.
// ---------------------------------------------------------------------------

/** Far above any real `{ slot, label }` body (a few dozen bytes). */
export const MAX_PANEL_BODY_BYTES = 4 * 1024;

/**
 * Read a small JSON object body. An EMPTY body is `{}` (every pre-slot client
 * posts none, and must keep resolving slot 1). Oversized, non-JSON, or
 * non-object bodies are `null`, which each caller maps to its own 400.
 */
export async function readSmallJsonBody(request: Request, maxBytes: number = MAX_PANEL_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (!Number.isFinite(declared) || declared > maxBytes) return null;
  }
  const raw = await request.text();
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength === 0) return {};
  if (byteLength > maxBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
