/**
 * POST /api/crm/embed/session — the GHL Custom Page embed's front door
 * (src/lib/ghl-embed.ts). `CrmEmbedClient.tsx` calls this exactly once per
 * postMessage handshake (and again, transparently, whenever a later embed
 * WhatsApp call comes back 401 — see that component's header), handing it
 * the RAW encrypted `payload` string GHL's `REQUEST_USER_DATA_RESPONSE`
 * message carried. This route decrypts it, resolves which (if any)
 * FitClosers-installed GHL location it names, and — only for a genuinely
 * active install — mints a short-lived embed token the client holds in
 * memory for the rest of that session.
 *
 * ORDERED, FAIL-CLOSED CHECKS (each one a hard gate, not a soft default):
 *   1. `isGhlEmbedConfigured()` — `GHL_SSO_SHARED_SECRET` OR
 *      `ONBOARD_STATE_SECRET` unset -> 503 (see `isGhlEmbedConfigured`'s own
 *      JSDoc, src/lib/ghl-embed.ts, for why BOTH are required — adversarial
 *      review lens 4, finding 1). Never attempt to decrypt with no secret to
 *      decrypt against, and never mint a token under a fallback signing key.
 *   2. Live mode (`isLiveMode()`) — an embed session must never be able to
 *      drive a REAL WhatsApp bridge from a demo/preview deployment, same
 *      rule `assertLiveMode()` enforces for a coach's own WhatsApp actions
 *      (`src/app/client/setup/whatsapp-actions.ts`) and for the identical
 *      reason: a demo deployment has no business linking a real phone. 503,
 *      not a friendly demo card — there is no "browse the demo" affordance
 *      for a GHL iframe, so the server component
 *      (`src/app/embed/crm/page.tsx`) already refuses to even start the
 *      handshake when this is false; reaching here in that state means
 *      something bypassed the client (or env drifted mid-session), so this
 *      is the backstop, not the primary UX.
 *   3. Body shape — `{ payload: string }`, and the RAW body capped at ~16KB
 *      before it is even JSON-parsed (a real GHL SSO payload is a few
 *      hundred bytes of base64; 16KB is generous headroom against a
 *      pathological body tying up a decrypt attempt for no reason). A
 *      dishonest/oversized `Content-Length` is refused before the body is
 *      even read; the byte cap is re-checked against the ACTUAL body
 *      afterwards regardless (adversarial review lens 4, finding 10 — see
 *      `rawBodyByteLength` below). Anything else -> 400.
 *   4. Decrypt (`decryptGhlSsoPayload`) + resolve user context
 *      (`parseGhlUserContext`) — either failing (bad ciphertext, wrong
 *      secret, agency-context payload with no `activeLocation`, …) -> 403
 *      `invalid_sso_payload`. This is the ENTIRE trust boundary: everything
 *      downstream of this line trusts `activeLocation` exactly because it
 *      only exists after a successful decrypt of a payload only GHL itself
 *      could have produced (encrypted with the Shared Secret this app also
 *      holds) — see "ACCEPTED RISK: THE PAYLOAD IS REPLAYABLE" below for the
 *      one thing that trust boundary does NOT cover.
 *   5. `getGhlAccountByLocationId(activeLocation)` — no row means this
 *      location was never installed with FitClosers's WhatsApp provider at
 *      all. Returns 200 `{ state: "not_installed" }`, NO token — this is a
 *      normal, expected outcome (most GHL locations that ever load this
 *      Custom Page won't have installed the provider), not an error.
 *   6. `status === "disabled"` — an operator deliberately turned this
 *      location off. Returns 200 `{ state: "disabled" }`, NO token.
 *   7. Otherwise: mint a token (`mintGhlEmbedToken`), probe the bridge's own
 *      `/health` (see "THE BRIDGE-HEALTH PROBE LIVES HERE, NOT ON THE
 *      UNAUTHENTICATED SHELL" below), and return
 *      `{ state: "ok", token, label, summary, bridgeReachable }`, where
 *      `summary` is built from the SAME DB-derived `getWhatsappSessionSummary`
 *      every other WhatsApp surface in this codebase renders from (works
 *      even with the bridge down) — MINUS `coachId` (see
 *      "NEVER THE TENANT ID EITHER" below).
 *
 * NEVER A STACK TRACE, NEVER THE PAYLOAD ECHOED BACK. Every response body is
 * one of the fixed shapes above — the encrypted payload, the decrypted
 * plaintext, and the Shared Secret never appear in any response or log line
 * this route writes (see `decryptGhlSsoPayload`'s own NEVER LOGS note). The
 * whole handler runs inside one try/catch (adversarial review lens 4, finding
 * 6 — MINOR): `isLiveMode()` throws on a partial Supabase env, and both repo
 * calls below throw on any Postgres hiccup — none of that may ever reach the
 * client as an unhandled 500 with a stack trace.
 *
 * NEVER THE TENANT ID EITHER (adversarial review lens 4, finding 2 — MAJOR,
 * fixed). `summary` used to be `getWhatsappSessionSummary(account.tenantId)`
 * returned verbatim — and `WhatsappSessionSummary.coachId` (src/lib/types.ts),
 * for a GHL location, IS `ghl_accounts.tenant_id`: the exact id
 * `src/lib/whatsapp-bridge.ts` authorizes every bridge call on
 * (`/sessions/${coachId}/...`). That handed an unauthenticated GHL iframe the
 * one id this whole embed exists to keep away from it, directly contradicting
 * this file's own "never client-supplied, never returned" posture and
 * `connect/route.ts`'s identical claim. `toEmbedSummary` below builds the
 * response by ENUMERATING fields (never spreading `summary` and deleting
 * `coachId`), backed by `GhlEmbedWhatsappSummary` (src/lib/types.ts) — a type
 * that structurally cannot carry `coachId`, so a future field added to
 * `WhatsappSessionSummary` can never ride along by default.
 *
 * THE BRIDGE-HEALTH PROBE LIVES HERE, NOT ON THE UNAUTHENTICATED SHELL
 * (adversarial review lens 4, finding 4 — MINOR, fixed). `src/app/embed/crm/page.tsx`
 * used to call `getWhatsappBridgeHealth()` itself, on every render — meaning
 * every anonymous GET of a public URL (no SSO handshake required to trigger
 * a page render) cost one outbound Railway request with a 5s timeout, purely
 * to compute a boolean nobody behind a failed/nonexistent handshake would
 * ever see. Moving the probe here means it only ever fires once a payload has
 * genuinely decrypted to an active, installed location — i.e. once there is
 * a real reason to believe a `WhatsappConnectionPanel` is about to render.
 * The shell's own "not switched on yet" card still renders from plain env
 * booleans (`isGhlEmbedConfigured()`/`isLiveMode()`/`isWhatsappBridgeConfigured()`),
 * no network involved — see that page's own header.
 *
 * ACCEPTED RISK: THE PAYLOAD IS REPLAYABLE (adversarial review lens 4,
 * finding 7 — MINOR, documented, not fixed — this is inherent to GHL's own
 * protocol, not a bug in this file). The decrypted SSO payload carries no
 * timestamp or nonce of its own, so a captured `payload` string mints a
 * working embed token for that location indefinitely — there is no
 * "this payload is stale" check possible from what GHL hands us. This is not
 * "only GHL can produce this" in the sense of "only GHL can produce this
 * RIGHT NOW"; it is "only GHL (or whoever captured a payload GHL once
 * produced) can produce this at all". TWO REVOCATIONS DO WORK if a payload
 * is ever suspected captured: (a) disable the affected `ghl_accounts` row —
 * `authorizeGhlEmbedRequest`'s per-call re-read (src/app/api/crm/embed/guard.ts)
 * refuses a `disabled` account within one poll tick regardless of what token
 * or payload someone is replaying; (b) rotate `GHL_SSO_SHARED_SECRET` —
 * invalidates every future decrypt attempt for EVERY location at once (a
 * blunter, whole-deployment lever). Neither is automatic; both require an
 * operator to act. TODO: if the first real decrypted GHL payload turns out to
 * carry a timestamp field GHL's docs don't currently document, enforce a
 * freshness window on it here (reject anything older than a few minutes,
 * mirroring `verifyKindedState`'s own `exp` check) — until then, there is
 * nothing to enforce.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { decryptGhlSsoPayload, ghlSsoSharedSecret, isGhlEmbedConfigured, mintGhlEmbedToken, parseGhlUserContext } from "@/lib/ghl-embed";
import { getWhatsappBridgeHealth, isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import type { GhlEmbedWhatsappSummary, WhatsappSessionSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Generous headroom over a real GHL SSO payload's actual size (a few hundred bytes of base64) — just enough to refuse a pathologically large body before it is ever JSON-parsed or handed to a decrypt attempt. Genuinely bytes, not JS string `.length` — see `rawBodyByteLength` below. */
const MAX_BODY_BYTES = 16 * 1024;

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

/**
 * Strips `coachId` off a session summary before it is ever handed to
 * `NextResponse.json` — see this file's header, "NEVER THE TENANT ID
 * EITHER". `null` in, `null` out (a coach — here, GHL location — with no
 * `whatsapp_sessions` row at all).
 */
function toEmbedSummary(summary: WhatsappSessionSummary | null): GhlEmbedWhatsappSummary | null {
  if (!summary) return null;
  const { status, phoneNumber, lastConnectedAt, lastDisconnectReason, sentToday } = summary;
  return { status, phoneNumber, lastConnectedAt, lastDisconnectReason, sentToday };
}

export async function POST(request: Request) {
  try {
    if (!isGhlEmbedConfigured()) return fail(503, "embed_not_configured");

    // Adversarial review lens 4, finding 10 (MINOR) — refuse a dishonestly
    // large declared length BEFORE ever buffering the body. Not a substitute
    // for the post-read check below (a chunked request can omit
    // `Content-Length` entirely, and nothing stops a client lying about it
    // short), just cheaper for the common case of an obviously oversized
    // request.
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const declared = Number(declaredLength);
      if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
        return fail(400, "invalid_body");
      }
    }

    const rawBody = await request.text();
    // `rawBody.length` is a count of UTF-16 code units, not bytes — this
    // used to be the actual check, and it undercounts real byte size for any
    // multi-byte UTF-8 character (a 16k-character multibyte body can be
    // ~64KB on the wire while reading as "16k" against a byte-named
    // constant). `Buffer.byteLength` is what actually measures what
    // `MAX_BODY_BYTES` claims to bound.
    const rawBodyByteLength = Buffer.byteLength(rawBody, "utf8");
    if (rawBodyByteLength === 0 || rawBodyByteLength > MAX_BODY_BYTES) {
      return fail(400, "invalid_body");
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return fail(400, "invalid_body");
    }
    const payload = typeof body === "object" && body !== null ? (body as Record<string, unknown>).payload : undefined;
    if (typeof payload !== "string" || payload.length === 0) {
      return fail(400, "invalid_body");
    }

    const secret = ghlSsoSharedSecret();
    if (!secret) return fail(503, "embed_not_configured"); // re-checked defensively — isGhlEmbedConfigured() above already guarantees this, but never trust a null-secret decrypt attempt.

    const decrypted = decryptGhlSsoPayload(payload, secret);
    const userContext = decrypted ? parseGhlUserContext(decrypted) : null;
    if (!userContext) {
      console.warn("[api/crm/embed/session] SSO payload did not decrypt to a usable sub-account user context");
      return fail(403, "invalid_sso_payload");
    }

    const account = await repo.getGhlAccountByLocationId(userContext.activeLocation);
    if (!account) {
      return NextResponse.json({ ok: true, state: "not_installed" });
    }
    if (account.status === "disabled") {
      return NextResponse.json({ ok: true, state: "disabled" });
    }

    const token = mintGhlEmbedToken(account.locationId);
    const summary = await repo.getWhatsappSessionSummary(account.tenantId);

    // See this file's header, "THE BRIDGE-HEALTH PROBE LIVES HERE" — only
    // reachable once a payload has genuinely decrypted to an active,
    // installed location, and only attempted when the bridge is even
    // configured on this deployment (mirrors `bridgeConfigured`'s own gate
    // on every other WhatsApp surface — no probe result nothing will ever
    // display isn't worth the request).
    const bridgeReachable = isWhatsappBridgeConfigured() ? (await getWhatsappBridgeHealth()).ok : null;

    return NextResponse.json({ ok: true, state: "ok", token, label: account.label, summary: toEmbedSummary(summary), bridgeReachable });
  } catch (err) {
    // Adversarial review lens 4, finding 6 (MINOR) — see this file's header.
    // Never echoes `err` into the response.
    console.error("[api/crm/embed/session] POST failed unexpectedly:", err);
    return fail(500, "internal");
  }
}
