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
  tenantId: string;
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
export type PanelGuardResult<TConfigError extends string, TTokenError extends string, TAccountError extends string> =
  | { ok: true; account: PanelGuardAccount }
  | { ok: false; status: 401; error: TTokenError }
  | { ok: false; status: 403; error: TAccountError }
  | { ok: false; status: 503; error: TConfigError }
  | { ok: false; status: 500; error: "internal" };

export interface PanelGuardOptions<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string> {
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
   * Called ONLY after the token has verified; whatever this returns (403 or
   * ok) is the guard's own final result for that branch.
   */
  resolveAccount: (verified: TVerified) => Promise<{ ok: true; account: PanelGuardAccount } | { ok: false; status: 403; error: TAccountError }>;
  /** Log-line prefix for the catch-all — see this file's header, "NEVER THROWS". Never includes the token, the account, or anything request-shaped, same discipline as the original embed guard. */
  logPrefix: string;
}

/**
 * Run every check for one guarded request. See this file's header for the
 * full step-by-step contract. Dependency-injected and pure aside from
 * whatever `gates`/`verifyToken`/`resolveAccount` themselves do — this
 * function itself makes no network or database call.
 */
export async function runBridgePanelGuard<TVerified, TConfigError extends string, TTokenError extends string, TAccountError extends string>(
  authorizationHeader: string | null,
  opts: PanelGuardOptions<TVerified, TConfigError, TTokenError, TAccountError>
): Promise<PanelGuardResult<TConfigError, TTokenError, TAccountError>> {
  try {
    for (const gate of opts.gates) {
      if (!gate.ok()) return { ok: false, status: 503, error: gate.error };
    }

    const token = bearerToken(authorizationHeader);
    if (!token) return { ok: false, status: 401, error: opts.missingTokenError };

    const verified = opts.verifyToken(token);
    if (!verified) return { ok: false, status: 401, error: opts.invalidTokenError };

    return await opts.resolveAccount(verified);
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
