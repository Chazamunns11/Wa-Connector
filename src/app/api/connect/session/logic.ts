/**
 * `POST /api/connect/session`'s decision logic, extracted out of `route.ts`
 * — adversarial review lens 5, finding 3 (MAJOR, fixed). This route holds
 * the most bespoke security logic in the per-client connect-link feature
 * (docs/GHL-PROVIDER-CLIENT-MIGRATION.md) — a public, unauthenticated,
 * bearer-credential-verifying endpoint — and had ZERO test coverage before
 * this fix, because everything it did was wired directly into a Next.js
 * `Request`/`NextResponse` handler that a plain `node --test` run cannot
 * construct. `decideConnectSession` below is DEPS-INJECTED exactly like
 * `authorizeConnectRequest` (src/app/api/connect/guard.ts) and
 * `resolveGhlAccessToken` (src/lib/ghl-provider.ts) already are, so
 * `scripts/test/ghl-connect-link.test.ts` can exercise the real decision
 * logic — including the throttle-before-HMAC ordering and the 8KB body
 * cap — with a fake repo and fake deps, no network, no Supabase, no Next
 * runtime.
 *
 * STEP ORDER HAS ONE DELIBERATE CHANGE FROM `route.ts`'s ORIGINAL NUMBERED
 * LIST (adversarial review lens 5, finding 7b — MINOR, fixed alongside this
 * extraction): the throttle check used to run before the body was read at
 * all; it now runs after the cheap byte-cap-check-and-JSON-parse but still
 * before `verifyConnectLinkToken` (the actual HMAC work), because the
 * throttle is now keyed by `(ip, token)` rather than `ip` alone and needs the
 * parsed token to do that — see `ConnectSessionDeps.checkThrottle`'s own
 * comment below and `src/lib/connect-throttle.ts`'s header for the full
 * reasoning.
 *
 * DELIBERATELY ZERO NEXT IMPORTS, same discipline as
 * `src/lib/bridge-panel-guard.ts` (see that file's own header for the full
 * "why") — this must stay loadable under `scripts/test/alias-hook.mjs`'s
 * plain-node loader. `route.ts` is the only thing that imports `next/server`;
 * this file imports only `@/lib/*`, all of which are already proven loadable
 * outside Next by the existing guard tests.
 *
 * WHAT MOVED HERE FROM `route.ts`, AND WHAT DIDN'T:
 *   - The three config gates, the POST-READ body-byte-cap check, the JSON
 *     parse + shape check, the throttle call, `verifyConnectLinkToken`, the
 *     account re-read, the version check, the `disabled` branch, and the
 *     session mint + summary + bridge-health probe on success — ALL of it,
 *     because all of it is a pure decision given an IP and a raw body
 *     string.
 *   - The `Content-Length` PRE-check (before the body is even read off the
 *     stream) stays in `route.ts` — it operates on `Request.headers`, which
 *     is I/O plumbing this module has no business modelling, and its whole
 *     job is avoiding ever buffering an oversized body in the first place
 *     (the POST-read cap this module DOES enforce is the backstop for a
 *     request with no honest `Content-Length` at all — see `route.ts`'s own
 *     header for why both checks exist). Mapping a `ConnectSessionDecision`
 *     to an HTTP status/JSON body also stays in `route.ts`, mirroring
 *     `guardFailureResponseBody`'s identical split for the guard.
 *
 * ONE NUMBER PER LINK (several WhatsApp numbers per location, Task 4). The
 * link token names a slot (`s`, see `src/lib/ghl-connect-link.ts`'s header;
 * absent means slot 1). After every older check passes, step 9 resolves that
 * slot within the token's location (`getLocationNumberBySlot`); a slot whose
 * number has since been removed decides `unknown_number`. The session token
 * is minted with the SAME slot, the summary is THAT number's, and the
 * decision carries `number: { slot, label, isDefault }` so the page can say
 * which number it is connecting. Never the tenant id.
 */
import type { GhlAccountStatus, GhlEmbedWhatsappSummary, LocationNumber, WhatsappSessionSummary } from "@/lib/types";
import type { LocationSlot } from "@/lib/location-numbers";
import { toEmbedWhatsappSummary } from "@/lib/embed-summary";
import { isConnectLinkConfigured, mintConnectSessionToken, verifyConnectLinkToken } from "@/lib/ghl-connect-link";
import { getWhatsappBridgeHealth, isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import { checkConnectSessionThrottle, type ConnectThrottleDecision } from "@/lib/connect-throttle";

/** See `route.ts`'s own header, step 3 — tighter than the embed session route's 16KB since this body carries nothing but the token itself. Re-exported so `route.ts`'s `Content-Length` pre-check and this module's post-read re-check can never drift to two different numbers. */
export const MAX_CONNECT_SESSION_BODY_BYTES = 8 * 1024;

/** The narrow repo slice this decision touches — `webhookRepo` in production, a fake in tests, same pattern as `ConnectGuardRepo` (src/app/api/connect/guard.ts). */
export interface ConnectSessionRepo {
  getGhlAccountByLocationId(locationId: string): Promise<{
    locationId: string;
    tenantId: string;
    label: string;
    status: GhlAccountStatus;
    connectLinkVersion: number | null;
  } | null>;
  getWhatsappSessionSummary(tenantId: string): Promise<WhatsappSessionSummary | null>;
  /** Step 9 — the link's slot to its number, within the token's location. */
  getLocationNumberBySlot(locationId: string, slot: number): Promise<LocationNumber | null>;
}

/** Every external dependency `decideConnectSession` touches, injected so tests can fake every one of them independently — see `defaultConnectSessionDeps` for what production actually wires in. */
export interface ConnectSessionDeps {
  isConnectLinkConfigured: () => boolean;
  isWhatsappBridgeConfigured: () => boolean;
  /**
   * Called after the token string is parsed out of the body but BEFORE it is
   * ever HMAC-verified — adversarial review lens 5, finding 7b (MINOR,
   * fixed). Keyed by `(ip, token)`, not `ip` alone, so a shared IP (Charlie
   * testing 11-15 different clients' links from one office connection) can
   * never exhaust one link's budget by spending another's — see
   * `src/lib/connect-throttle.ts`'s own header for the full reasoning.
   */
  checkThrottle: (ip: string | null, token: string | null) => ConnectThrottleDecision;
  verifyConnectLinkToken: typeof verifyConnectLinkToken;
  mintConnectSessionToken: typeof mintConnectSessionToken;
  getBridgeHealth: () => Promise<{ ok: boolean }>;
}

/** The real wiring `route.ts` uses — `defaultGhlProviderDeps` (src/lib/ghl-provider.ts) is the precedent for this exact "one real object, swapped for a fake in tests" shape. */
export const defaultConnectSessionDeps: ConnectSessionDeps = {
  isConnectLinkConfigured,
  isWhatsappBridgeConfigured,
  checkThrottle: checkConnectSessionThrottle,
  verifyConnectLinkToken,
  mintConnectSessionToken,
  getBridgeHealth: async () => ({ ok: (await getWhatsappBridgeHealth()).ok }),
};

/**
 * Every outcome `decideConnectSession` can reach — `route.ts` maps each of
 * these to the exact status/body its own header documents. Mirrors
 * `ConnectGuardResult`'s discriminated-union shape (src/app/api/connect/guard.ts).
 */
export type ConnectSessionDecision =
  | { kind: "config_error"; code: "connect_not_configured" | "bridge_not_configured" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "invalid_body" }
  /** SAFE TO SAY SPECIFICALLY — see `route.ts`'s own header, step 4, and `verifyKindedStateWithReason`'s "THE ORDERING IS THE SECURITY PROPERTY" (src/lib/onboarding.ts). */
  | { kind: "expired" }
  /**
   * THE NON-ORACLE STATE — adversarial review lens 5, finding 3's own naming.
   * Reached by BOTH a forged/tampered/wrong-kind token AND a well-formed,
   * genuinely-signed token whose `locationId` no longer names an installed
   * `ghl_accounts` row. `route.ts` renders the SAME generic body for both —
   * see `scripts/test/ghl-connect-link.test.ts`'s test named for this
   * specifically, which pins that a "better error message" edit distinguishing
   * the two cases in the future would be a real regression, not a UX
   * improvement.
   */
  | { kind: "invalid_link" }
  | { kind: "revoked" }
  | { kind: "disabled" }
  /** Step 9 — the link's number was removed after it was minted. Safe to say: the link already proved it was genuine and current. */
  | { kind: "unknown_number" }
  | {
      kind: "ok";
      token: string;
      label: string;
      summary: GhlEmbedWhatsappSummary | null;
      bridgeReachable: boolean;
      /** Which number this link connects — slot and label only, never the tenant id. */
      number: { slot: LocationSlot; label: string | null; isDefault: boolean };
    };

/**
 * The full decision for one `POST /api/connect/session` attempt — see this
 * file's header for what moved here and why, and `route.ts`'s own header for
 * the numbered check order this function implements verbatim (steps 1-2 and
 * 4-8; step 3's `Content-Length` pre-check is the one part that stays in
 * `route.ts`, though the post-read byte-length re-check this function DOES
 * own is the one that actually matters for a request with no honest
 * declared length at all).
 *
 * `rawBody` is the request body already read to a string by the caller —
 * this function never touches a `Request`/stream itself, which is what makes
 * it callable with a plain string in a test.
 */
export async function decideConnectSession(
  repo: ConnectSessionRepo,
  deps: ConnectSessionDeps,
  input: { ip: string | null; rawBody: string }
): Promise<ConnectSessionDecision> {
  // Step 1 — never trust a prior render; see route.ts's own header.
  if (!deps.isConnectLinkConfigured()) return { kind: "config_error", code: "connect_not_configured" };
  if (!deps.isWhatsappBridgeConfigured()) return { kind: "config_error", code: "bridge_not_configured" };

  // Step 2 (post-read half only — see this file's header) — a real
  // connect-link token is a few hundred bytes of base64url; this is generous
  // headroom, tighter than the embed session route's 16KB because this body
  // carries nothing but the token itself. Deliberately BEFORE the throttle
  // check below — see the next comment for why the order of these two
  // swapped (adversarial review lens 5, finding 7b).
  const rawBodyByteLength = Buffer.byteLength(input.rawBody, "utf8");
  if (rawBodyByteLength === 0 || rawBodyByteLength > MAX_CONNECT_SESSION_BODY_BYTES) {
    return { kind: "invalid_body" };
  }

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return { kind: "invalid_body" };
  }
  const token = typeof body === "object" && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (typeof token !== "string" || token.length === 0) {
    return { kind: "invalid_body" };
  }

  // Step 3 — BEFORE any HMAC verify, but now AFTER the cheap body parse just
  // above rather than before it (adversarial review lens 5, finding 7b,
  // MINOR, fixed — this used to run ip-only, before the body was read at
  // all). Needs the parsed `token` string to key the throttle bucket by
  // `(ip, token)` rather than `ip` alone — see
  // src/lib/connect-throttle.ts's own header for why that keying matters and
  // why re-ordering past a plain `JSON.parse`/`typeof` check (no
  // cryptography, negligible cost even under a hammering loop) still honours
  // "before any HMAC work": the byte-cap check above already bounds what an
  // attacker can make this route buffer/parse before ever reaching this
  // line, regardless of throttle state.
  const throttle = deps.checkThrottle(input.ip, token);
  if (!throttle.allowed) {
    return { kind: "rate_limited", retryAfterSeconds: throttle.retryAfterSeconds };
  }

  // Step 4 — reason-aware. Only `expired` is ever named specifically; every
  // other failure folds into the generic `invalid_link`.
  const verified = deps.verifyConnectLinkToken(token);
  if (!verified.ok) {
    if (verified.reason === "expired") return { kind: "expired" };
    return { kind: "invalid_link" };
  }

  // Step 5 — a missing row gets the SAME generic decision as step 4's
  // failures. Never a distinguishable "not found" — see `invalid_link`'s own
  // JSDoc above.
  const account = await repo.getGhlAccountByLocationId(verified.locationId);
  if (!account) {
    return { kind: "invalid_link" };
  }

  // Step 6 — safe to distinguish; see route.ts's own header.
  if (account.connectLinkVersion === null || verified.v !== account.connectLinkVersion) {
    return { kind: "revoked" };
  }

  // Step 7 — an operator switch, not an error.
  if (account.status === "disabled") {
    return { kind: "disabled" };
  }

  // Step 9 (Task 4) — which number. See this file's header. Looked up in the
  // TOKEN's location, never anything from the request body.
  const number = await repo.getLocationNumberBySlot(account.locationId, verified.slot);
  if (!number) {
    return { kind: "unknown_number" };
  }

  // Step 8 — the session token carries the link's own slot, and the summary
  // is that number's (one read).
  const sessionToken = deps.mintConnectSessionToken(account.locationId, account.connectLinkVersion, verified.slot);
  const summary = await repo.getWhatsappSessionSummary(number.tenantId);
  const bridgeReachable = (await deps.getBridgeHealth()).ok;

  return {
    kind: "ok",
    token: sessionToken,
    label: account.label,
    summary: toEmbedWhatsappSummary(summary),
    bridgeReachable,
    // Enumerated, never spread — `number` carries the tenant id.
    number: { slot: verified.slot, label: number.label, isDefault: number.isDefault },
  };
}
