/**
 * COPIED from PortalHub `src/lib/onboarding.ts` — ONLY the kind-tagged signed
 * state (`SignedStateKind`, `signKindedState`, `verifyKindedState`,
 * `verifyKindedStateWithReason`) and the private helpers they need
 * (`STATE_TTL_MS`, `getStateSecret`, base64url). The Hub's invite tokens,
 * untagged onboard state, signup state and demo-session signers are NOT
 * copied. Bodies and comments are verbatim; comments that point at
 * `onboarding.ts` describe the PortalHub original.
 */
import { createHmac, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 60 * 60 * 1000; // 60 minutes — matches Supabase's OTP link lifetime


/**
 * Secret used to sign/verify the onboarding OAuth state. Prefers a dedicated
 * `ONBOARD_STATE_SECRET`; falls back to the existing `CRON_SECRET` so this
 * feature works with zero new required env vars (documented in
 * .env.example / docs/RUNBOOK.md — set `ONBOARD_STATE_SECRET` explicitly
 * once live rather than relying on the fallback long-term, since `CRON_SECRET`
 * then does double duty as two unrelated secrets).
 */
function getStateSecret(): string {
  const secret = process.env.ONBOARD_STATE_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    throw new Error(
      "Neither ONBOARD_STATE_SECRET nor CRON_SECRET is set — one is required to sign the GHL OAuth " +
        "install state and the connect/embed tokens. Set ONBOARD_STATE_SECRET (preferred) or CRON_SECRET before " +
        "using GHL install, connect links or the embed."
    );
  }
  return secret;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}


// ---------------------------------------------------------------------------
// KIND-TAGGED signed state (Charlie 30 Jul 2026 — self-serve coach mode,
// build batch 2; plan §D).
//
// `signOnboardState` above signs exactly one shape — `{token, exp}` — and is
// used by THREE different flows (onboarding invites, staff invites, closer
// invites) that all happen to carry a raw invite token. Self-serve signup
// carries something different (`{businessName, email}`) and, unlike those
// three, is reachable by a total stranger with no invite behind it. Signing
// it with the same untagged signer would mean a state minted for one purpose
// verifies for another — so every payload here carries an explicit `k` kind
// and `verifyKindedState` refuses anything whose kind isn't the one the
// caller asked for.
//
// MUTUAL UNREPLAYABILITY (both directions, deliberately):
//   - an untagged `{token, exp}` onboard state has no `k`, so
//     `verifyKindedState` rejects it;
//   - a kinded state has no `token`, so `verifyOnboardState`'s own
//     `typeof payload.token !== "string"` guard rejects it.
// Same secret, same HMAC construction, same TTL semantics — only the payload
// shape and the kind check differ. Nothing about the existing three flows
// changes.
// ---------------------------------------------------------------------------

/**
 * Every purpose a kinded state may be minted for. Adding a member here is
 * the ONLY way to create a new signed-state purpose — which is what keeps
 * "which flow is this state for" an enumerated, reviewable decision.
 *
 * - `signup` — `/signup` -> emailed link -> `/auth/callback?signup=<state>`
 *   (build batch 2, this file's section header above).
 * - `stripe-self` — a self-serve coach's own Stripe Connect round trip
 *   (`/api/stripe/connect/start|callback`, plan §H). Declared here so batch 3
 *   adds a branch rather than a second signer; unused as of batch 2.
 * - `ghl-install` — the GHL custom conversation provider's install round trip
 *   (`/api/crm/oauth/start|callback`, docs/GHL-PROVIDER-PLAN.md). Carries no
 *   payload at all (`{}`) — unlike `calendar-google`'s `closerId`, there is
 *   nothing location-specific to prove ahead of time: GHL's own "choose
 *   location" screen decides which sub-account, and the callback learns the
 *   `locationId` from GHL's OWN token response, not from anything this state
 *   carried. The state's only job here is proving an authenticated owner
 *   started this specific round trip recently.
 * - `ghl-embed` — the GHL Custom Page embed's short-lived session token
 *   (`src/lib/ghl-embed.ts`'s `mintGhlEmbedToken`/`verifyGhlEmbedToken`,
 *   `POST /api/crm/embed/session` and the three `/api/crm/embed/whatsapp/*`
 *   routes). Carries `{ locationId }` — the GHL sub-account id that the
 *   embed's decrypted, GHL-signed SSO payload vouched for
 *   (`activeLocation`), never anything client-supplied. 15-minute TTL
 *   (`EMBED_TOKEN_TTL_MS`), re-minted silently on expiry — see that file's
 *   header for the full security rationale (a WhatsApp QR is a device-link
 *   grant, same severity as a password, so this token is the ONLY thing that
 *   stands between one GHL location and another's).
 *
 *   COUPLING WORTH KNOWING: this kind shares `getStateSecret()` with every
 *   other kind here, so rotating `ONBOARD_STATE_SECRET` invalidates every
 *   in-flight embed token immediately, exactly like every other kind's
 *   in-flight state. Acceptable, deliberately unmitigated: these are
 *   15-minute tokens the embed page re-mints without the human even
 *   noticing (see `CrmEmbedClient.tsx`'s 401-retry handling) — nothing here
 *   is a multi-day credential a rotation would meaningfully disrupt.
 *
 * - `ghl-connect-link` / `ghl-connect-session` — the per-client connect-link
 *   feature (`src/lib/ghl-connect-link.ts`, docs/GHL-PROVIDER-CLIENT-MIGRATION.md
 *   — the 11-sub-account WAGHL migration). TWO KINDS, DELIBERATELY, NOT ONE:
 *
 *   `ghl-connect-link` is the long-lived (7-day) token Charlie mints in the
 *   owner panel and sends to a client — it is the bearer credential that
 *   goes out over WhatsApp/email, i.e. the thing that can leak. It carries
 *   `{ locationId, v }` (`v` = `GhlAccount.connectLinkVersion` at mint time —
 *   see that field's own JSDoc, src/lib/types.ts, for the revocation lever
 *   this enables).
 *
 *   `ghl-connect-session` is the short-lived (15-minute) token
 *   `POST /api/connect/session` mints ONCE the link token has verified and
 *   the account re-read has passed every check — it is what
 *   `ConnectLinkClient.tsx` actually holds and sends as
 *   `Authorization: Bearer` on every `/api/connect/whatsapp/*` call, exactly
 *   mirroring `ghl-embed`'s own token's role there.
 *
 *   WHY NOT ONE KIND FOR BOTH: a link token is the thing a stranger who
 *   captures the WhatsApp message or email holds — if it verified directly
 *   against the WhatsApp bridge routes (the session kind's actual job), then
 *   the 7-day-lived, easily-forwarded credential would BE the bridge
 *   credential, with no way to hand out a short-lived one instead. Splitting
 *   the two means the routes that actually reach the bridge
 *   (`src/app/api/connect/whatsapp/*`) only ever accept a `ghl-connect-session`
 *   token, and the ONE place a `ghl-connect-link` token is ever presented is
 *   `POST /api/connect/session`, which exchanges it for a session token after
 *   revalidating everything (expiry, version, account status) fresh. Same
 *   "kind pinning holds structurally" argument `verifyKindedState` already
 *   makes for every other pair of kinds here: a captured link token can never
 *   be replayed against a WhatsApp route, and a captured session token (which
 *   only ever exists in a ref in one browser tab's memory — never a URL,
 *   never a cookie, see `ConnectLinkClient.tsx`'s own header) can never be
 *   replayed against `/api/connect/session` to mint ANOTHER session, because
 *   that route only ever accepts the other kind.
 *
 *   Same secret/HMAC/TTL machinery as every other kind — rotating
 *   `ONBOARD_STATE_SECRET` invalidates every outstanding connect link and
 *   session at once, same accepted trade-off as `ghl-embed`'s note above,
 *   restated in this feature's own terms in `src/lib/ghl-connect-link.ts`'s
 *   header (an emergency lever, not a routine one — links take 30 seconds to
 *   reissue).
 *
 * - `ghl-claim` — a GoHighLevel sub-account's "claim this install" token
 *   (`src/lib/ghl-claim.ts`), carried as `/signup?claim=<token>` so a new
 *   account can take ownership of an unclaimed install. Carries
 *   `{ locationId }`, 30-minute TTL, dedicated ONBOARD_STATE_SECRET only.
 */
export type SignedStateKind = "signup" | "stripe-self" | "calendar-google" | "ghl-install" | "ghl-embed" | "ghl-connect-link" | "ghl-connect-session" | "ghl-claim";

interface KindedStatePayload {
  /** The purpose this state was minted for — checked on every verify. */
  k: SignedStateKind;
  /** Purpose-specific data. Never trusted for authorization on its own; see `verifySignupState`'s JSDoc. */
  d: Record<string, unknown>;
  /** Epoch ms this state expires at. */
  exp: number;
}

/** Sign a kind-tagged state. Same secret/HMAC/TTL as `signOnboardState`; see this section's header for why it is a separate shape. */
export function signKindedState(
  kind: SignedStateKind,
  data: Record<string, unknown>,
  ttlMs: number = STATE_TTL_MS
): string {
  const payload: KindedStatePayload = { k: kind, d: data, exp: Date.now() + ttlMs };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", getStateSecret()).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verify a kind-tagged state AND assert its kind. Returns the raw `d`
 * payload, or `null` on any tamper/format/expiry/wrong-kind failure —
 * callers must treat `null` as "invalid, show the friendly error", never
 * throw a 500 for a malformed state (a public endpoint gets malformed input
 * as a matter of course).
 */
export function verifyKindedState(kind: SignedStateKind, state: string): Record<string, unknown> | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;

  let expectedSignature: string;
  try {
    expectedSignature = createHmac("sha256", getStateSecret()).update(payloadB64).digest("base64url");
  } catch {
    return null; // no secret configured — fail closed, same as verifyOnboardState.
  }

  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }

  let payload: KindedStatePayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return null;
  }
  if (payload?.k !== kind) return null;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  if (typeof payload.d !== "object" || payload.d === null || Array.isArray(payload.d)) return null;

  return payload.d;
}

/**
 * Every reason `verifyKindedStateWithReason` can refuse a state — deliberately
 * a NARROWER set than "every way this could be wrong", because the whole
 * point of this function is that only ONE of these three is ever safe to
 * SHOW to the person holding the token (see that function's own JSDoc).
 */
export type KindedStateFailureReason = "invalid" | "expired" | "wrong_kind";

export type KindedStateResult =
  | { ok: true; d: Record<string, unknown> }
  | { ok: false; reason: KindedStateFailureReason };

/**
 * `verifyKindedState`, but able to say WHY a state was refused — built for
 * the connect-link feature (`src/lib/ghl-connect-link.ts`), which needs
 * `POST /api/connect/session` to answer "your link expired" (410, safe to
 * say — a signed token, even an expired one, already proves this app minted
 * it for a real location at some point) differently from "this isn't a
 * link this app ever issued" (403, generic — see that route's own header for
 * why an unknown/garbage token and a since-uninstalled location's token must
 * be indistinguishable).
 *
 * THE ORDERING IS THE SECURITY PROPERTY, NOT AN IMPLEMENTATION DETAIL:
 * expiry is checked ONLY AFTER the HMAC signature has already verified.
 * `expired` therefore leaks nothing an attacker didn't already have to prove
 * — reaching that branch requires having forged (impossible without the
 * secret) or been handed a payload this app genuinely signed at some point,
 * which is already "provenance", not a new fact. An attacker holding a
 * PURELY FORGED token (wrong signature, truncated, garbage) always gets
 * `invalid`, regardless of what expiry timestamp they tried to embed in
 * their forgery — there is no way to fish for "was this timestamp at least
 * shaped right" without first passing the signature check. Concretely: the
 * signature check happens before either the `k` (kind) or `exp` fields are
 * even inspected, so `wrong_kind` and `expired` are BOTH gated behind
 * "this was genuinely signed by us" — only their relative order (kind before
 * expiry, matching `verifyKindedState`'s own check order above) decides
 * which of the two a tampered-then-expired token reports, and that ordering
 * is deliberately kind-first: a genuinely expired token of the WRONG kind
 * reports `wrong_kind`, not `expired`, because "is this even the right kind
 * of thing" is the more fundamental question — see
 * `scripts/test/ghl-connect-link.test.ts`'s "tampered-then-expired reads
 * invalid, not expired" case for the regression this pins.
 *
 * Returns the same shape of `d` as `verifyKindedState` on success — this is
 * a strict superset (same checks, same secret, same HMAC construction), so
 * anywhere `verifyKindedState`'s plain `null` was enough this can be dropped
 * in without changing behaviour (see the thin-wrapper note on
 * `verifyKindedState` itself, just above, unmodified by this addition).
 */
export function verifyKindedStateWithReason(kind: SignedStateKind, state: string): KindedStateResult {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payloadB64, signature] = parts;

  let expectedSignature: string;
  try {
    expectedSignature = createHmac("sha256", getStateSecret()).update(payloadB64).digest("base64url");
  } catch {
    return { ok: false, reason: "invalid" }; // no secret configured — fail closed, same as verifyKindedState.
  }

  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return { ok: false, reason: "invalid" };
  }

  // Everything past this line has a verified signature — an attacker without
  // the secret can never reach here, so nothing below leaks anything new by
  // distinguishing its failure reason. See this function's own JSDoc,
  // "THE ORDERING IS THE SECURITY PROPERTY".
  let payload: KindedStatePayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (payload?.k !== kind) return { ok: false, reason: "wrong_kind" };
  if (typeof payload.exp !== "number") return { ok: false, reason: "invalid" };
  if (Date.now() > payload.exp) return { ok: false, reason: "expired" };
  if (typeof payload.d !== "object" || payload.d === null || Array.isArray(payload.d)) return { ok: false, reason: "invalid" };

  return { ok: true, d: payload.d };
}

