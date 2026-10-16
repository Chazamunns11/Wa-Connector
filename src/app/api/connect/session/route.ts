/**
 * POST /api/connect/session — the per-client connect-link feature's front
 * door (docs/GHL-PROVIDER-CLIENT-MIGRATION.md, src/lib/ghl-connect-link.ts).
 * `ConnectLinkClient.tsx` calls this exactly once per page load with the
 * `token` from the `/connect/[token]` URL (and again, transparently, on any
 * later `/api/connect/whatsapp/*` 401 — mirrors `CrmEmbedClient.tsx`'s
 * identical shape), and — for a genuinely valid, non-revoked, non-disabled
 * link — gets back a short-lived session token to actually drive the bridge
 * with.
 *
 * PUBLIC AND UNAUTHENTICATED UNTIL THE TOKEN VERIFIES. Unlike the GHL embed's
 * session route (which only ever receives a payload GHL itself produced via
 * an iframe postMessage handshake), this route is reachable by literally
 * anyone who has the URL — the connect link IS the entire authorization (see
 * `src/lib/ghl-connect-link.ts`'s header, "A CONNECT LINK IS A BEARER
 * CREDENTIAL"). Every check below exists to make a captured/guessed/expired
 * token behave EXACTLY like this endpoint's normal, expected, hostile-by-
 * default traffic — never to trust anything the request itself claims beyond
 * what the signature proves.
 *
 * ORDERED, FAIL-CLOSED CHECKS:
 *   1. `isConnectLinkConfigured()`, `isLiveMode()`, `isWhatsappBridgeConfigured()`
 *      — ALL THREE, INDEPENDENTLY, EVERY CALL. Never trust that
 *      `/connect/[token]`'s server component already checked any of these —
 *      see that page's own header for why it re-verifies anyway; this route
 *      must never rely on a prior render having done so. Any false -> 503.
 *   2. Body shape — `{ token: string }`, RAW body capped at 8KB before it is
 *      even JSON-parsed, same `Content-Length` pre-check + post-read
 *      `Buffer.byteLength` re-check pattern as
 *      `src/app/api/crm/embed/session/route.ts` (see that route's own header
 *      for why BOTH checks exist — a dishonest/oversized declared length is
 *      refused before buffering, a chunked request with no declared length at
 *      all is still caught after). A real connect-link token is a few hundred
 *      bytes of base64url; 8KB is generous headroom, tighter than the embed
 *      session route's 16KB because this body carries nothing but the token
 *      itself (no encrypted SSO payload to bound for).
 *   3. `checkConnectSessionThrottle` — see src/lib/connect-throttle.ts's own
 *      header for why this is a best-effort first line, not the real
 *      boundary. AFTER step 2's cheap parse (so the throttle bucket can be
 *      keyed by `(ip, token)`, not `ip` alone — adversarial review lens 5,
 *      finding 7b), but still BEFORE any HMAC verify — a hammering loop
 *      against this route should cost as close to nothing as possible once
 *      it is over the limit.
 *   4. `verifyConnectLinkToken` (src/lib/ghl-connect-link.ts) — reason-aware:
 *        - `expired` -> 410 `{ code: "link_expired" }`. SAFE TO SAY
 *          SPECIFICALLY: a token that verifies-but-expired already proves
 *          this app minted it for a real location at some point (the HMAC
 *          passed) — see `verifyKindedStateWithReason`'s own header,
 *          src/lib/onboarding.ts, "THE ORDERING IS THE SECURITY PROPERTY",
 *          for why that ordering is what makes this safe rather than an
 *          oracle.
 *        - `wrong_kind` / `invalid` / `missing_state_secret` -> 403 GENERIC
 *          `{ code: "invalid_link" }`. These three fold into ONE response,
 *          deliberately indistinguishable from each other and from the
 *          missing-account case in step 5 below — a forged token, a
 *          `ghl-connect-session` token replayed here (wrong kind), and a
 *          syntactically well-formed but never-actually-signed string must
 *          all look identical to whoever is holding one.
 *   5. Re-read `getGhlAccountByLocationId(locationId)`. A MISSING ROW GETS
 *      THE SAME GENERIC `invalid_link` 403 AS STEP 4's failures — NEVER a
 *      distinguishable "not found" — a signed token for a since-uninstalled
 *      location must be indistinguishable from garbage, so nothing this
 *      route ever says confirms whether a `locationId` exists at all.
 *   6. Version mismatch (`token.v !== account.connectLinkVersion`, or the
 *      column is `null` — migration 0075 not applied) -> 403
 *      `{ code: "link_revoked" }`. SAFE TO DISTINGUISH from step 4/5's
 *      generic failure: the token's signature already proved provenance (a
 *      forged token could never reach this branch — a version mismatch is
 *      only reachable for a token this app genuinely signed), so confirming
 *      "this specific link has since been revoked" tells an attacker nothing
 *      they had not already proven.
 *   7. `disabled` status -> 200 `{ ok: true, state: "disabled" }`, no token —
 *      an operator deliberately switched this location off; not an error,
 *      mirrors the embed session route's identical branch.
 *   8. Otherwise: mint a session token (`mintConnectSessionToken`), probe the
 *      bridge's own `/health` (gated on `isWhatsappBridgeConfigured()` —
 *      already true by step 1, so this always attempts, mirroring the embed
 *      session route's own probe-only-once-reachable posture), and return
 *      `{ ok: true, state: "ok", token, label, summary, bridgeReachable }`.
 *      `summary` reuses `GhlEmbedWhatsappSummary` (src/lib/types.ts) —
 *      NEVER `coachId`/tenant id, built by ENUMERATING fields exactly like
 *      `toEmbedSummary` in the embed session route, never a spread.
 *
 * NEVER A STACK TRACE, NEVER THE TOKEN ECHOED BACK. The whole handler runs
 * inside one try/catch — same "genuinely total" discipline as every other
 * guard/route in this feature — and no response body below ever includes the
 * request's own `token` field, the session secret, or an internal error
 * message.
 *
 * ALL 8 STEPS ABOVE LIVE IN `logic.ts`'s `decideConnectSession` NOW, MINUS
 * THE `Content-Length` PRE-CHECK — adversarial review lens 5, finding 3
 * (MAJOR, fixed). This route held the most bespoke security logic in the
 * feature and had zero test coverage, because all of it used to be wired
 * directly into this handler's `Request`/`NextResponse` shapes, which a
 * plain `node --test` run cannot construct. See `logic.ts`'s own header for
 * exactly what moved and what (deliberately) didn't — this file is now a
 * thin adapter: pre-check `Content-Length`, read the body, call the decision
 * function, map its result to an HTTP response.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { decideConnectSession, defaultConnectSessionDeps, MAX_CONNECT_SESSION_BODY_BYTES } from "./logic";

export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: false, code, message, ...extra }, { status });
}

export async function POST(request: Request) {
  try {
    // Same declared-length pre-check + post-read byte re-check pattern as
    // the embed session route (see that route's own header for why both
    // exist) — the pre-check is the one piece of body handling that stays
    // here rather than in `decideConnectSession`: it operates on
    // `request.headers`, before the body is even read off the stream, which
    // is I/O plumbing the pure decision function has no business modelling.
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const declared = Number(declaredLength);
      if (!Number.isFinite(declared) || declared > MAX_CONNECT_SESSION_BODY_BYTES) {
        return fail(400, "invalid_body", "Malformed request.");
      }
    }

    const ip = clientIpFromHeaders(request.headers);
    const rawBody = await request.text();

    const decision = await decideConnectSession(repo, defaultConnectSessionDeps, { ip, rawBody });

    switch (decision.kind) {
      case "config_error":
        return fail(503, decision.code, "WhatsApp linking by link isn't available on this deployment right now.");
      case "rate_limited":
        return fail(429, "rate_limited", "Too many attempts — try again shortly.", { retryAfterSeconds: decision.retryAfterSeconds });
      case "invalid_body":
        return fail(400, "invalid_body", "Malformed request.");
      case "expired":
        return fail(410, "link_expired", "This link has expired — ask for a fresh one.");
      case "invalid_link":
        return fail(403, "invalid_link", "This link isn't valid.");
      case "revoked":
        return fail(403, "link_revoked", "This link has been revoked — ask for a fresh one.");
      case "disabled":
        return NextResponse.json({ ok: true, state: "disabled" });
      case "ok":
        return NextResponse.json({
          ok: true,
          state: "ok",
          token: decision.token,
          label: decision.label,
          summary: decision.summary,
          bridgeReachable: decision.bridgeReachable,
        });
    }
  } catch (err) {
    // Never echoes `err`, the request body, or the token into the response.
    console.error("[api/connect/session] POST failed unexpectedly:", err);
    return fail(500, "internal", "Something went wrong. Please try again.");
  }
}
