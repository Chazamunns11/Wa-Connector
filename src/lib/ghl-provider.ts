/**
 * GHL custom conversation provider, Phase 2 — outbound webhook -> verify ->
 * send -> status (docs/GHL-PROVIDER-PLAN.md, "the seven decisions" §D3/D6/D7).
 * This is the domain logic; deps-injected and unit-testable, mirroring
 * `src/lib/whatsapp-replies.ts`'s `processInboundWhatsappReplies` shape —
 * repo-only where possible, with the two genuinely external calls (the
 * WhatsApp bridge send, the GHL status PUT) and the token refresh call
 * injected via `GhlProviderDeps` so `scripts/test/ghl.test.ts` can exercise
 * every branch below with fakes, never a real bridge or a real GHL account.
 *
 * TWO ENTRY POINTS, ONE MODULE:
 *   - `handleProviderOutboundMessage` — the Delivery URL's payload handler
 *     (`POST /api/webhooks/crm-provider`, called once per signature-verified
 *     webhook). Resolves the location, records the intake-ledger row,
 *     attempts the bridge send, and — for anything the webhook itself can
 *     resolve synchronously (a refusal, or an immediate bridge accept) —
 *     reports or defers the GHL status inline.
 *   - `drainGhlOutboundStatuses` — the async follow-up (`POST
 *     /api/webhooks/crm-outbound-status` poke + the hourly reminders cron,
 *     same "poke is latency, cron is the backstop" contract as
 *     `processInboundWhatsappReplies`). Retries a bridge-unreachable
 *     `pending_send` row, and resolves an `accepted` row's eventual
 *     `sent`/`failed`/`not_on_whatsapp` outcome by reading `whatsapp_messages`
 *     directly (same database, no bridge HTTP call needed — plan's D3).
 *
 * THE STATUS TABLE THIS MODULE IMPLEMENTS EXACTLY (plan's D3):
 *
 *   | Moment                                   | Bridge state | GHL PUT |
 *   |-------------------------------------------|--------------|---------|
 *   | webhook, bridge 202 accepted              | accepted     | none    |
 *   | webhook, bridge 200 replay (dedupe)        | whatever     | none inline (drain reports it) |
 *   | webhook, terminal refusal (phone/text/     | no row (or refused) | failed, inline, fixed reason |
 *   |   session_not_connected/daily_cap/reauth)  |              |         |
 *   | webhook, transient bridge failure          | none yet     | none — row stays pending_send, drain retries (<=5), then failed |
 *   | drain, bridge ledger resolves to 'sent'    | sent         | delivered |
 *   | drain, bridge ledger resolves to 'failed'  | failed       | failed + the ledger's own fixed error |
 *   | drain, bridge ledger 'not_on_whatsapp'     | not_on_whatsapp | failed + "recipient has no WhatsApp account" |
 *
 * "Transient bridge failure" (adversarial-review finding 5, fixed) is a
 * DENY-list, not an allow-list: `unreachable`/`lease_unavailable` plus
 * anything NOT in `TERMINAL_BRIDGE_FAILURE_CODES` below — including
 * `internal` (a Railway edge 502/503 HTML page while the container boots)
 * and `unauthorized` (a bridge-secret rotation window), and any code a
 * future bridge version introduces. Only genuinely permanent-for-this-
 * message codes (daily cap, session not connected, an idempotency key
 * conflict, an unparseable phone/text, the bridge unconfigured) are
 * terminal — see `TERMINAL_BRIDGE_FAILURE_CODES`'s own comment.
 *
 * ALWAYS-200 CONTRACT (D3): this module never throws into its callers — both
 * entry points catch every repo/bridge/GHL call (adversarial-review finding
 * 6 — `handleProviderOutboundMessage` is now wrapped in two try/catch blocks,
 * before and after the intake row is recorded; `drainGhlOutboundStatuses`'s
 * batch join is now inside its own try/catch too), mirroring
 * `processInboundWhatsappReplies`'s per-row isolation. The webhook route
 * returns 200 to GHL for every outcome `handleProviderOutboundMessage` can
 * produce once the signature verified, EXCEPT `{ kind: "error", recorded:
 * false }` — an unexpected failure before any row was written, where the
 * route deliberately returns a non-200 instead (see that outcome variant's
 * own JSDoc for why). For everything else — GHL's own retry semantics are
 * unknown and deliberately never depended on (plan §0/§6 risk 6): a
 * redelivered webhook or a drain retry both resolve through the SAME
 * idempotency key, which is either the bridge's replay path (a second send
 * is structurally impossible) or this module's own `(location_id,
 * ghl_message_id)` dedupe (`recordGhlOutboundMessage` returns the EXISTING
 * row, `isNew: false`, and this module does nothing further).
 *
 * FIXED REASON STRINGS ONLY (hard constraint, restated): every string this
 * module ever passes to `updateGhlMessageStatus`'s `errorMessage` or writes
 * to `report_error` is one of the constants below or a bridge-ledger `error`
 * column value the bridge itself already guarantees is a fixed string (its
 * own hard rule 1 — see `services/whatsapp-bridge/src/sessions.ts`'s
 * `mapSendErrorReason`/`disconnectReasonLabel`). No raw upstream error body
 * (Stripe-style, GHL-style, or bridge-`message`-string) is ever forwarded
 * verbatim — `src/lib/ghl.ts`'s `updateGhlMessageStatus` sanitises its own
 * failure strings to the same standard (adversarial-review finding 13).
 *
 * THE pending_text ADAPTATION (Phase 2, flagged in the go-live report): 0069
 * committed to "no message body stored" for `ghl_outbound_messages`, but the
 * plan's own D3 requires the drain to retry a bridge-unreachable send under
 * the SAME idempotency key with the SAME text (resending different text under
 * that key would be ACCEPTED as the real content — the bridge's own ledger
 * has no row yet for a send that never reached it). `pending_text`
 * (0070_ghl_outbound_pending_text.sql) closes that gap: populated only while
 * `send_state = 'pending_send'`, cleared the instant a row leaves that state
 * — see that migration's header for the full argument.
 */
import {
  buildOutboundText,
  deriveAttachmentIdempotencyKey,
  deriveIdempotencyKey,
  deriveMediaFallbackIdempotencyKey,
  isMediaOutboundEnabled,
  refreshGhlToken,
  updateGhlMessageStatus,
  type RefreshGhlTokenResult,
} from "@/lib/ghl";
import { brandConfig } from "@/lib/brand-config";
import { sendingGate } from "@/lib/billing/gate";
import { normalisePhoneE164 } from "@/lib/phone";
import {
  getWhatsappBridgeSession,
  sendWhatsappAttachment,
  sendWhatsappMessage,
  type BridgeSendResult,
  type BridgeSessionResult,
  type SendWhatsappAttachmentInput,
  type SendWhatsappInput,
} from "@/lib/whatsapp-bridge";
import type { GhlRepository } from "@/lib/data";
import type { GhlAccount, GhlOutboundAttachment, GhlOutboundAttachmentDraft, GhlOutboundMessage } from "@/lib/types";

/** Repo slice this module needs — every method it touches is already on `GhlRepository` (Phase 2's extension of Phase 1's interface — see that Pick list's own comment, src/lib/data/index.ts). Both entry points are only ever driven via `webhookRepo` (the webhook route, the poke route, the reminders cron — none carry a user session). */
export type GhlProviderRepo = Pick<
  GhlRepository,
  | "getGhlAccountByLocationId"
  | "getAccountById"
  | "recordGhlOutboundMessage"
  | "updateGhlOutboundSendState"
  | "listUnreportedGhlOutboundMessages"
  | "getWhatsappMessagesByTenantKeys"
  | "markGhlOutboundReported"
  | "claimGhlTokenRefresh"
  | "saveGhlTokens"
  | "markGhlNeedsReauth"
  // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — outbound
  // attachment parts (`handleMediaSplitOutbound`/`drainMultipartRow` below).
  | "recordGhlOutboundAttachments"
  | "listGhlOutboundAttachmentsForMessages"
  | "updateGhlOutboundAttachmentSendState"
>;

/**
 * The narrow slice `resolveGhlAccessToken` actually touches — split out from
 * `GhlProviderRepo` (Phase 3, `src/lib/ghl-inbound.ts`) so that module's own
 * repo type can satisfy this without also declaring every OUTBOUND-only
 * method (`recordGhlOutboundMessage`, `listUnreportedGhlOutboundMessages`,
 * …) it never calls. `GhlProviderRepo` already contains all four of these,
 * so every existing call site below keeps typechecking unchanged.
 */
export type GhlTokenRefreshRepo = Pick<GhlRepository, "getGhlAccountByLocationId" | "claimGhlTokenRefresh" | "saveGhlTokens" | "markGhlNeedsReauth">;

/**
 * The Delivery URL's parsed payload (plan §0's confirmed field list for
 * `type: "SMS"`). Loosely typed on purpose — this is untrusted JSON off the
 * wire (Ed25519-verified, never schema-validated by GHL) — every field is
 * read defensively below rather than trusted to be present/well-typed.
 */
export interface GhlProviderOutboundPayload {
  type?: unknown;
  locationId?: unknown;
  messageId?: unknown;
  contactId?: unknown;
  phone?: unknown;
  message?: unknown;
  attachments?: unknown;
  userId?: unknown;
}

/**
 * The two real network calls, the token refresh, and the Slack alert,
 * injected so tests can exercise every bridge/GHL outcome deterministically
 * with no network (hard constraint). Real callers use the exported
 * `defaultGhlProviderDeps` — no caller in this codebase passes a third
 * argument except `scripts/test/ghl.test.ts`.
 */
export interface GhlProviderDeps {
  sendWhatsapp: (input: SendWhatsappInput) => Promise<BridgeSendResult>;
  /** Media plan (docs/MEDIA-PLAN.md §5.3) — the attachment-part counterpart to `sendWhatsapp`, only ever called from `handleMediaSplitOutbound`/`resolveAttachmentPartOutcome` (both gated behind `isMediaOutboundEnabled()`). */
  sendAttachment: (input: SendWhatsappAttachmentInput) => Promise<BridgeSendResult>;
  /**
   * Media plan (docs/MEDIA-PLAN.md §5.6, decision O3) — the accept-time
   * budget check's ONLY source of "how much of today's cap is left": the
   * bridge's own live session snapshot (`sentToday`/`dailyCap`/
   * `queueLength`), the same numbers `GET /sessions/:coachId` already
   * returns. This is a best-effort, portal-side FRONT-LOAD of the refusal —
   * the bridge's own per-part accept-time reservation
   * (services/whatsapp-bridge/src/sessions.ts's `acceptAndEnqueue`) remains
   * the authoritative, race-proof enforcement; this dep exists purely to
   * avoid dispatching PART of a multipart message before discovering later
   * parts won't fit (plan: "the portal refuses the whole message up front
   * ... rather than sending half now and half after midnight"). See
   * `hasSufficientOutboundBudget`'s own JSDoc for what happens when this
   * call itself fails.
   */
  getSession: (coachId: string) => Promise<BridgeSessionResult>;
  updateStatus: (
    accessToken: string,
    messageId: string,
    status: "delivered" | "failed" | "pending" | "read",
    errorMessage?: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  refreshToken: (refreshToken: string) => Promise<RefreshGhlTokenResult>;
  /** How long the loser of `claimGhlTokenRefresh` waits before re-reading (plan's D2 — "sleep ~1s"). Overridable so tests don't actually wait a second. */
  refreshWaitMs: number;
  /**
   * Fire-and-forget Slack alert (an unknown locationId, or a location
   * dropping into `needs_reauth`). Injected — not a hard top-level import of
   * `@/lib/slack` — for a genuinely test-infrastructure reason, not a design
   * one: `src/lib/slack.ts` itself does `import { repo } from "@/lib/data"`
   * for its OTHER exports (`postWeeklySummary`), and `@/lib/data/index.ts`'s
   * live-mode branch pulls in `next/headers` — neither resolvable under
   * plain `node --test` outside the Next.js runtime. `defaultGhlProviderDeps`
   * below reaches the real `notifyText` via a runtime `import()`, so
   * `@/lib/slack` is only ever loaded if this is actually called — never at
   * module-parse time, and never during a test that supplies its own fake.
   */
  notify: (text: string) => void;
}

export const defaultGhlProviderDeps: GhlProviderDeps = {
  sendWhatsapp: sendWhatsappMessage,
  sendAttachment: sendWhatsappAttachment,
  getSession: getWhatsappBridgeSession,
  updateStatus: updateGhlMessageStatus,
  refreshToken: refreshGhlToken,
  refreshWaitMs: 1000,
  notify: (text) => {
    void import("@/lib/slack").then((m) => m.notifyText(text));
  },
};

/** The narrow slice `resolveGhlAccessToken` actually touches — see `GhlTokenRefreshRepo`'s identical rationale, just for `deps` instead of `repo`. `GhlProviderDeps` already contains all three, so `defaultGhlProviderDeps` (and every existing call site) keeps typechecking unchanged. */
export type GhlTokenRefreshDeps = Pick<GhlProviderDeps, "refreshToken" | "refreshWaitMs" | "notify">;

/** How stale `accessTokenExpiresAt` may be before a send/status call proactively refreshes rather than risking a 401 mid-flight. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** Plan's D3: "bounded at 5 attempts then reports failed." */
const PENDING_SEND_MAX_ATTEMPTS = 5;
/** Plan's D3/`processInboundWhatsappReplies`'s `DRAIN_BATCH_CAP` convention. */
const DRAIN_BATCH_CAP = 50;

/**
 * Final cross-phase review, finding 5 — a wall-clock budget for
 * `drainGhlOutboundStatuses`. Worst case for the whole 50-row batch (two
 * hanging 5s calls per row — a bridge send/PUT status each) is
 * 250-500 seconds with no bound at all, which is what let a slow GHL/bridge
 * event starve the reminders cron's OTHER work (reminder emails,
 * `processDueSequenceRuns`) sharing that same route/function invocation —
 * see `src/app/api/cron/reminders/route.ts`'s own header for the
 * reordering fix this pairs with. Unlike `drainGhlInboundReplies`
 * (src/lib/ghl-inbound.ts), this drain deliberately has no per-endpoint
 * consecutive-failure circuit breaker (its side effects are all idempotent —
 * see this file's header — so there was never a correctness reason to add
 * one), which makes a time budget the LIGHTER fix here: no new failure
 * counters, just "stop starting new rows once this pass has run long
 * enough." ~25s mirrors the inbound drain's own breaker bound (5 consecutive
 * failures × up to a 5s timeout each) — the same order of magnitude, kept
 * consistent across the two drains rather than picked independently. Rows
 * not reached this pass are simply left unreported/still-pending — they
 * remain valid candidates and are picked up again on the very next pass
 * (poke or cron), no special handling needed.
 */
const DRAIN_TIME_BUDGET_MS = 25_000;

// ---------------------------------------------------------------------------
// Fixed reason strings (hard constraint — see file header). Every one of
// these, and only these (plus a bridge-ledger `error` already fixed by the
// bridge itself), can ever reach GHL's Update Message Status endpoint or
// `ghl_outbound_messages.report_error`.
// ---------------------------------------------------------------------------

/** Plan's D5, verbatim. */
const REASON_INVALID_PHONE = "phone number could not be read as E.164";
const REASON_EMPTY_MESSAGE = "message had no text and no attachments to send";
/** Plan's D6, verbatim. */
const REASON_TOO_LONG = "message with attachments too long for WhatsApp bridge";
const REASON_NEEDS_REAUTH = `GHL provider needs re-authorising — reconnect from your ${brandConfig().name} dashboard`;
const REASON_DISABLED = "this GHL WhatsApp number has been disabled";
const REASON_NOT_CONNECTED = `WhatsApp isn't connected for this number yet — connect it from your ${brandConfig().name} dashboard first`;
/** Plan's D7, verbatim (including the cap value — this is the bridge's own documented default, restated here as a fixed string rather than parsed out of the bridge's response text). */
const REASON_CAP_REACHED = "daily WhatsApp cap (150) reached for this number — resumes at UTC midnight";
const REASON_IDEMPOTENCY_CONFLICT = "message could not be sent — a conflicting send already used this message id";
const REASON_BRIDGE_UNCONFIGURED = "WhatsApp bridge is not configured on this deployment";
const REASON_BRIDGE_REFUSED = "WhatsApp bridge could not accept this message";
/** Plan's D3, verbatim — the bounded-retry give-up reason. */
const REASON_BRIDGE_UNREACHABLE_EXHAUSTED = "could not reach WhatsApp bridge";
/** Plan's D3, verbatim. */
const REASON_NOT_ON_WHATSAPP = "recipient has no WhatsApp account";
const REASON_SENT_FAILED = "WhatsApp delivery failed";
/** Used only defensively — see `drainGhlOutboundStatuses`'s `'refused'` branch. */
const REASON_GENERIC_REFUSED = "message could not be sent";
const REASON_NO_ACCESS_TOKEN = "no valid GHL access token available to report status";
/** Media plan (docs/MEDIA-PLAN.md §5.4/§5.3) — a bridge-side attachment-specific terminal refusal (the bridge's own `invalid_attachment` code — a malformed url/fileName that somehow reached the bridge despite the portal's own checks). */
const REASON_INVALID_ATTACHMENT = "attachment could not be sent — invalid attachment";
/** Media plan (docs/MEDIA-PLAN.md §8) — the bridge's `WA_MEDIA_OUTBOUND_ENABLED` is off even though the PORTAL's own `isMediaOutboundEnabled()` is on (the two flags live on separate deployments — see that function's JSDoc). */
const REASON_MEDIA_DISABLED_ON_BRIDGE = "attachment sends are not enabled on this WhatsApp bridge yet";
/**
 * Media plan (docs/MEDIA-PLAN.md §5.7, decision O4) — verbatim wording from
 * the plan. Reported when SOME but not all of a multipart message's parts
 * failed — the true per-part detail stays queryable in `whatsapp_messages`/
 * `ghl_outbound_attachments`; GHL's own status field is binary
 * delivered/failed, so partial truth goes in this one fixed sentence rather
 * than an enumerated list of which attachment failed (never any upstream
 * error text — same fixed-reason-strings-only rule as every other constant
 * in this file).
 */
const REASON_PARTIAL_DELIVERY = "message partially delivered on WhatsApp — some attachments could not be sent";
/**
 * Media plan internal sentinel — NEVER reported to GHL, NEVER surfaced
 * outside this module. Stamped as `ghl_outbound_messages.refusal_reason`
 * (piggybacking the existing `'refused'` state) for a multipart message that
 * has NO text (an attachments-only GHL message) — see
 * `resolveTextPartOutcome`'s JSDoc for why a genuine third "not applicable"
 * state is encoded this way rather than adding a new DB column/CHECK value
 * to a migration (0069/0073) already written and NOT to be altered.
 */
const TEXT_PART_NOT_APPLICABLE = "media plan internal: no text part — attachments only, never reported to GHL";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every non-transient bridge failure code mapped to a fixed, human-readable reason — never the bridge's own `message` text (which can embed a recipient's stored phone number, e.g. `idempotency_conflict`'s message — see `services/whatsapp-bridge/src/server.ts`). */
function mapBridgeFailureReason(code: string): string {
  switch (code) {
    case "daily_cap_reached":
      return REASON_CAP_REACHED;
    case "session_not_connected":
      return REASON_NOT_CONNECTED;
    case "idempotency_conflict":
      return REASON_IDEMPOTENCY_CONFLICT;
    case "invalid_phone":
      return REASON_INVALID_PHONE;
    case "invalid_text":
      return REASON_TOO_LONG;
    case "unconfigured":
      return REASON_BRIDGE_UNCONFIGURED;
    // Media plan (docs/MEDIA-PLAN.md §5.3/§5.4) — attachment-part-specific
    // terminal codes, same "permanent for THIS part, retrying is pointless"
    // classification as every other case above.
    case "invalid_attachment":
      return REASON_INVALID_ATTACHMENT;
    case "media_outbound_disabled":
      return REASON_MEDIA_DISABLED_ON_BRIDGE;
    default:
      return REASON_BRIDGE_REFUSED;
  }
}

/**
 * Bridge failure codes that are genuinely PERMANENT for this exact message —
 * retrying would fail identically every time, so these (and only these) are
 * reported as an immediate terminal refusal. Adversarial-review finding 5:
 * the previous version of this module did the opposite — an ALLOW-list of
 * transient codes (`unreachable`/`lease_unavailable`) with everything else,
 * including `internal` (any 2xx/non-2xx body that doesn't match the bridge's
 * own error shape — e.g. a Railway edge 502/503 HTML page while the
 * container boots or crash-loops) and `unauthorized` (a bridge-secret
 * rotation window), treated as terminal. Both of those are transient
 * INFRASTRUCTURE conditions, not something about this message or recipient —
 * classifying them as terminal permanently failed a message that would have
 * gone through moments later. Flipping to a DENY-list of terminal codes
 * means an unknown code a future bridge version introduces defaults to
 * transient too, bounded by the drain's existing `PENDING_SEND_MAX_ATTEMPTS`
 * retry cap rather than a single unlucky blip failing the send outright.
 */
const TERMINAL_BRIDGE_FAILURE_CODES = new Set<string>([
  "daily_cap_reached",
  "session_not_connected",
  "idempotency_conflict",
  "invalid_phone",
  "invalid_text",
  "invalid_idempotency_key",
  "invalid_coach_id",
  "invalid_body",
  "unconfigured",
  "not_found",
  // Media plan (docs/MEDIA-PLAN.md §5.3/§5.4) — attachment-part-specific.
  "invalid_attachment",
  "media_outbound_disabled",
]);

function isTransientBridgeFailure(code: string): boolean {
  return !TERMINAL_BRIDGE_FAILURE_CODES.has(code);
}

/**
 * On-demand token refresh with the atomic single-flight claim (plan's D2).
 * Returns `null` when no usable access token is available right now — the
 * caller must not attempt a GHL API call in that case. Never throws.
 *
 * EXPORTED (Phase 3, `src/lib/ghl-inbound.ts`'s plan §Q5 "Token refresh
 * fails" row) — this is now the ONE single-flight refresh implementation
 * shared by both the outbound drain above and the inbound drain, rather than
 * a second copy: the atomic claim (`claimGhlTokenRefresh`) only protects a
 * refresh token from being spent twice CONCURRENTLY if every caller goes
 * through the same code path.
 *
 * `account.status === 'disabled'` short-circuits to `null` immediately, with
 * NO claim attempt and NO refresh call, regardless of token freshness — an
 * operator turned this location off deliberately; nothing here should ever
 * make another GHL call on its behalf, even a status report.
 *
 * `account.status === 'needs_reauth'` (adversarial-review finding 3, fixed):
 * a REFRESH is never attempted (the refresh token is the thing GHL already
 * rejected — retrying it would just fail again, or worse, be a second use of
 * a token GHL may have partially rotated), but a STILL-UNEXPIRED
 * `access_token` IS used. GHL access tokens live ~24h independently of the
 * refresh token; a refresh failure does not retroactively invalidate the
 * current access token. Treating `needs_reauth` as "no token, ever" (the
 * previous behaviour) meant the plan's D3 "tenant needs_reauth -> failed
 * immediately, inline" design — and §6 risk 3's "the inline failed status
 * makes it visible inside GHL itself" mitigation — were both silently
 * unreachable: the inline PUT could never actually be attempted, so the
 * refusal was invisible in GHL until the account happened to be reconnected.
 *
 * FINAL CROSS-PHASE REVIEW, FINDING 1 — the refresh call below now returns a
 * discriminated `RefreshGhlTokenResult` (`src/lib/ghl.ts`), not a bare
 * `GhlTokens | null`: only `kind: "invalid_grant"` marks the account
 * `needs_reauth`. `kind: "transient"` (a timeout, a network error, a 429/5xx,
 * an unparseable response) leaves `account.status` completely untouched and
 * returns `null` for THIS call only — the very next send/drain pass calls
 * this function again from scratch and gets a fresh chance to refresh
 * (self-healing, no manual reinstall). Getting this backwards was the exact
 * bug: one slow response from GHL's token endpoint used to permanently
 * strand a location's working refresh token behind a `needs_reauth` flag no
 * automated path ever clears.
 *
 * FINDING 6 (this same review) — the CLAIM-LOSER branch below used to return
 * `fresh.accessToken` the instant `fresh.status === "active"`, with no check
 * that the token it just read back is actually the FRESH one the winner
 * wrote (the winner's own refresh — up to a 5s fetch — may not have landed
 * by the time the loser's `refreshWaitMs` (~1s) sleep elapses). That handed
 * callers a possibly-still-expired token as if it were good. The loser now
 * runs the SAME freshness check (`isAccessTokenFresh`) the top of this
 * function already uses for the caller's own initial read — if the re-read
 * token isn't verifiably fresh yet, this returns `null` (retry on the next
 * call) rather than a token that might immediately 401.
 */
function isAccessTokenFresh(accessToken: string | null, accessTokenExpiresAt: string | null): boolean {
  const expiresAtMs = accessTokenExpiresAt ? Date.parse(accessTokenExpiresAt) : 0;
  return Boolean(accessToken) && expiresAtMs - Date.now() > TOKEN_EXPIRY_SKEW_MS;
}

export async function resolveGhlAccessToken(repo: GhlTokenRefreshRepo, deps: GhlTokenRefreshDeps, account: GhlAccount): Promise<string | null> {
  if (account.status === "disabled") return null;

  if (isAccessTokenFresh(account.accessToken, account.accessTokenExpiresAt)) return account.accessToken;

  if (account.status === "needs_reauth") {
    // No usable token, and — deliberately — no refresh attempt: see this
    // function's header. The caller (reportGhlOutcome) leaves the row
    // unreported; the refusal reason itself is persisted separately
    // (`GhlOutboundMessage.refusalReason`) so a later pass can still report
    // the TRUE reason once the account reconnects, rather than a generic
    // fallback.
    return null;
  }

  const won = await repo.claimGhlTokenRefresh(account.locationId);
  if (!won) {
    // Someone else is refreshing right now — sleep briefly and read what they
    // wrote (plan's D2). Finding 6: only return the re-read token if it is
    // ACTUALLY fresh — the winner's own refresh may still be in flight when
    // this wakes up, and returning a stale token here would hand the caller
    // something that can 401 immediately.
    await sleep(deps.refreshWaitMs);
    const fresh = await repo.getGhlAccountByLocationId(account.locationId);
    if (!fresh || fresh.status !== "active") return null;
    return isAccessTokenFresh(fresh.accessToken, fresh.accessTokenExpiresAt) ? fresh.accessToken : null;
  }

  const refreshed = await deps.refreshToken(account.refreshToken);
  if (!refreshed.ok) {
    if (refreshed.kind === "invalid_grant") {
      // Finding 1 — GHL definitively rejected the refresh token itself. This
      // is the ONLY case that marks the account needs_reauth.
      await repo.markGhlNeedsReauth(account.locationId, "GHL rejected the refresh token");
      deps.notify(
        `GHL location ${account.locationId} (${account.label}) needs re-authorising — WhatsApp sending is paused until it's reconnected from your ${brandConfig().name} dashboard.`
      );
    } else {
      // Transient — leave `account.status` untouched (still 'active'); the
      // existing retry machinery (every subsequent call to this function)
      // tries the refresh again. No DB write, no Slack alert — a single slow
      // token-endpoint response must never look like a permanent failure.
      console.error(`[ghl-provider] token refresh for location ${account.locationId} failed transiently — leaving status untouched, will retry on the next call`);
    }
    return null;
  }
  const tokens = refreshed.tokens;
  // `refreshGhlToken` already guarantees a non-null refreshToken when its
  // result is `ok` (carries the old one through if GHL omitted a new one) —
  // this fallback is belt-and-braces, re-pinned at this module's own
  // boundary (see scripts/test/ghl.test.ts's token-refresh suite).
  await repo.saveGhlTokens(account.locationId, {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
    refreshToken: tokens.refreshToken ?? account.refreshToken,
  });
  return tokens.accessToken;
}

/**
 * Report one status outcome to GHL, then stamp the ledger row accordingly.
 * Shared by the webhook's inline refusal path and the drain's own
 * resolution/give-up paths — see `Repository.markGhlOutboundReported`'s
 * Phase 2 JSDoc for the "leave unreported, stamp report_error" contract this
 * relies on when the PUT itself fails.
 */
async function reportGhlOutcome(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  account: GhlAccount | null,
  row: GhlOutboundMessage,
  status: "delivered" | "failed",
  reason: string | null
): Promise<"reported" | "unreported"> {
  const accessToken = account ? await resolveGhlAccessToken(repo, deps, account) : null;
  if (!accessToken) {
    // No usable credential right now (needs_reauth, disabled, or an unknown
    // account) — nothing was attempted against GHL, but report_error is
    // still stamped (diagnosable from the owner panel) and the row is left
    // unreported so a future pass (once reconnected) retries automatically.
    await repo.markGhlOutboundReported(row.id, { reportedStatus: null, reportError: REASON_NO_ACCESS_TOKEN });
    return "unreported";
  }
  const put = await deps.updateStatus(accessToken, row.ghlMessageId, status, reason ?? undefined);
  if (put.ok) {
    await repo.markGhlOutboundReported(row.id, { reportedStatus: status, reportError: null });
    return "reported";
  }
  await repo.markGhlOutboundReported(row.id, { reportedStatus: null, reportError: put.error });
  return "unreported";
}

export type HandleProviderOutboundOutcome =
  | { kind: "ignored"; reason: "non_sms_type" | "malformed_payload" | "unknown_location" }
  | { kind: "duplicate" }
  | { kind: "accepted" }
  | { kind: "pending_retry" }
  | { kind: "refused"; reason: string }
  /**
   * Adversarial-review finding 6: an unexpected repo failure (a transient
   * Supabase error, most likely) rather than a normal outcome of the GHL/
   * bridge decision tree. `recorded` tells the caller (the webhook route)
   * whether `ghl_outbound_messages` already has a row for this message:
   *   - `false` — nothing was written. The webhook route returns a non-200
   *     so GHL's own retry (unknown semantics, but retrying is strictly
   *     better than nothing when there is genuinely no record of this
   *     message anywhere in our system) has a chance to land once the
   *     transient condition clears.
   *   - `true` — the intake row exists; this module OWNS retrying it from
   *     here (the drain will pick up a still-unreported/still-pending_send
   *     row on its next pass regardless of what GHL does), so the route
   *     returns 200 — the plan's D3 "we own retries, never depend on GHL's"
   *     contract, restated for the one case where a THIRD outcome (neither
   *     a clean success nor a clean refusal) is possible.
   */
  | { kind: "error"; recorded: boolean };

/**
 * The Delivery URL's payload handler — see this file's header for the full
 * decision table. NEVER THROWS (adversarial-review finding 6 — this used to
 * be aspirational only; every repo call below is now inside one of the two
 * try/catch blocks so an unexpected failure always resolves to an `"error"`
 * outcome instead of an uncaught rejection): every outcome maps to the
 * webhook route returning 200, EXCEPT `{ kind: "error", recorded: false }` —
 * see that variant's own JSDoc — which the route itself is the only thing
 * that returns non-200 for, alongside a failed signature check or
 * unparseable JSON (both already handled before this function is ever
 * called).
 */
export async function handleProviderOutboundMessage(
  repo: GhlProviderRepo,
  payload: GhlProviderOutboundPayload,
  deps: GhlProviderDeps = defaultGhlProviderDeps
): Promise<HandleProviderOutboundOutcome> {
  if (payload.type !== "SMS") {
    // Non-SMS webhook types (e.g. a future Call/Voicemail provider event) —
    // 200 ignored, no row, no bridge call (plan's D3).
    return { kind: "ignored", reason: "non_sms_type" };
  }

  const locationId = typeof payload.locationId === "string" ? payload.locationId : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const contactId = typeof payload.contactId === "string" ? payload.contactId : "";
  if (!locationId || !messageId || !contactId) {
    console.error("[ghl-provider] malformed SMS webhook payload (missing locationId/messageId/contactId) — ignored");
    return { kind: "ignored", reason: "malformed_payload" };
  }

  // PHASE A — nothing below this point has written a row yet. Any failure
  // here means NO record of this message exists anywhere in our system.
  let account: GhlAccount | null;
  let row: GhlOutboundMessage;
  let isNew: boolean;
  let toPhone: string | null;
  let textResult: ReturnType<typeof buildOutboundText>;
  // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — both hoisted so
  // Phase B (below) can reach them; see the assignment site's own comment.
  let mediaSplit: boolean;
  let attachments: string[];
  try {
    account = await repo.getGhlAccountByLocationId(locationId);
    if (!account) {
      // The hard refusal (plan §2's "the constraint that makes the map
      // unmissable") — no fallback session, ever. Log + Slack, 200-ignored
      // to GHL (we own retries; a redelivery would just hit this same
      // branch).
      console.error(`[ghl-provider] webhook for unknown locationId ${locationId} — no installed ghl_accounts row, ignoring`);
      deps.notify(`GHL sent an outbound message for locationId ${locationId}, which has no installed WhatsApp provider account. Message ignored.`);
      return { kind: "ignored", reason: "unknown_location" };
    }

    const phone = typeof payload.phone === "string" ? payload.phone : null;
    toPhone = normalisePhoneE164(phone, "GB");

    const rawMessage = typeof payload.message === "string" ? payload.message : "";
    attachments = Array.isArray(payload.attachments) ? payload.attachments.filter((a): a is string => typeof a === "string") : [];
    // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — with the flag
    // off, or with no attachments at all, `textResult` is built EXACTLY as
    // before (message + URL lines) and everything downstream is the
    // pre-media-plan single-send path, unchanged (see
    // `handleProviderOutboundMessage`'s own flags-off regression guarantee
    // below). Only when BOTH the portal's own switch is on AND this payload
    // actually carries attachments does `textResult` become TEXT-ONLY — the
    // attachments are no longer folded into it; they become their own parts
    // in `handleMediaSplitOutbound`.
    mediaSplit = isMediaOutboundEnabled() && attachments.length > 0;
    textResult = buildOutboundText(rawMessage, mediaSplit ? [] : attachments);

    ({ message: row, isNew } = await repo.recordGhlOutboundMessage({
      locationId: account.locationId,
      tenantId: account.tenantId,
      ghlMessageId: messageId,
      ghlContactId: contactId,
      idempotencyKey: deriveIdempotencyKey(messageId),
      toPhone,
      hadAttachments: attachments.length > 0,
      // Only carried forward when we're actually going to attempt a bridge
      // send with it — see this file's pending_text note in the header.
      pendingText: toPhone && textResult.ok ? textResult.text : null,
    }));
  } catch (err) {
    console.error(`[ghl-provider] handleProviderOutboundMessage: pre-intake failure for locationId ${locationId} (no row recorded):`, err);
    return { kind: "error", recorded: false };
  }

  if (!isNew) {
    // A GHL webhook redelivery (or a genuine duplicate messageId) for a row
    // already intake-ledgered — this handler already ran once for it. Never
    // a second bridge call, never a second inline report; the drain (or the
    // first pass) already owns/owned this row's outcome.
    return { kind: "duplicate" };
  }

  // PHASE B — the intake row exists from here on. Any failure below is the
  // drain's problem to pick up next pass, never GHL's — the route returns
  // 200 regardless (see the "error" outcome's own JSDoc).
  try {
    // Accounts gate: only an activated number on a paid or trialing account
    // sends. Refused honestly — recorded, then reported back to GoHighLevel as
    // failed with the fixed customer string — and BEFORE the media split, so
    // the media path is gated too.
    const owner = account.accountId ? await repo.getAccountById(account.accountId) : null;
    const gateReason = sendingGate(account, owner?.billingStatus ?? null, brandConfig().name);
    if (gateReason) {
      await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: gateReason });
      await reportGhlOutcome(repo, deps, account, row, "failed", gateReason);
      return { kind: "refused", reason: gateReason };
    }

    // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — split off
    // ENTIRELY before any of the legacy single-send logic below runs. With
    // `mediaSplit` false (flag off, or no attachments), execution never
    // reaches this branch at all — everything from here down in this `try`
    // is byte-for-byte the pre-media-plan code path, which is what makes the
    // flags-off regression guarantee true regardless of what
    // `handleMediaSplitOutbound` does.
    if (mediaSplit) {
      return await handleMediaSplitOutbound(repo, deps, account, row, toPhone, textResult, attachments, messageId);
    }

    // Terminal refusals that never reach the bridge at all (plan's D5/D6).
    if (!toPhone) {
      await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_INVALID_PHONE });
      await reportGhlOutcome(repo, deps, account, row, "failed", REASON_INVALID_PHONE);
      return { kind: "refused", reason: REASON_INVALID_PHONE };
    }
    if (!textResult.ok) {
      const reason = textResult.reason === "too_long" ? REASON_TOO_LONG : REASON_EMPTY_MESSAGE;
      await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
      await reportGhlOutcome(repo, deps, account, row, "failed", reason);
      return { kind: "refused", reason };
    }

    // needs_reauth / disabled — never attempt the bridge for a known-bad
    // account. Still reported inline where possible — see
    // `resolveGhlAccessToken`'s JSDoc (finding 3) for why `needs_reauth`
    // often CAN report immediately (a still-unexpired access token), and
    // `refusalReason` (finding 3) for how the true reason survives even when
    // it can't.
    if (account.status === "needs_reauth" || account.status === "disabled") {
      const reason = account.status === "needs_reauth" ? REASON_NEEDS_REAUTH : REASON_DISABLED;
      await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
      await reportGhlOutcome(repo, deps, account, row, "failed", reason);
      return { kind: "refused", reason };
    }

    const sendResult = await deps.sendWhatsapp({
      coachId: account.tenantId,
      to: toPhone,
      text: textResult.text,
      idempotencyKey: row.idempotencyKey,
    });

    if (sendResult.ok) {
      // 202 fresh accept OR 200 replay (the bridge's OWN idempotency dedupe,
      // distinct from this module's (location_id, ghl_message_id) dedupe
      // above) — either way the bridge now owns this send; zero status calls
      // inline (plan's D3 — delivery truth comes later, via the drain).
      await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
      return { kind: "accepted" };
    }

    if (isTransientBridgeFailure(sendResult.code)) {
      // Transient (finding 5 — includes `unreachable`/`lease_unavailable`
      // AND `internal`/`unauthorized`/any other code not in the explicit
      // terminal set) — row stays 'pending_send' (the DB default; nothing to
      // write), no status call. The drain retries under the SAME
      // idempotency key (plan's D3), bounded by `PENDING_SEND_MAX_ATTEMPTS`.
      return { kind: "pending_retry" };
    }

    const reason = mapBridgeFailureReason(sendResult.code);
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
    await reportGhlOutcome(repo, deps, account, row, "failed", reason);
    return { kind: "refused", reason };
  } catch (err) {
    console.error(`[ghl-provider] handleProviderOutboundMessage: post-intake failure for row ${row.id} (row already recorded — the drain owns it from here):`, err);
    return { kind: "error", recorded: true };
  }
}

// ---------------------------------------------------------------------------
// Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — the outbound
// part-splitting path. Only ever entered from `handleProviderOutboundMessage`
// when `mediaSplit` is true (portal's `isMediaOutboundEnabled()` AND this
// payload has attachments) — see that function's own comment at the call
// site for the flags-off regression guarantee this split protects.
//
// PART MODEL (plan §5.1): a GHL message with text + N attachments becomes
// 1 + N separate bridge sends. The parent `ghl_outbound_messages` row (`row`
// below) IS the text part (its own `sendState`/`pendingText`/`idempotencyKey`
// columns, unchanged shape from the legacy single-send path) when the
// message has non-empty text; when it does not (an attachments-only
// message), the row has no text to send at all — see
// `resolveTextPartOutcome`'s JSDoc for how that "not applicable" state is
// encoded without a schema change. Each attachment is its own
// `ghl_outbound_attachments` row (0073) with its own derived idempotency key
// (`deriveAttachmentIdempotencyKey`, `src/lib/ghl.ts`).
//
// ACCEPT-TIME BUDGET (plan §5.6, decision O3): checked ONCE, before ANY part
// is dispatched — `hasSufficientOutboundBudget` — and before any attachment
// rows are even written, so a budget refusal leaves ZERO
// `ghl_outbound_attachments` rows behind.
//
// STATUS: this function NEVER reports "delivered" inline (a part's bridge
// delivery is always asynchronous) — it only ever reports inline when EVERY
// part is already terminally refused before any dispatch happened at all
// (mirrors the legacy path's own "never reach the bridge for a known-bad
// send" inline-refusal behaviour). Otherwise the drain
// (`drainGhlOutboundStatuses` / `drainMultipartRow` below) owns reporting
// the ONE aggregate status once every part resolves (plan §5.7, decision O4).
// ---------------------------------------------------------------------------

/**
 * One part's terminal-or-not outcome — shared vocabulary between the
 * webhook's own inline aggregation and the drain's (`drainMultipartRow`).
 * `resolved: false` covers BOTH "dispatched, awaiting the bridge's own
 * delivery outcome" and "a transient bridge failure, awaiting the drain's
 * retry" — see call sites for how those two are told apart where the
 * distinction actually matters (the webhook's own return `kind`).
 *
 * `vacuous` (QA Minor 7 fix) marks the attachments-only message's "no text
 * part to send" stand-in (`sent: true` by construction — nothing was ever
 * attempted, so nothing could fail) as NOT real delivered content for
 * aggregation purposes. Without this, `aggregatePartOutcomes` counted the
 * vacuous part's trivial `sent: true` toward `anySent`, so an
 * attachments-only message whose attachments ALL genuinely failed reported
 * the misleading "message partially delivered" sentence instead of the real
 * shared failure reason. A fallback text send that genuinely delivered
 * content (see `handleMediaSplitOutbound`'s media-disabled-fallback
 * substitution) is real delivery and must NOT be marked vacuous.
 */
type PartOutcome = { resolved: false } | { resolved: true; sent: boolean; reason: string | null; vacuous?: boolean };

/**
 * Combines the text part's outcome (or its "not applicable" stand-in) with
 * every attachment part's outcome into ONE status GHL's binary
 * delivered/failed field can carry (plan §5.7, decision O4). `done: false`
 * means at least one part is still in flight or awaiting retry — the caller
 * must not report anything yet. When every part resolved and at least one
 * failed: if NOTHING sent at all and every failure shares the SAME reason,
 * that exact reason is forwarded (matches the single-part legacy behaviour
 * when there's effectively only one thing that could have gone wrong);
 * otherwise (a genuine mix — some parts sent, some didn't, or different
 * parts failed for different reasons) the fixed partial-delivery sentence is
 * used, exactly as the plan specifies. `vacuous` parts (see `PartOutcome`'s
 * own JSDoc, QA Minor 7 fix) are excluded from every check below — they are
 * neither "real content that sent" nor ever counted toward a genuine
 * failure.
 */
function aggregatePartOutcomes(outcomes: PartOutcome[]): { done: false } | { done: true; status: "delivered" } | { done: true; status: "failed"; reason: string } {
  if (outcomes.some((o) => !o.resolved)) return { done: false };
  const resolved = outcomes as Extract<PartOutcome, { resolved: true }>[];
  const real = resolved.filter((o) => !o.vacuous);
  if (real.every((o) => o.sent)) return { done: true, status: "delivered" };
  const failing = real.filter((o) => !o.sent);
  const anySent = real.some((o) => o.sent);
  const reasons = new Set(failing.map((o) => o.reason ?? REASON_SENT_FAILED));
  if (!anySent && reasons.size === 1) {
    return { done: true, status: "failed", reason: [...reasons][0] };
  }
  return { done: true, status: "failed", reason: REASON_PARTIAL_DELIVERY };
}

/**
 * Plan §5.6/decision O3's accept-time reservation, done ONCE for the whole
 * multipart message rather than per part — see `GhlProviderDeps.getSession`'s
 * own JSDoc for the "best-effort front-load, bridge remains authoritative"
 * framing. When the session snapshot itself can't be read (bridge
 * unconfigured/unreachable/no session yet for this tenant — a `BridgeFailure`
 * of any `code`), this returns `true` (never blocks) — refusing a message
 * outright because a DIAGNOSTIC call failed would be strictly worse than
 * letting the bridge's own per-part cap enforcement be the backstop it
 * already is.
 */
async function hasSufficientOutboundBudget(deps: GhlProviderDeps, tenantId: string, unitsNeeded: number): Promise<boolean> {
  const session = await deps.getSession(tenantId);
  if (!session.ok) return true;
  const remaining = session.session.dailyCap - session.session.sentToday - session.session.queueLength;
  return unitsNeeded <= remaining;
}

async function handleMediaSplitOutbound(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  account: GhlAccount,
  row: GhlOutboundMessage,
  toPhone: string | null,
  textResult: ReturnType<typeof buildOutboundText>,
  attachmentUrls: string[],
  ghlMessageId: string
): Promise<HandleProviderOutboundOutcome> {
  // Terminal refusals shared with the legacy path, in the SAME order — see
  // `handleProviderOutboundMessage`'s own comments for why each exists.
  if (!toPhone) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_INVALID_PHONE });
    await reportGhlOutcome(repo, deps, account, row, "failed", REASON_INVALID_PHONE);
    return { kind: "refused", reason: REASON_INVALID_PHONE };
  }
  // `textResult` was built TEXT-ONLY (no attachment URLs folded in) by the
  // caller — reason 'empty' here means "no text at all", which in split mode
  // is a legitimate attachments-only message, NOT a refusal (unlike the
  // legacy path, where 'empty' can only mean "no text AND no attachments").
  if (!textResult.ok && textResult.reason === "too_long") {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_TOO_LONG });
    await reportGhlOutcome(repo, deps, account, row, "failed", REASON_TOO_LONG);
    return { kind: "refused", reason: REASON_TOO_LONG };
  }
  const hasTextPart = textResult.ok;

  if (account.status === "needs_reauth" || account.status === "disabled") {
    const reason = account.status === "needs_reauth" ? REASON_NEEDS_REAUTH : REASON_DISABLED;
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
    await reportGhlOutcome(repo, deps, account, row, "failed", reason);
    return { kind: "refused", reason };
  }

  // ACCEPT-TIME BUDGET CHECK (plan §5.6/O3) — before ANY dispatch, before ANY
  // `ghl_outbound_attachments` row is even written. Text + 3 attachments = 4
  // units, matching what WhatsApp itself will see as 4 separate frames.
  const totalUnits = (hasTextPart ? 1 : 0) + attachmentUrls.length;
  const budgetOk = await hasSufficientOutboundBudget(deps, account.tenantId, totalUnits);
  if (!budgetOk) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_CAP_REACHED });
    await reportGhlOutcome(repo, deps, account, row, "failed", REASON_CAP_REACHED);
    return { kind: "refused", reason: REASON_CAP_REACHED };
  }

  // Every pre-dispatch check has passed — NOW write the attachment part rows
  // (plan §5.1) and dispatch text first, then attachments in seq order (plan
  // §5.2 — "text goes first as its own message").
  const drafts: GhlOutboundAttachmentDraft[] = attachmentUrls.map((url, seq) => ({
    outboundMessageId: row.id,
    seq,
    idempotencyKey: deriveAttachmentIdempotencyKey(ghlMessageId, seq),
    pendingUrl: url,
    fileName: null, // GHL's payload carries bare URL strings only — see GhlOutboundAttachment.fileName's own JSDoc.
  }));
  const attachmentRows: GhlOutboundAttachment[] = await repo.recordGhlOutboundAttachments(drafts);

  const partOutcomes: PartOutcome[] = [];
  let anyTransientRetry = false;

  if (hasTextPart && textResult.ok) {
    const sendResult = await deps.sendWhatsapp({ coachId: account.tenantId, to: toPhone, text: textResult.text, idempotencyKey: row.idempotencyKey });
    if (sendResult.ok) {
      await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
      partOutcomes.push({ resolved: false });
    } else if (isTransientBridgeFailure(sendResult.code)) {
      // Row stays 'pending_send' (the DB default — nothing to write); the
      // drain retries it (`resolveTextPartOutcome`/`retryTextPart`).
      anyTransientRetry = true;
      partOutcomes.push({ resolved: false });
    } else {
      const reason = mapBridgeFailureReason(sendResult.code);
      await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
      partOutcomes.push({ resolved: true, sent: false, reason });
    }
  } else {
    // No text to send (attachments-only message) — the row's own state is
    // VACUOUSLY resolved: nothing outstanding, nothing to fail. See
    // `resolveTextPartOutcome`'s JSDoc for why this is encoded as 'refused'
    // with the internal-only sentinel rather than left at 'pending_send'
    // (which would make the drain try to retry a send that was never
    // supposed to happen) or a genuine reported refusal (which would tell
    // GHL this message failed, when it may fully succeed via its
    // attachments).
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: TEXT_PART_NOT_APPLICABLE });
    // QA Minor 7 fix — `vacuous: true`: this is not real delivered content,
    // see `PartOutcome`'s own JSDoc.
    partOutcomes.push({ resolved: true, sent: true, reason: null, vacuous: true });
  }

  // QA Major 6 fix — collects the URL of every attachment part refused
  // SPECIFICALLY because the bridge's own media switch is off (as opposed to
  // any other terminal reason — invalid URL, too-long filename, etc., which
  // genuinely are bad attachments, not a config mismatch). See the
  // content-preserving fallback below the loop.
  const mediaDisabledUrls: string[] = [];

  for (const part of attachmentRows) {
    // Captured BEFORE the state-transition write below — a repo
    // implementation is free to null `pendingUrl` on this SAME in-memory
    // object once it leaves 'pending_send' (0073's populate-then-clear
    // lifecycle, mirrored in-memory by at least one repo implementation),
    // so reading it after that call would already be too late.
    const url = part.pendingUrl;
    const sendResult = await deps.sendAttachment({
      coachId: account.tenantId,
      to: toPhone,
      attachment: { url: url ?? "", fileName: part.fileName ?? undefined },
      idempotencyKey: part.idempotencyKey,
    });
    if (sendResult.ok) {
      await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "accepted" });
      partOutcomes.push({ resolved: false });
    } else if (isTransientBridgeFailure(sendResult.code)) {
      anyTransientRetry = true;
      partOutcomes.push({ resolved: false });
    } else {
      const reason = mapBridgeFailureReason(sendResult.code);
      await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: reason });
      if (sendResult.code === "media_outbound_disabled" && url) mediaDisabledUrls.push(url);
      partOutcomes.push({ resolved: true, sent: false, reason });
    }
  }

  // QA Major 6 fix — content-preserving fallback for a portal=true/bridge=false
  // config mismatch. Without this, a mismatch is STRICTLY WORSE than both
  // flags off: the text part above went out WITHOUT the attachment URLs
  // (`textResult` was built text-only for the split path), and every
  // attachment then hits this terminal `media_outbound_disabled` refusal —
  // the recipient gets bare text and the URLs are gone, whereas both-off
  // would at least have appended them as link lines. Recover exactly that
  // degraded-but-present shape: fold every media-disabled URL into ONE
  // fallback text send via the same `buildOutboundText` link-line
  // construction the legacy single-send path always used.
  //
  // Scope note: `WA_MEDIA_OUTBOUND_ENABLED` is a single static read for the
  // bridge's whole process, so within this one synchronous dispatch loop it
  // disables either EVERY attachment part of this message or NONE — it
  // cannot newly appear later, mid-drain, for a part that already dispatched
  // moments ago (a part only ever reaches `pending_send`, the drain's retry
  // candidate state, via a TRANSIENT failure code, and this one is terminal
  // by construction). That is why this handling lives entirely here, inline,
  // rather than also in `resolveAttachmentPartOutcome`'s drain-retry path.
  if (mediaDisabledUrls.length > 0) {
    const fallback = buildOutboundText("", mediaDisabledUrls);
    if (fallback.ok) {
      const fallbackResult = await deps.sendWhatsapp({
        coachId: account.tenantId,
        to: toPhone,
        text: fallback.text,
        idempotencyKey: deriveMediaFallbackIdempotencyKey(ghlMessageId),
      });
      if (fallbackResult.ok) {
        // The content reached the pipe (just as text, not as attachments) —
        // replace every media-disabled part's OUTCOME (not its DB row, which
        // stays genuinely 'refused' as an attachment — see `resolveAttachmentPartOutcome`)
        // with a vacuous success, so `aggregatePartOutcomes` never reports
        // the misleading partial-delivery sentence for URLs that, in truth,
        // arrived.
        for (let i = 0; i < partOutcomes.length; i++) {
          const outcome = partOutcomes[i];
          if (outcome.resolved && !outcome.sent && outcome.reason === REASON_MEDIA_DISABLED_ON_BRIDGE) {
            partOutcomes[i] = { resolved: true, sent: true, reason: null };
          }
        }
      }
      // Fallback send itself failed (bridge unreachable, cap reached, …) —
      // left untouched: no worse than the pre-fix behaviour, and content
      // genuinely could not be delivered by any means this pass.
    }
    // `fallback.ok === false` only if the URL list alone exceeds the 4096-char
    // limit (`buildOutboundText`'s own 'too_long' refusal) — nothing more to
    // do; the original per-part refusal reasons stand.
  }

  // If EVERY part is already terminally refused (nothing dispatched, nothing
  // pending) — report inline now, mirroring the legacy path's own "never
  // reach the bridge for a doomed send" inline-refusal behaviour. Any other
  // shape (something dispatched, or something transiently pending) is left
  // for the drain to aggregate once every part actually resolves (plan §5.7).
  const aggregate = aggregatePartOutcomes(partOutcomes);
  if (aggregate.done && aggregate.status === "failed") {
    await reportGhlOutcome(repo, deps, account, row, "failed", aggregate.reason);
    return { kind: "refused", reason: aggregate.reason };
  }
  return anyTransientRetry ? { kind: "pending_retry" } : { kind: "accepted" };
}

export interface DrainGhlOutboundStatusesResult {
  /** Unreported rows this pass looked at (capped at `DRAIN_BATCH_CAP`). */
  candidates: number;
  /** Successfully reported 'delivered' to GHL this pass. */
  delivered: number;
  /** Successfully reported 'failed' to GHL this pass (includes retry-exhausted `pending_send` rows and `not_on_whatsapp`). */
  failed: number;
  /** `pending_send` rows re-sent to the bridge this pass (regardless of outcome). */
  retried: number;
  /** `pending_send` rows still pending after this pass (bridge still unreachable, attempts remaining). */
  stillPending: number;
  /** `accepted` rows whose bridge-side outcome hasn't resolved yet — left for the next pass. */
  unresolved: number;
  /** Rows where the PUT to GHL itself failed — left unreported, `report_error` stamped, retried next pass. */
  reportFailed: number;
  /** Finding 5 — `true` iff this pass stopped early after `DRAIN_TIME_BUDGET_MS` because it ran long; any rows past that point were never started and remain valid candidates for the next pass. `false` on every normal pass. */
  timeBudgetExceeded: boolean;
}

/**
 * The async follow-up drain — see this file's header. Never throws; every
 * top-level failure and every per-row failure is caught and logged, mirroring
 * `processInboundWhatsappReplies`'s per-row isolation exactly.
 */
export async function drainGhlOutboundStatuses(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps = defaultGhlProviderDeps
): Promise<DrainGhlOutboundStatusesResult> {
  const result: DrainGhlOutboundStatusesResult = {
    candidates: 0,
    delivered: 0,
    failed: 0,
    retried: 0,
    stillPending: 0,
    unresolved: 0,
    reportFailed: 0,
    timeBudgetExceeded: false,
  };
  const startedAtMs = Date.now();

  let rows: GhlOutboundMessage[] = [];
  try {
    rows = await repo.listUnreportedGhlOutboundMessages(DRAIN_BATCH_CAP);
  } catch (err) {
    console.error("[ghl-provider.drainGhlOutboundStatuses] failed to list unreported rows (non-fatal):", err);
    return result;
  }
  result.candidates = rows.length;
  if (rows.length === 0) return result;

  // Media plan (docs/MEDIA-PLAN.md §5.7, build-order step 8) — batch-fetch
  // the attachment parts for every candidate row that COULD have some (same
  // "one query for the whole batch" discipline as the bridge-ledger join
  // below), keyed by outbound_message_id. A row with `hadAttachments` but ZERO
  // attachment rows is the pre-media-plan single-send shape (flag was off,
  // or the row was refused before any attachment row was ever written — see
  // `handleMediaSplitOutbound`) and falls straight through to the legacy
  // per-sendState branches below, unchanged.
  const candidateIds = rows.filter((r) => r.hadAttachments).map((r) => r.id);
  const attachmentsByMessageId = new Map<string, GhlOutboundAttachment[]>();
  // Blocker 1 fix (QA findings) — tracks whether the attachment-listing read
  // below threw. When it did, `attachmentsByMessageId` is NOT a trustworthy
  // "this row genuinely has zero part rows" signal for ANY `hadAttachments`
  // row this pass (not just the ones that would have populated the map) —
  // the earlier "falls through to the legacy branches" comment undersold the
  // danger: the legacy 'refused' branch reports `row.refusalReason` to GHL as
  // a terminal `failed`, and for an attachments-only row that reason is the
  // internal `TEXT_PART_NOT_APPLICABLE` sentinel, which must never reach GHL
  // and must never terminally fail a row whose attachments may still be
  // sending. See the row loop below: every `hadAttachments` row is skipped
  // entirely (left unresolved) while this flag is set, and only ever
  // resolved via `drainMultipartRow` or via the legacy branches on a pass
  // where this listing read actually succeeded.
  let attachmentListingFailed = false;
  if (candidateIds.length) {
    try {
      for (const a of await repo.listGhlOutboundAttachmentsForMessages(candidateIds)) {
        const list = attachmentsByMessageId.get(a.outboundMessageId);
        if (list) list.push(a);
        else attachmentsByMessageId.set(a.outboundMessageId, [a]);
      }
    } catch (err) {
      // Non-fatal — every `hadAttachments` row this pass is left unresolved
      // (see `attachmentListingFailed` above), which is safe because those
      // rows stay unreported (reported_status IS NULL) and are picked up
      // correctly on the next pass once this read succeeds.
      attachmentListingFailed = true;
      console.error("[ghl-provider.drainGhlOutboundStatuses] failed to list attachment parts (non-fatal) — hadAttachments rows left unresolved this pass:", err);
    }
  }

  // Batch-resolve every 'accepted' PART's bridge-side outcome (text rows AND
  // attachment rows) in ONE service-role join (plan's D3 — "same database,
  // no bridge HTTP call needed"), rather than one lookup per row/part.
  const acceptedRows = rows.filter((r) => r.sendState === "accepted");
  const acceptedAttachmentPairs: { tenantId: string; idempotencyKey: string }[] = [];
  for (const row of rows) {
    for (const part of attachmentsByMessageId.get(row.id) ?? []) {
      if (part.sendState === "accepted") acceptedAttachmentPairs.push({ tenantId: row.tenantId, idempotencyKey: part.idempotencyKey });
    }
  }
  const joinPairs = [...acceptedRows.map((r) => ({ tenantId: r.tenantId, idempotencyKey: r.idempotencyKey })), ...acceptedAttachmentPairs];
  let bridgeStatuses: { coachId: string; idempotencyKey: string; status: string; error: string | null }[] = [];
  if (joinPairs.length) {
    try {
      bridgeStatuses = await repo.getWhatsappMessagesByTenantKeys(joinPairs);
    } catch (err) {
      // Adversarial-review finding 6: this join used to be OUTSIDE both the
      // list try/catch above and the per-row try/catch below — a transient
      // failure here used to throw straight out of this function, which
      // both callers (the webhook route's own call chain never reaches
      // this, but the poke route and the reminders cron do) would have seen
      // as an uncaught rejection despite this module's header claiming
      // never-throws. `bridgeStatuses` simply stays empty: every 'accepted'
      // row/part below falls into the normal "not resolved yet" branch
      // (`bridgeMessage === null` -> unresolved) and is retried next pass —
      // exactly the same as a genuinely-not-yet-dispatched message, never a
      // false 'failed'.
      console.error("[ghl-provider.drainGhlOutboundStatuses] failed to join whatsapp_messages (non-fatal) — accepted rows/parts left unresolved this pass:", err);
    }
  }
  const bridgeStatusByKey = new Map(bridgeStatuses.map((b) => [`${b.coachId}:${b.idempotencyKey}`, b]));

  for (const [rowIndex, row] of rows.entries()) {
    // Finding 5 — wall-clock budget, checked before STARTING each row (a row
    // already in flight always finishes; this only stops the pass from
    // beginning a NEW row once it's run long). Rows not reached here are
    // simply left as-is (still unreported/still pending_send) — the next
    // poke or cron pass picks them straight back up, same as any other
    // not-yet-processed row.
    if (Date.now() - startedAtMs >= DRAIN_TIME_BUDGET_MS) {
      result.timeBudgetExceeded = true;
      console.error(
        `[ghl-provider.drainGhlOutboundStatuses] time budget (${DRAIN_TIME_BUDGET_MS}ms) exceeded after ${rowIndex}/${rows.length} row(s) — stopping this pass early; the remaining row(s) are left for the next pass.`
      );
      break;
    }
    try {
      // Blocker 1 fix (QA findings) — while the attachment listing read
      // failed this pass, a `hadAttachments` row must NEVER be resolved via
      // the legacy single-part branches below: `parts.length === 0` here is
      // indistinguishable between "genuinely zero attachment rows" and "the
      // listing read failed before it could tell us". Skip it entirely
      // (counts as unresolved) and let the next pass — where the listing
      // read may succeed — resolve it correctly, whether that lands it in
      // `drainMultipartRow` or (on a pass with a genuinely empty part list)
      // the legacy branches.
      if (row.hadAttachments && attachmentListingFailed) {
        result.unresolved++;
        continue;
      }
      const parts = attachmentsByMessageId.get(row.id) ?? [];
      if (row.hadAttachments && parts.length > 0) {
        // Media plan (docs/MEDIA-PLAN.md §5.7) — a genuine multipart row:
        // aggregate ALL of its parts (text + every attachment) into ONE
        // status report, regardless of `row.sendState` alone (which only
        // ever describes the text part / the vacuous "not applicable" state
        // — see `resolveTextPartOutcome`).
        await drainMultipartRow(repo, deps, row, parts, bridgeStatusByKey, result);
      } else if (row.sendState === "pending_send") {
        await drainPendingSend(repo, deps, row, result);
      } else if (row.sendState === "accepted") {
        const bridgeMessage = bridgeStatusByKey.get(`${row.tenantId}:${row.idempotencyKey}`) ?? null;
        await drainAcceptedRow(repo, deps, row, bridgeMessage, result);
      } else {
        // 'refused' + still unreported — the webhook's own inline report
        // never actually landed (e.g. no valid token at the time, or the PUT
        // itself failed). Adversarial-review finding 3: report the row's
        // PERSISTED `refusalReason` (stamped once, the instant the row
        // became 'refused' — see `GhlOutboundMessage.refusalReason`'s
        // JSDoc), falling back to a generic reason only for a row that
        // predates 0071_ghl_outbound_refusal_reason.sql (refusalReason null).
        //
        // Blocker 1 fix, belt-and-braces: `TEXT_PART_NOT_APPLICABLE` is an
        // internal sentinel for an attachments-only row's vacuous text part
        // (see `resolveTextPartOutcome`) and must never be reported to GHL
        // as a failure reason, and this row must never be terminally failed
        // on the strength of it alone — its attachments may still be
        // sending. This should be unreachable now that the guard above skips
        // every `hadAttachments` row during a listing failure, but a row
        // reaching here with this exact reason means something upstream
        // stamped it outside that invariant — fail closed by leaving it
        // unresolved rather than reporting it.
        if (row.refusalReason === TEXT_PART_NOT_APPLICABLE) {
          result.unresolved++;
          continue;
        }
        const account = await repo.getGhlAccountByLocationId(row.locationId);
        const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", row.refusalReason ?? REASON_GENERIC_REFUSED);
        if (outcome === "reported") result.failed++;
        else result.reportFailed++;
      }
    } catch (err) {
      console.error(`[ghl-provider.drainGhlOutboundStatuses] row ${row.id} failed unexpectedly (non-fatal):`, err);
    }
  }

  return result;
}

/**
 * Media plan (docs/MEDIA-PLAN.md §5.7, decision O4) — resolves a multipart
 * row's TEXT part (`resolveTextPartOutcome`, which also owns retrying a
 * `pending_send` text part) and every attachment part
 * (`resolveAttachmentPartOutcome`, same retry duty for attachment parts),
 * then reports ONE aggregate status (`aggregatePartOutcomes`) — delivered
 * only once every part has resolved successfully, failed (with the fixed
 * partial-delivery reason, or the single shared reason when nothing sent at
 * all) the moment every part has resolved and at least one didn't succeed,
 * otherwise left unresolved for the next pass.
 */
async function drainMultipartRow(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  row: GhlOutboundMessage,
  parts: GhlOutboundAttachment[],
  bridgeStatusByKey: Map<string, { status: string; error: string | null }>,
  result: DrainGhlOutboundStatusesResult
): Promise<void> {
  const textOutcome = await resolveTextPartOutcome(repo, deps, row, bridgeStatusByKey, result);
  const attachmentOutcomes: PartOutcome[] = [];
  for (const part of parts) {
    attachmentOutcomes.push(await resolveAttachmentPartOutcome(repo, deps, row, part, bridgeStatusByKey, result));
  }

  const aggregate = aggregatePartOutcomes([textOutcome, ...attachmentOutcomes]);
  if (!aggregate.done) {
    result.unresolved++;
    return;
  }

  const account = await repo.getGhlAccountByLocationId(row.locationId);
  const status = aggregate.status === "delivered" ? "delivered" : "failed";
  const outcome = await reportGhlOutcome(repo, deps, account, row, status, aggregate.status === "failed" ? aggregate.reason : null);
  if (outcome === "reported") {
    if (aggregate.status === "delivered") result.delivered++;
    else result.failed++;
  } else {
    result.reportFailed++;
  }
}

/**
 * The TEXT part's outcome within a multipart row — `row.sendState` describes
 * ONLY this part (never the message as a whole once attachments are
 * involved; see `drainMultipartRow`). The `TEXT_PART_NOT_APPLICABLE`
 * sentinel (an attachments-only message never had a text part to send —
 * `handleMediaSplitOutbound`) is read back here and translated to a vacuous
 * SUCCESS (`sent: true`) — it must never surface as a failure reason, and it
 * must never make the drain try to "retry" a send that was never supposed to
 * happen.
 */
async function resolveTextPartOutcome(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  row: GhlOutboundMessage,
  bridgeStatusByKey: Map<string, { status: string; error: string | null }>,
  result: DrainGhlOutboundStatusesResult
): Promise<PartOutcome> {
  if (row.sendState === "refused") {
    // QA Minor 7 fix — `vacuous: true`: not real delivered content, see
    // `PartOutcome`'s own JSDoc.
    if (row.refusalReason === TEXT_PART_NOT_APPLICABLE) return { resolved: true, sent: true, reason: null, vacuous: true };
    return { resolved: true, sent: false, reason: row.refusalReason ?? REASON_GENERIC_REFUSED };
  }
  if (row.sendState === "accepted") {
    const bridgeMessage = bridgeStatusByKey.get(`${row.tenantId}:${row.idempotencyKey}`) ?? null;
    if (!bridgeMessage || bridgeMessage.status === "accepted" || bridgeMessage.status === "sending") return { resolved: false };
    if (bridgeMessage.status === "sent") return { resolved: true, sent: true, reason: null };
    if (bridgeMessage.status === "not_on_whatsapp") return { resolved: true, sent: false, reason: REASON_NOT_ON_WHATSAPP };
    return { resolved: true, sent: false, reason: bridgeMessage.error ?? REASON_SENT_FAILED };
  }
  // 'pending_send' — retry, bounded by the row's OWN `sendAttempts` (the
  // same column/bound the legacy `drainPendingSend` uses — reused verbatim
  // here since this IS that same column on this SAME row, just scoped to the
  // text part specifically within a multipart message).
  return retryTextPart(repo, deps, row, result);
}

async function retryTextPart(repo: GhlProviderRepo, deps: GhlProviderDeps, row: GhlOutboundMessage, result: DrainGhlOutboundStatusesResult): Promise<PartOutcome> {
  if (row.sendAttempts >= PENDING_SEND_MAX_ATTEMPTS) {
    // Same finding-4 check as `drainPendingSend`: the send may genuinely
    // have reached the bridge even though every response back to US timed
    // out.
    const ledger = await repo.getWhatsappMessagesByTenantKeys([{ tenantId: row.tenantId, idempotencyKey: row.idempotencyKey }]);
    const bridgeMessage = ledger[0] ?? null;
    if (bridgeMessage) {
      await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
      if (bridgeMessage.status === "accepted" || bridgeMessage.status === "sending") return { resolved: false };
      if (bridgeMessage.status === "sent") return { resolved: true, sent: true, reason: null };
      if (bridgeMessage.status === "not_on_whatsapp") return { resolved: true, sent: false, reason: REASON_NOT_ON_WHATSAPP };
      return { resolved: true, sent: false, reason: bridgeMessage.error ?? REASON_SENT_FAILED };
    }
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    return { resolved: true, sent: false, reason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED };
  }
  if (row.toPhone === null || row.pendingText === null) {
    // Structurally shouldn't happen — see `drainPendingSend`'s identical
    // defensive branch.
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    return { resolved: true, sent: false, reason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED };
  }
  result.retried++;
  const sendResult = await deps.sendWhatsapp({ coachId: row.tenantId, to: row.toPhone, text: row.pendingText, idempotencyKey: row.idempotencyKey });
  if (sendResult.ok) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
    return { resolved: false };
  }
  if (isTransientBridgeFailure(sendResult.code)) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "pending_send", sendAttempts: row.sendAttempts + 1 });
    result.stillPending++;
    return { resolved: false };
  }
  const reason = mapBridgeFailureReason(sendResult.code);
  await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
  return { resolved: true, sent: false, reason };
}

/**
 * One attachment part's outcome. QA Major 5 fix: `ghl_outbound_attachments`
 * now carries its own `send_attempts` column (migration 0074, WRITTEN NOT
 * APPLIED), so a `pending_send` attachment part is bounded by
 * `PENDING_SEND_MAX_ATTEMPTS` exactly like the text part —
 * `retryTextPart`'s own logic, mirrored here verbatim but scoped to this
 * part's own `sendAttempts`/`pendingUrl`/idempotency key rather than the
 * row's. Without this bound, a permanently-unreachable bridge retried an
 * attachment part on every drain pass forever, which kept the WHOLE
 * multipart row unreported and — since `listUnreportedGhlOutboundMessages`
 * is oldest-first LIMIT 50 — let enough permanently-stuck rows accumulate
 * to starve every newer outbound row out of the batch indefinitely.
 */
async function resolveAttachmentPartOutcome(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  row: GhlOutboundMessage,
  part: GhlOutboundAttachment,
  bridgeStatusByKey: Map<string, { status: string; error: string | null }>,
  result: DrainGhlOutboundStatusesResult
): Promise<PartOutcome> {
  if (part.sendState === "refused") {
    return { resolved: true, sent: false, reason: part.refusalReason ?? REASON_GENERIC_REFUSED };
  }
  if (part.sendState === "accepted") {
    const bridgeMessage = bridgeStatusByKey.get(`${row.tenantId}:${part.idempotencyKey}`) ?? null;
    if (!bridgeMessage || bridgeMessage.status === "accepted" || bridgeMessage.status === "sending") return { resolved: false };
    if (bridgeMessage.status === "sent") return { resolved: true, sent: true, reason: null };
    if (bridgeMessage.status === "not_on_whatsapp") return { resolved: true, sent: false, reason: REASON_NOT_ON_WHATSAPP };
    return { resolved: true, sent: false, reason: bridgeMessage.error ?? REASON_SENT_FAILED };
  }
  // 'pending_send' — retry, bounded by the part's OWN `sendAttempts`,
  // mirroring `retryTextPart` exactly.
  if (part.sendAttempts >= PENDING_SEND_MAX_ATTEMPTS) {
    // Same finding-4 check `retryTextPart`/`drainPendingSend` use: the send
    // may genuinely have reached the bridge even though every response back
    // to US timed out.
    const ledger = await repo.getWhatsappMessagesByTenantKeys([{ tenantId: row.tenantId, idempotencyKey: part.idempotencyKey }]);
    const bridgeMessage = ledger[0] ?? null;
    if (bridgeMessage) {
      await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "accepted" });
      if (bridgeMessage.status === "accepted" || bridgeMessage.status === "sending") return { resolved: false };
      if (bridgeMessage.status === "sent") return { resolved: true, sent: true, reason: null };
      if (bridgeMessage.status === "not_on_whatsapp") return { resolved: true, sent: false, reason: REASON_NOT_ON_WHATSAPP };
      return { resolved: true, sent: false, reason: bridgeMessage.error ?? REASON_SENT_FAILED };
    }
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    return { resolved: true, sent: false, reason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED };
  }
  if (row.toPhone === null || part.pendingUrl === null) {
    // Structurally shouldn't happen — see `drainPendingSend`'s identical defensive branch.
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    return { resolved: true, sent: false, reason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED };
  }
  result.retried++;
  const sendResult = await deps.sendAttachment({
    coachId: row.tenantId,
    to: row.toPhone,
    attachment: { url: part.pendingUrl, fileName: part.fileName ?? undefined },
    idempotencyKey: part.idempotencyKey,
  });
  if (sendResult.ok) {
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "accepted" });
    return { resolved: false };
  }
  if (isTransientBridgeFailure(sendResult.code)) {
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "pending_send", sendAttempts: part.sendAttempts + 1 });
    result.stillPending++;
    return { resolved: false };
  }
  const reason = mapBridgeFailureReason(sendResult.code);
  await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: reason });
  return { resolved: true, sent: false, reason };
}

/** `pending_send` branch — retry the bridge send under the SAME idempotency key (plan's D3), or give up past `PENDING_SEND_MAX_ATTEMPTS`. */
async function drainPendingSend(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  row: GhlOutboundMessage,
  result: DrainGhlOutboundStatusesResult
): Promise<void> {
  if (row.sendAttempts >= PENDING_SEND_MAX_ATTEMPTS) {
    // Adversarial-review finding 4: before reporting the fixed exhaustion
    // failure, check whether the bridge's OWN ledger already has a row for
    // this (tenantId, idempotencyKey) — a webhook-time (or an earlier
    // retry's) send call can genuinely have reached the bridge even though
    // the HTTP response back to US was lost (the 5s client timeout, a
    // dropped connection). Blindly reporting 'failed' here would tell GHL a
    // message failed when it may well have delivered.
    const ledger = await repo.getWhatsappMessagesByTenantKeys([{ tenantId: row.tenantId, idempotencyKey: row.idempotencyKey }]);
    const bridgeMessage = ledger[0] ?? null;
    if (bridgeMessage) {
      // The bridge DID receive this send. Move the row out of the retry
      // path (never send it again) and resolve it through the SAME mapping
      // an 'accepted' row uses — 'sent'/'not_on_whatsapp'/'failed' are
      // handled identically whichever path got the row there, and a
      // still-'accepted'/'sending' bridge status just leaves it unresolved
      // for the next pass, exactly like a genuinely fresh accept would.
      await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
      await drainAcceptedRow(repo, deps, row, bridgeMessage, result);
      return;
    }

    // No ledger row at all — the send genuinely never reached the bridge in
    // any of the attempts. Give up as before.
    const account = await repo.getGhlAccountByLocationId(row.locationId);
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", REASON_BRIDGE_UNREACHABLE_EXHAUSTED);
    if (outcome === "reported") result.failed++;
    else result.reportFailed++;
    return;
  }

  const account = await repo.getGhlAccountByLocationId(row.locationId);
  if (!account || !row.toPhone || row.pendingText === null) {
    // Structurally shouldn't happen — a 'pending_send' row is only ever
    // created with both set (see handleProviderOutboundMessage) — EXCEPT for
    // the exact overlapping-drains race finding 2 describes: a faster
    // concurrent pass can move this row to 'accepted' (clearing
    // `pending_text`) between when THIS pass read the row and when it gets
    // here, and — before the finding-2 fix below made the write conditional
    // — a slower pass's own transient retry used to blindly PATCH
    // `send_state` back to 'pending_send' anyway, leaving the row
    // 'pending_send' with `pending_text = NULL`. Same finding-4-style check
    // as the exhaustion branch above: before reporting the fixed refusal,
    // check whether the bridge's OWN ledger already has a row for this
    // (tenantId, idempotencyKey) — if it does, the send genuinely reached
    // the bridge and must be resolved through the normal mapping, never
    // blindly reported 'failed' out from under a message that may already be
    // 'sent'.
    const ledger = await repo.getWhatsappMessagesByTenantKeys([{ tenantId: row.tenantId, idempotencyKey: row.idempotencyKey }]);
    const bridgeMessage = ledger[0] ?? null;
    if (bridgeMessage) {
      await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
      await drainAcceptedRow(repo, deps, row, bridgeMessage, result);
      return;
    }
    // Defensive give-up rather than a crash-looping retry of a genuinely
    // unrecoverable row.
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", REASON_BRIDGE_UNREACHABLE_EXHAUSTED);
    if (outcome === "reported") result.failed++;
    else result.reportFailed++;
    return;
  }

  result.retried++;
  // Adversarial-review finding 9: `row.tenantId`, not `account.tenantId` —
  // the two are the SAME value on every currently-reachable path (a
  // 'pending_send' row's `location_id` always resolves, via `ghl_accounts`,
  // to the tenant that created it), but `row.tenantId` is the value the
  // bridge ledger join (`getWhatsappMessagesByTenantKeys`,
  // `drainAcceptedRow`) keys on — using the row's own field here rather than
  // a second, supposedly-identical source keeps this send's ledger key
  // consistent with the rest of this row's lifecycle even if `ghl_accounts`
  // is ever repointed (see finding 10's install-race note).
  //
  // Adversarial-review finding 8 (send_attempts lost update, accepted): this
  // read-modify-write is NOT atomic — two overlapping drain passes (a poke
  // landing mid-cron-run) can both read the same `row.sendAttempts` and both
  // write back `+1`, so the counter can undercount true attempts under
  // concurrency. Deliberately not fixed with an atomic increment: PostgREST
  // cannot express `send_attempts = send_attempts + 1` in a plain PATCH (a
  // Postgres RPC could, but that's a whole new function + migration for a
  // counter whose ONLY job is a backstop, not a correctness guarantee — see
  // below). The failure mode this leaves is bounded and harmless: at worst
  // BOTH passes call `sendWhatsapp` with the SAME idempotency key, which the
  // bridge's own replay path makes safe (never a double send — the bridge's
  // at-most-once invariant does not depend on this counter at all), and the
  // row simply takes a little longer to reach `PENDING_SEND_MAX_ATTEMPTS`
  // than 5 real attempts would suggest. Accepting this race is strictly
  // simpler and no less safe than adding a new RPC purely to tighten a
  // number that only ever gates "how many more times might we retry",
  // never "did this send happen".
  const sendResult = await deps.sendWhatsapp({ coachId: row.tenantId, to: row.toPhone, text: row.pendingText, idempotencyKey: row.idempotencyKey });

  if (sendResult.ok) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
    return;
  }
  if (isTransientBridgeFailure(sendResult.code)) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "pending_send", sendAttempts: row.sendAttempts + 1 });
    result.stillPending++;
    return;
  }

  const reason = mapBridgeFailureReason(sendResult.code);
  await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
  const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", reason);
  if (outcome === "reported") result.failed++;
  else result.reportFailed++;
}

/** `accepted` branch — resolve via the bridge ledger join computed once per pass by the caller. */
async function drainAcceptedRow(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  row: GhlOutboundMessage,
  bridgeMessage: { status: string; error: string | null } | null,
  result: DrainGhlOutboundStatusesResult
): Promise<void> {
  if (!bridgeMessage || bridgeMessage.status === "accepted" || bridgeMessage.status === "sending") {
    // Not resolved bridge-side yet — leave for the next pass.
    result.unresolved++;
    return;
  }

  const account = await repo.getGhlAccountByLocationId(row.locationId);

  if (bridgeMessage.status === "sent") {
    const outcome = await reportGhlOutcome(repo, deps, account, row, "delivered", null);
    if (outcome === "reported") result.delivered++;
    else result.reportFailed++;
    return;
  }
  if (bridgeMessage.status === "not_on_whatsapp") {
    const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", REASON_NOT_ON_WHATSAPP);
    if (outcome === "reported") result.failed++;
    else result.reportFailed++;
    return;
  }
  // 'failed' — forward the bridge ledger's own fixed reason (guaranteed a
  // fixed string by the bridge's own hard rule 1; never a raw upstream body).
  const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", bridgeMessage.error ?? REASON_SENT_FAILED);
  if (outcome === "reported") result.failed++;
  else result.reportFailed++;
}

// Re-export the "no token" reason so tests can assert on it without
// duplicating the literal string.
export const GHL_PROVIDER_REASONS = {
  invalidPhone: REASON_INVALID_PHONE,
  emptyMessage: REASON_EMPTY_MESSAGE,
  tooLong: REASON_TOO_LONG,
  needsReauth: REASON_NEEDS_REAUTH,
  disabled: REASON_DISABLED,
  notConnected: REASON_NOT_CONNECTED,
  capReached: REASON_CAP_REACHED,
  idempotencyConflict: REASON_IDEMPOTENCY_CONFLICT,
  bridgeUnconfigured: REASON_BRIDGE_UNCONFIGURED,
  bridgeRefused: REASON_BRIDGE_REFUSED,
  bridgeUnreachableExhausted: REASON_BRIDGE_UNREACHABLE_EXHAUSTED,
  notOnWhatsapp: REASON_NOT_ON_WHATSAPP,
  sentFailed: REASON_SENT_FAILED,
  genericRefused: REASON_GENERIC_REFUSED,
  noAccessToken: REASON_NO_ACCESS_TOKEN,
  // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8).
  invalidAttachment: REASON_INVALID_ATTACHMENT,
  mediaDisabledOnBridge: REASON_MEDIA_DISABLED_ON_BRIDGE,
  partialDelivery: REASON_PARTIAL_DELIVERY,
} as const;
