/**
 * Per-client GHL connect links (docs/GHL-PROVIDER-CLIENT-MIGRATION.md — the
 * 11-sub-account WAGHL migration). Charlie mints one link per GHL location in
 * the owner panel (`createGhlConnectLinkAction`,
 * src/app/owner/setup-links/actions.ts) and sends it to that client — the
 * client has no portal login, so this is the one thing standing between them
 * and a QR code that connects their business's WhatsApp.
 *
 * A CONNECT LINK IS A BEARER CREDENTIAL WITH PASSWORD-RESET-LINK SEVERITY.
 * Whoever opens `/connect/[token]` can link a phone to that client's
 * WhatsApp and then read and send as that business — the same "device-link
 * grant" severity every other QR surface in this codebase already carries
 * (`src/lib/ghl-embed.ts`'s header, `WhatsappConnectionPanel.tsx`'s header),
 * but with one difference that makes THIS surface materially riskier than
 * either of those: there is no SSO handshake proving the opener is anyone in
 * particular, and no owner session behind the button. Possession of the URL
 * IS the entire authorization. Every piece of user-facing copy this feature
 * writes (`ConnectLinkClient.tsx`, the owner panel's "Create connect link"
 * button) must say so out loud, in those terms — "treat this like a password
 * reset link" — not just enforce it in code.
 *
 * TWO KINDS, NOT ONE (see `src/lib/onboarding.ts`'s `SignedStateKind` JSDoc
 * for the full rationale, restated briefly here): `ghl-connect-link` is the
 * long-lived (7-day) token that travels over WhatsApp/email — the thing that
 * can leak. `ghl-connect-session` is the short-lived (15-minute) token
 * `POST /api/connect/session` exchanges it for, and the ONLY kind the actual
 * WhatsApp bridge routes (`src/app/api/connect/whatsapp/*`) ever accept. A
 * captured link token can never be replayed against a bridge route, and a
 * captured session token can never be replayed to mint another session —
 * kind-pinning holds structurally (`verifyKindedState`'s own contract), not
 * by convention.
 *
 * BOTH TOKEN KINDS CARRY `{ locationId, v }` — `v` is
 * `GhlAccount.connectLinkVersion` (src/lib/types.ts) AT MINT TIME, re-checked
 * against the CURRENT column value on every verify
 * (`src/app/api/connect/session/route.ts` for the link token,
 * `src/app/api/connect/guard.ts` for the session token — see that file's
 * header for why the session token is re-checked too, not just the link).
 * This is the entire revocation mechanism: bumping
 * `ghl_accounts.connect_link_version` (`revokeGhlConnectLinksAction`) makes
 * every token — link AND any session already exchanged from it — fail its
 * version check on the very next verify, for THIS location only. See
 * migration 0075's own header for why a version counter rather than a
 * boolean or timestamp.
 *
 * `ONBOARD_STATE_SECRET` ONLY — DELIBERATELY NOT `GHL_SSO_SHARED_SECRET`.
 * `isConnectLinkConfigured()` below checks exactly one env var. The GHL
 * Custom Page embed (`src/lib/ghl-embed.ts`) is dark for want of
 * `GHL_SSO_SHARED_SECRET` and the GHL-side Custom Page configuration that
 * currently isn't set up — this feature exists PRECISELY so the 11-client
 * migration does not have to wait on that. Coupling this feature's config
 * gate to the embed's would mean it inherits the embed's blocker for no
 * reason: nothing here decrypts a GHL SSO payload or needs GHL's Shared
 * Secret at all — the only cryptographic dependency is the SAME
 * `ONBOARD_STATE_SECRET` every other kinded signed state in this codebase
 * already uses.
 *
 * REFUSES `getStateSecret()`'s `CRON_SECRET` FALLBACK, RE-ASSERTED INSIDE
 * EVERY MINT AND VERIFY — copied belt-and-braces posture from
 * `mintGhlEmbedToken`/`verifyGhlEmbedToken` (src/lib/ghl-embed.ts), same
 * rationale verbatim: `CRON_SECRET` is an operational bearer token pasted
 * into `curl` commands in docs/RUNBOOK.md and carried on every scheduled cron
 * hit — a materially larger, more casual set of holders than anyone holding a
 * dedicated signing secret. Without this re-assertion, `signKindedState`/
 * `verifyKindedStateWithReason` would happily sign/verify under
 * `getStateSecret()`'s broader "`ONBOARD_STATE_SECRET` or `CRON_SECRET`"
 * fallback — meaning anyone holding only `CRON_SECRET` could mint a working
 * connect link for ANY installed location by hand, no owner-panel button, no
 * GHL involvement, no version check to pass (a hand-forged token can embed
 * whatever `v` it likes — the ONLY thing stopping that is never having been
 * able to sign it in the first place). `isConnectLinkConfigured()` gates
 * every caller BEFORE reaching a mint/verify call at all, so reaching either
 * function with the secret unset means that gate was skipped somewhere — the
 * re-assertion inside each function is the backstop for that bug class, not
 * the primary defence.
 *
 * ROTATING `ONBOARD_STATE_SECRET` KILLS EVERY OUTSTANDING CONNECT LINK AND
 * SESSION AT ONCE — for every location, not just one. This is an ACCEPTED,
 * DELIBERATE trade-off, the same one `ghl-embed`'s kind already lives with
 * (see `SignedStateKind`'s JSDoc, src/lib/onboarding.ts): it is also the
 * SAME secret signing signup links, staff invites, the Stripe Connect OAuth
 * state, and the GHL embed, so a rotation is a genuinely blunt, whole-app
 * lever — never reach for it to revoke ONE client's link when
 * `revokeGhlConnectLinksAction`'s per-location version bump does that
 * precisely. Reserve rotation for "the secret itself may have leaked".
 * Acceptable because links are cheap to reissue: a 7-day link takes Charlie
 * ~30 seconds to re-mint and re-send from the owner panel, so a rotation
 * mid-migration costs eleven clients a fresh link, not eleven support calls.
 */
import { signKindedState, verifyKindedStateWithReason } from "@/lib/signed-state";

// ---------------------------------------------------------------------------
// Config gate
// ---------------------------------------------------------------------------

/**
 * True iff `ONBOARD_STATE_SECRET` ITSELF is set — the exact same
 * "dedicated secret only, no `CRON_SECRET` fallback" posture
 * `hasEmbedStateSecret()` enforces for the GHL embed (src/lib/ghl-embed.ts),
 * for the identical reason (this file's own header). Deliberately does NOT
 * also check `GHL_SSO_SHARED_SECRET` — see this file's header, "ONBOARD_STATE_SECRET
 * ONLY".
 *
 * The single "is this switched on at all?" gate every connect-link surface
 * checks before doing anything: the owner panel's "Create connect link"
 * button, `/connect/[token]`'s server component (BEFORE it ever parses the
 * token), and every `/api/connect/*` route. Fail-closed: unset means every
 * one of those renders/returns its honest "not available on this deployment"
 * state and never attempts a mint or verify.
 *
 * VERIFIED: `ONBOARD_STATE_SECRET` is NOT currently set in production (only
 * `CRON_SECRET` is) — this feature therefore ships DARK and lights up the
 * moment Charlie sets it, exactly like the embed did before it. Every gate in
 * this feature must stay honest about that rather than silently working
 * under the `CRON_SECRET` fallback — see this file's header.
 */
export function isConnectLinkConfigured(): boolean {
  return Boolean(process.env.ONBOARD_STATE_SECRET);
}

// ---------------------------------------------------------------------------
// TTLs
// ---------------------------------------------------------------------------

/**
 * 7 days — long enough for Charlie to send a link and a client to actually
 * get to it (this is a real person on a real phone, not an automated
 * handshake with a 15-minute embed token's luxury of silently re-minting
 * itself). Short enough that a link sitting unopened in an old WhatsApp
 * thread eventually stops being a live credential on its own, without
 * Charlie having to remember to revoke it.
 */
export const CONNECT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ONE YEAR — for a link installed as a **custom menu link** in the client's
 * own GoHighLevel sidebar rather than sent to them once (Charlie, 4 Aug 2026:
 * "I click the menu link and connect").
 *
 * WHY A SECOND TTL EXISTS AT ALL. The two uses have opposite failure modes.
 * A link sent in a WhatsApp message SHOULD go stale — it sits in a thread
 * forever otherwise, and 7 days is the whole point. A menu link is the
 * opposite: it lives permanently in the sidebar and its entire job is being
 * there on the day the number drops, months later. A 7-day token in that slot
 * would greet the client with "this link has expired" at precisely the moment
 * they need it, which is worse than not offering the menu item at all.
 *
 * WHAT MAKES A YEAR ACCEPTABLE. The link is a bearer credential either way,
 * so the length alone isn't the control — revocation is. Bumping
 * `ghl_accounts.connect_link_version` kills every link for that one client
 * instantly (`Revoke all links`, one click, checked on EVERY request), and
 * that lever is unchanged here. What a menu link additionally has going for
 * it is WHERE it lives: inside that sub-account's own GHL, visible to that
 * client's own users — the exact set of people who should be able to link
 * that business's WhatsApp. It is not sitting in a forwarded chat thread.
 *
 * A year rather than "never": a credential with no expiry at all has no
 * backstop if a client leaves and their GHL sub-account lingers. A year means
 * the worst case self-heals within a year even if nobody remembers to revoke.
 */
export const CONNECT_LINK_MENU_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * 15 minutes — mirrors `EMBED_TOKEN_TTL_MS` (src/lib/ghl-embed.ts) exactly,
 * same reasoning: long enough to cover one `/connect/[token]` visit's worth
 * of connect/poll/logout calls without a mid-attempt refresh in the common
 * case, short enough that a session token is only ever good for a quarter of
 * an hour if it somehow leaked out of `ConnectLinkClient.tsx`'s in-memory ref
 * (never persisted anywhere — see that component's own header).
 */
export const CONNECT_SESSION_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared token shape + verify result
// ---------------------------------------------------------------------------

/** What both token kinds carry — see this file's header, "BOTH TOKEN KINDS CARRY". Index signature is what lets `isValidTokenData` below narrow FROM `verifyKindedStateWithReason`'s own `Record<string, unknown>` payload type — `signKindedState`'s `data` parameter is typed the same way, so this interface must stay assignable to it in both directions. */
interface ConnectTokenData {
  locationId: string;
  /** `GhlAccount.connectLinkVersion` at mint time — checked against the CURRENT column value on every verify. */
  v: number;
  [key: string]: unknown;
}

/**
 * Reason-aware verify result, shared by both `verifyConnectLinkToken` and
 * `verifyConnectSessionToken` — mirrors `KindedStateResult`
 * (src/lib/onboarding.ts) narrowed to this file's own payload shape.
 * `"invalid"`/`"expired"`/`"wrong_kind"` are `verifyKindedStateWithReason`'s
 * own three reasons; `"missing_state_secret"` is this file's own addition for
 * the "reached a verify call with the config gate somehow not honoured"
 * case — see `assertConfigured` below.
 */
export type ConnectTokenVerifyResult =
  | { ok: true; locationId: string; v: number }
  | { ok: false; reason: "invalid" | "expired" | "wrong_kind" | "missing_state_secret" };

function isValidTokenData(d: Record<string, unknown>): d is ConnectTokenData {
  return typeof d.locationId === "string" && d.locationId.length > 0 && typeof d.v === "number" && Number.isInteger(d.v) && d.v >= 0;
}

/**
 * Throws with a message naming exactly what's missing, mirroring
 * `mintGhlEmbedToken`'s "should be unreachable" throw — every caller of a
 * mint function must gate on `isConnectLinkConfigured()` first, so reaching
 * this is a bug, not an expected runtime state.
 */
function assertConfigured(callerName: string): void {
  if (!isConnectLinkConfigured()) {
    throw new Error(
      `${callerName} called with ONBOARD_STATE_SECRET unset — refusing to sign under getStateSecret()'s CRON_SECRET ` +
        "fallback (src/lib/ghl-connect-link.ts). This should be unreachable: every caller must gate on " +
        "isConnectLinkConfigured() first."
    );
  }
}

// ---------------------------------------------------------------------------
// Connect link token — the long-lived, bearer-credential-severity token that
// travels over WhatsApp/email. See this file's header for the full threat
// model.
// ---------------------------------------------------------------------------

/**
 * Mint a fresh connect-link token for one GHL location, at a specific
 * `connect_link_version`. Throws if `ONBOARD_STATE_SECRET` is unset — see
 * `assertConfigured`; this function's only caller
 * (`createGhlConnectLinkAction`, src/app/owner/setup-links/actions.ts)
 * already gates on `isConnectLinkConfigured()` with its own honest error
 * message before ever reaching this line.
 */
export function mintConnectLinkToken(
  locationId: string,
  version: number,
  /**
   * `"send"` (default) — a 7-day link Charlie messages to a client once.
   * `"menu"` — a 1-year link he installs as a custom menu link in that
   * client's GHL sidebar, where it has to still work months later on the day
   * their number drops. See `CONNECT_LINK_MENU_TTL_MS` for why the two
   * lifetimes are deliberately different, and why revocation rather than
   * expiry is what actually bounds a menu link.
   *
   * DEFAULTS TO THE SHORT ONE on purpose: a caller that forgets to say gets
   * the safer of the two, and the long-lived variant is only ever reachable
   * by asking for it explicitly.
   */
  lifetime: "send" | "menu" = "send"
): string {
  assertConfigured("mintConnectLinkToken");
  const ttl = lifetime === "menu" ? CONNECT_LINK_MENU_TTL_MS : CONNECT_LINK_TTL_MS;
  return signKindedState("ghl-connect-link", { locationId, v: version }, ttl);
}

/**
 * Verify + decode a connect-link token. Reason-aware — see
 * `POST /api/connect/session`'s own header for exactly how each reason maps
 * to an HTTP response; this function itself makes no HTTP decisions.
 *
 * Does NOT check the token's `v` against the account's CURRENT
 * `connect_link_version` — that requires a database read this pure function
 * deliberately does not perform (mirrors `verifyGhlEmbedToken`'s own
 * "verify the token, let the caller re-read the account" split). The caller
 * (`POST /api/connect/session`) does that comparison itself, AFTER this
 * verify succeeds and AFTER its own fresh `getGhlAccountByLocationId` read.
 */
export function verifyConnectLinkToken(token: string): ConnectTokenVerifyResult {
  if (!isConnectLinkConfigured()) return { ok: false, reason: "missing_state_secret" };
  const result = verifyKindedStateWithReason("ghl-connect-link", token);
  if (!result.ok) return result;
  if (!isValidTokenData(result.d)) return { ok: false, reason: "invalid" };
  return { ok: true, locationId: result.d.locationId, v: result.d.v };
}

// ---------------------------------------------------------------------------
// Connect session token — the short-lived token `ConnectLinkClient.tsx`
// actually holds and sends as `Authorization: Bearer` to
// `/api/connect/whatsapp/*`. Structurally identical machinery to the link
// token above, deliberately a DIFFERENT kind — see this file's header,
// "TWO KINDS, NOT ONE".
// ---------------------------------------------------------------------------

/**
 * Mint a fresh session token — called by `POST /api/connect/session` once a
 * link token has verified AND the fresh account re-read has passed every
 * check (missing/disabled/version-mismatch all refuse before this line).
 * Throws if `ONBOARD_STATE_SECRET` is unset, same posture as
 * `mintConnectLinkToken`.
 */
export function mintConnectSessionToken(locationId: string, version: number): string {
  assertConfigured("mintConnectSessionToken");
  return signKindedState("ghl-connect-session", { locationId, v: version }, CONNECT_SESSION_TTL_MS);
}

/**
 * Verify + decode a session token — called by `authorizeConnectRequest`
 * (`src/app/api/connect/guard.ts`) on every `/api/connect/whatsapp/*` call.
 * Same "does not itself re-check `v` against the database" split as
 * `verifyConnectLinkToken` — the guard does that comparison itself after its
 * own fresh account re-read, which is also what makes a mid-session "Revoke
 * all links" click take effect within one poll tick instead of waiting out
 * the full 15-minute session TTL (mirrors `authorizeGhlEmbedRequest`'s own
 * per-call re-read rationale, src/app/api/crm/embed/guard.ts).
 */
export function verifyConnectSessionToken(token: string): ConnectTokenVerifyResult {
  if (!isConnectLinkConfigured()) return { ok: false, reason: "missing_state_secret" };
  const result = verifyKindedStateWithReason("ghl-connect-session", token);
  if (!result.ok) return result;
  if (!isValidTokenData(result.d)) return { ok: false, reason: "invalid" };
  return { ok: true, locationId: result.d.locationId, v: result.d.v };
}
