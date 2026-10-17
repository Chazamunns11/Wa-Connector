/**
 * GHL custom conversation provider, Phase 3 — inbound: a prospect's WhatsApp
 * reply pushed into the client's GHL conversation (docs/GHL-PROVIDER-PLAN.md's
 * Phase 3 follow-on — "the seven decisions" §Q1-Q7). Closes the loop Phase 2
 * opened: outbound already works (a GHL workflow's SMS step is intercepted
 * and delivered over WhatsApp); this module is what makes a reply appear
 * back inside that same GHL conversation instead of sitting inert in
 * `whatsapp_inbound_messages` forever.
 *
 * Mirrors `src/lib/ghl-provider.ts`'s shape closely — deps-injected,
 * `webhookRepo`-only, never throws into its callers — and reuses ONE of its
 * exports directly rather than a second copy: `resolveGhlAccessToken` (the
 * single-flight token refresh). See that function's own JSDoc for why
 * sharing ONE implementation is what makes the atomic refresh claim
 * (`claimGhlTokenRefresh`) actually protect a refresh token from being spent
 * twice concurrently — TWO independent refresh implementations calling the
 * same claim would still race each other's OWN retry logic.
 *
 * ============ THE CLAIM-VS-NO-CLAIM ASYMMETRY (restated from the plan's
 * §Q4, and from `src/lib/ghl-provider.ts`'s own header, which explains the
 * OUTBOUND side of the identical contrast) ============
 * `drainGhlOutboundStatuses` (Phase 2) takes NO claim on the status row it
 * reports, because its side effect — `PUT .../status` with the same status —
 * is idempotent server-side; the worst an overlapping poke+cron pair can do
 * is PUT the same status twice. `POST /conversations/messages/inbound` is
 * the opposite: EVERY call appends a brand-new message to the client's GHL
 * conversation, and GHL offers no idempotency key on it at all. So THIS
 * drain takes the SAME atomic claim the coach inbound drain already uses
 * (`claimWhatsappInboundMessage`, `src/lib/whatsapp-replies.ts`) — reused
 * VERBATIM, not reimplemented, because it is purely id-keyed with no
 * coach-specific behaviour (it flips ONE row's `processed_at` from `null` to
 * `now()` and reports whether THIS call won that flip; it has never cared
 * which kind of tenant the row belongs to).
 *
 * ============ SEQUENCE PER ROW (plan §Q4) ============
 *   1. Resolve the installing `ghl_accounts` row for this row's tenant
 *      (`getGhlAccountByTenantId` — the fence at list time already
 *      guarantees `status = 'active'` when this pass started; see step 0).
 *   2. UPSERT CONTACT (`POST /contacts/upsert`, `src/lib/ghl.ts`'s
 *      `upsertGhlContact`) — PRE-CLAIM, deliberately, because it is
 *      IDEMPOTENT (GHL's own server-side dedupe-by-phone): two overlapping
 *      passes (a poke landing mid-cron-run) upserting the SAME phone both
 *      get the SAME `contactId` back, so running it before the claim keeps
 *      the claimed window minimal without any race risk. Memoised per
 *      `(tenantId, fromPhone)` within a single pass (this module's own
 *      efficiency, not a correctness requirement — the upsert would still be
 *      safe called twice).
 *   3. ATOMIC CLAIM (`claimWhatsappInboundMessage`) — see the asymmetry note
 *      above. A lost race here means another pass already claimed (or is
 *      about to finish claiming) this exact row; this pass simply moves on.
 *   4. POST THE MESSAGE (`addGhlInboundMessage`) — `body`, or (plan §Q6) a
 *      fixed media placeholder when `body` is `null` (a non-text reply — the
 *      bridge never stores media, and this drain never fetches it either).
 *      `timestampIso` carries the reply's own `receivedAt` (plan §Q7 —
 *      best-effort ordering, verify-at-go-live whether GHL actually honours
 *      it).
 *   5. RESOLVE — `'ghl_pushed'` on success; see the retry table below for
 *      every failure branch. Multiple numbers (Task 3): on success only, the
 *      contact is then stuck to the number this reply arrived on
 *      (`recordStickiness`, never throws), and step 4's body carries a
 *      `[label] ` / `[Number N] ` prefix when the location has more than one
 *      number.
 *
 * ============ THE RETRY TABLE (plan §Q5, restated in code) ============
 *   - Contact upsert 429/5xx/network error -> RETRYABLE, pre-claim. Row
 *     stays un-claimed (`processed_at` never touched — it was never set);
 *     `push_attempts` incremented, `push_error` stamped
 *     (`recordGhlInboundPushFailure`, `unclaim: false`).
 *   - Inbound-message POST 429/5xx/401/403 -> RETRYABLE, post-claim. The row
 *     WAS claimed before this call — `recordGhlInboundPushFailure` with
 *     `unclaim: true` resets `processed_at` back to `null` so a later pass
 *     can re-claim and retry it. 401/403 (final cross-phase review finding
 *     6) is included deliberately: by the time this POST runs,
 *     `resolveGhlAccessToken` already believed its token was fresh, so a
 *     401/403 here means the token was invalidated in the narrow window
 *     between that check and this request — not that GHL will refuse this
 *     exact message forever. See `addGhlInboundMessage`'s JSDoc
 *     (src/lib/ghl.ts) for the full reasoning.
 *   - Inbound-message POST any other non-2xx (e.g. 400) -> TERMINAL,
 *     `resolution = 'ghl_rejected'` — a definite refusal that would fail
 *     identically on retry. Row stays claimed.
 *   - Inbound-message POST TIMES OUT, OR THROWS ANY NETWORK-LEVEL ERROR THAT
 *     ISN'T PROVABLY PRE-FLIGHT (adversarial-review finding 1's fix — see
 *     `addGhlInboundMessage`'s JSDoc in `src/lib/ghl.ts` for the full
 *     reasoning) -> TERMINAL, `resolution = 'ghl_push_uncertain'`,
 *     Slack-notified once, NEVER RETRIED. `kind: "timeout_uncertain"` is now
 *     the DEFAULT for this POST's catch, not just a genuine `TimeoutError` —
 *     a mid-flight socket reset (after the request body was already
 *     delivered) is just as ambiguous as a timeout, and treating it as
 *     retryable is exactly what let a reply get posted twice. At-most-once
 *     wins: a duplicate reply appearing in the client's own CRM is refused
 *     outright, exactly the bridge's own `dispatch_attempted` philosophy for
 *     the identical "did the far side already see this?" ambiguity.
 *   - `push_attempts` reaches the bound (5) -> TERMINAL, `resolution =
 *     'ghl_push_failed'`, claimed WITHOUT another network call at all — see
 *     `processGhlInboundRow`'s exhaustion pre-check, which mirrors
 *     `src/lib/ghl-provider.ts`'s `drainPendingSend` exhaustion branch
 *     exactly (Phase 1-2 adversarial-review finding 1's own fix shape).
 *   - No usable GHL access token right now (`resolveGhlAccessToken` returns
 *     `null`) -> RETRYABLE, pre-claim, same shape as an upsert failure.
 *
 * ============ STEP 0 — THE PROVIDER-ID GATE (plan §Q1) ============
 * `GHL_CONVERSATION_PROVIDER_ID` is read ONCE at the top of every pass
 * (`ghlConversationProviderId()`, `src/lib/ghl.ts`). Unset -> the WHOLE pass
 * returns immediately: zero repo reads, zero claims, zero GHL calls,
 * `blockedUnconfigured: true` in the result, one `console.error`. Fail-
 * closed, zero-cost, self-healing the instant the env var is set — rows
 * simply wait, bounded by the existing 90-day purge
 * (`Repository.purgeOldWhatsappInboundMessages`). A location's OWN
 * `ghl_accounts.conversation_provider_id` override (0069, currently
 * write-less — a manual-SQL escape hatch for a hypothetical second provider
 * registration) still wins over the env value PER ROW once the pass is
 * actually running (`account.conversationProviderId ?? envProviderId`).
 *
 * ============ THE FINDING-1 STARVATION EXCLUSION (built in from day one)
 * ============ `getUnprocessedGhlInboundMessages` only ever lists rows for
 * an ACTIVE `ghl_accounts` row (mirrors `listUnreportedGhlOutboundMessages`'s
 * identical fix) — a `needs_reauth`/`disabled` location's rows are excluded
 * at LIST time, not merely skipped in-process, so they can never monopolise
 * this oldest-first, capped batch the way Phase 1-2's finding 1 demonstrated.
 *
 * ============ THE CIRCUIT BREAKER (plan §Q5's final row) ============
 * After 5 CONSECUTIVE failures of the SAME GHL endpoint (contact upserts and
 * message posts are tracked SEPARATELY — `CircuitBreakerState`) in one pass,
 * the pass aborts — remaining rows are left completely untouched (no claim,
 * no attempt increment) for the next pass. Protects against burning every
 * remaining row's attempt budget against one live GHL outage in a single
 * run. TRACKED PER-ENDPOINT, NOT AS ONE SHARED COUNTER (adversarial-review
 * finding 2, fixed): the normal case is DISTINCT phones per row, so nearly
 * every row calls `upsertContact` fresh. A single counter that resets on ANY
 * successful GHL call — upsert OR post — means a messages-endpoint-only
 * outage never trips it: each row's sequence is upsert-succeeds
 * (resets the shared counter to 0) then post-fails (+1), so the counter
 * never climbs past 1 and a whole 50-row batch burns its entire attempt
 * budget against one outage in a single pass. Two independent counters fix
 * this: an upsert success can only reset the upsert counter, never the post
 * counter, so 5 consecutive post failures still trip the breaker no matter
 * how many (healthy, unrelated) upserts happened in between.
 *
 * HEAD-OF-LINE COST OF ABORTING THE PASS (plan §Q5's own choice — a known
 * tradeoff, not a bug): the row list is globally oldest-first across ALL GHL
 * locations, not per-location. One location whose rows sit at the head of
 * the queue and trip the breaker (e.g. a 429-storm, or same-phone rows
 * hitting one flaky endpoint) aborts the WHOLE pass, so every OTHER
 * location's rows behind it in the queue wait for the next pass too — bounded
 * (each stuck row still terminalises within `MAX_PUSH_ATTEMPTS` listings,
 * and pokes fire frequently), but on a large backlog this can delay an
 * unrelated, perfectly healthy location's pushes by many passes. Inherent to
 * "abort the pass rather than skip past the failing rows" (plan §Q5); not
 * engineered around — a per-location breaker or a per-location list would
 * fix it but is over-engineering for 11 sub-accounts.
 *
 * ============ MEDIA (plan §Q6) ============ Explicit, never silent, never
 * fetched. `describeInboundMediaPlaceholder` (`src/lib/ghl.ts`) maps a
 * non-text reply's `messageType` to a fixed placeholder string that exists
 * ONLY in the text posted to GHL — the DB row's `body` stays `null`
 * regardless (this module never writes to that column).
 *
 * ============ OPT-IN WHATSAPP GROUPS (0007) ============ A row with a
 * `groupJid` is a message from a WhatsApp group, `fromPhone` being the member
 * who wrote it. Resolved via `whatsapp_groups (tenant_id = the ROW's tenant,
 * group_jid)` — memoised per tenant per pass:
 *   - no group row, or not `enabled` -> claimed and resolved
 *     `'group_not_enabled'` (terminal, fixed string), with NO GHL call at all.
 *     The bridge already drops traffic for groups that are not enabled; this
 *     is the app-side fence for a group switched off after the row landed.
 *   - enabled -> posted into the ONE GHL contact standing for the group
 *     (`ghl_contact_id`). The first row creates it (`upsertGhlGroupContact`,
 *     pre-claim like the phone upsert, same retry and breaker accounting) and
 *     stores it (`setWhatsappGroupContact`) BEFORE the claim and post, so
 *     every later row reuses it. The sender is NEVER upserted as a contact
 *     (group members did not opt in to the CRM) and no stickiness is
 *     recorded (a group contact belongs to its group's number).
 *   - body: `<sender name>: <text>` (the sender's E.164 when WhatsApp gave
 *     no name), the same prefix in front of a media placeholder/label, and
 *     the multiple-numbers `[label] ` before it: `[Sales] Jane: hello`.
 *
 * ============ FIXED REASON STRINGS ONLY (hard constraint, restated) ============
 * Every string this module writes to `push_error` is one of the constants
 * below, or a fixed string `src/lib/ghl.ts` already sanitised to (HTTP
 * status int at most — finding-13 rule). No raw upstream response body is
 * ever forwarded.
 *
 * ============ THE 0048/0072 PRIVACY AMENDMENT ============ 0048 rules a
 * reply's body "must never leave the portal" — written for `kind = 'coach'`
 * tenants, where the linked number is the coach's real personal phone. This
 * module is the documented, deliberate exception for `kind = 'ghl_location'`
 * tenants ONLY (0072's migration header carries the full argument): every
 * row `getUnprocessedGhlInboundMessages` can ever return already comes from
 * a GHL-tenant fence at the SQL level, so this module structurally cannot
 * touch a coach's row.
 */
import {
  addGhlInboundMessage,
  describeInboundMediaPlaceholder,
  describeMissedCall,
  describeStoredMediaLabel,
  describeTooLargeMediaPlaceholder,
  ghlConversationProviderId,
  ghlGroupContactKey,
  isGhlDndSyncEnabled,
  setGhlContactDnd,
  refreshGhlToken,
  upsertGhlContact,
  upsertGhlGroupContact,
  type AddGhlInboundMessageResult,
  type UpsertGhlContactResult,
} from "@/lib/ghl";
import {
  resolveGhlAccessToken,
  type GhlTokenRefreshDeps,
  type GhlTokenRefreshRepo,
} from "@/lib/ghl-provider";
import { inboundNumberPrefix } from "@/lib/sending-number";
import type { GhlRepository } from "@/lib/data";
import { classifyOptOutMessage } from "@/lib/opt-out";
import type { LocationNumber, WhatsappGroup, WhatsappInboundMessage } from "@/lib/types";

/** Repo slice this module needs — `GhlTokenRefreshRepo`'s four methods (shared with `resolveGhlAccessToken`) plus this phase's own four, plus the media plan's signed-URL mint. All sessionless — driven exclusively via `webhookRepo` (the whatsapp-replies poke route and the reminders cron, neither carries a user session). */
export type GhlInboundRepo = GhlTokenRefreshRepo &
  Pick<
    GhlRepository,
    | "getGhlAccountByTenantId"
    | "getUnprocessedGhlInboundMessages"
    | "claimWhatsappInboundMessage"
    | "recordGhlInboundPushFailure"
    | "resolveGhlInboundMessage"
    | "createWhatsappMediaSignedUrl"
    // Multiple numbers (Task 3) — the `[label] ` prefix and per-contact
    // stickiness (see `processGhlInboundRow`'s steps 4 and 5).
    | "listLocationNumbers"
    | "recordInboundForStickiness"
    // Opt-in groups (0007) — the row's group, and its GHL contact once made.
    | "listWhatsappGroups"
    | "setWhatsappGroupContact"
    // Reliability (W10) — STOP/START opt-outs.
    | "recordOptOut"
    | "clearOptOut"
  >;

/**
 * The two real GHL network calls, the token refresh, and the Slack alert,
 * injected exactly like `GhlProviderDeps` (`src/lib/ghl-provider.ts`) so
 * `scripts/test/ghl-inbound.test.ts` can exercise every branch below with
 * fakes — no network, no real GHL account, ever (hard constraint). Extends
 * `GhlTokenRefreshDeps` rather than duplicating its three fields.
 */
export interface GhlInboundDeps extends GhlTokenRefreshDeps {
  upsertContact: (accessToken: string, locationId: string, phoneE164: string) => Promise<UpsertGhlContactResult>;
  /** Opt-in groups — creates (or finds) the one GHL contact standing for a group. */
  upsertGroupContact: (accessToken: string, locationId: string, input: { name: string; groupKey: string }) => Promise<UpsertGhlContactResult>;
  addInboundMessage: (
    accessToken: string,
    input: { contactId: string; conversationProviderId: string; body: string; timestampIso?: string; attachments?: string[] }
  ) => Promise<AddGhlInboundMessageResult>;
  /** T10 — only called when `GHL_SYNC_DND === "true"`. */
  setContactDnd: (accessToken: string, contactId: string, dnd: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export const defaultGhlInboundDeps: GhlInboundDeps = {
  upsertContact: upsertGhlContact,
  upsertGroupContact: upsertGhlGroupContact,
  addInboundMessage: addGhlInboundMessage,
  setContactDnd: setGhlContactDnd,
  refreshToken: refreshGhlToken,
  refreshWaitMs: 1000,
  // Same runtime-import rationale as `defaultGhlProviderDeps` — see that
  // constant's own JSDoc (src/lib/ghl-provider.ts) for why this is not a
  // top-level `@/lib/slack` import.
  notify: (text) => {
    void import("@/lib/slack").then((m) => m.notifyText(text));
  },
};

/** Plan §Q5's "at 5: claim + stamp resolution = 'ghl_push_failed'" bound. */
const MAX_PUSH_ATTEMPTS = 5;
/** Plan §Q4/`processInboundWhatsappReplies`'s `DRAIN_BATCH_CAP` convention. */
const DRAIN_BATCH_CAP = 50;
/** Plan §Q5's final row — abort the pass rather than burn every remaining row's attempt budget against one live GHL outage. */
const CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES = 5;

// ---------------------------------------------------------------------------
// Fixed reason strings (hard constraint — see file header).
// ---------------------------------------------------------------------------

const REASON_PUSH_EXHAUSTED = "could not deliver this WhatsApp reply to GHL after repeated attempts";
const REASON_NO_ACCESS_TOKEN = "no valid GHL access token available to push this reply";
const REASON_ACCOUNT_NOT_FOUND = "GHL account for this WhatsApp session not found";
/** Global constraint, verbatim — the same string the outbound side refuses with. */
const REASON_GROUP_NOT_ENABLED = "WhatsApp group sync is turned off for this group";

export const GHL_INBOUND_REASONS = {
  pushExhausted: REASON_PUSH_EXHAUSTED,
  noAccessToken: REASON_NO_ACCESS_TOKEN,
  accountNotFound: REASON_ACCOUNT_NOT_FOUND,
  groupNotEnabled: REASON_GROUP_NOT_ENABLED,
} as const;

/** Terminal resolution for a group row whose group is unknown or switched off — never posted to GHL. */
export const GROUP_NOT_ENABLED_RESOLUTION = "group_not_enabled";

/**
 * A missed call older than this when the drain reaches it is resolved without
 * posting (`MISSED_CALL_STALE_RESOLUTION`), so a reconnect after a long outage
 * never sets off a very late GHL text-back workflow.
 */
export const MISSED_CALL_STALE_MS = 6 * 60 * 60 * 1000;
/** Terminal resolution for a missed call older than `MISSED_CALL_STALE_MS` — never posted to GHL. */
export const MISSED_CALL_STALE_RESOLUTION = "missed_call_stale";

export interface DrainGhlInboundRepliesResult {
  /** Unprocessed GHL-tenant rows this pass looked at (capped at `DRAIN_BATCH_CAP`) — `0` whenever `blockedUnconfigured` is `true`, since the list is never even read in that case. */
  candidates: number;
  /** Successfully pushed to GHL this pass — `resolution: 'ghl_pushed'`. */
  pushed: number;
  /** Terminally refused by GHL (a definite non-2xx that isn't 429/5xx) — `resolution: 'ghl_rejected'`. */
  rejected: number;
  /** Terminally given up on — either the push itself exhausted its retry budget, or a pre-existing row was already exhausted when listed — `resolution: 'ghl_push_failed'`. */
  failed: number;
  /** The one ambiguous terminal outcome — a timed-out POST, never retried — `resolution: 'ghl_push_uncertain'`. */
  uncertain: number;
  /** Retryable failures this pass (contact upsert, POST 429/5xx, or no usable access token) — left for a later pass, bounded by `push_attempts`. */
  retried: number;
  /** Rows this pass lost the claim race on (another poke/cron pass already claimed it) — untouched, no error. */
  claimLost: number;
  /** Group rows whose group is unknown or switched off — `resolution: 'group_not_enabled'`, never posted. */
  groupNotEnabled: number;
  /** Missed calls older than `MISSED_CALL_STALE_MS` — `resolution: 'missed_call_stale'`, never posted. */
  staleMissedCalls: number;
  /** Rows this pass whose text was a STOP-type keyword and recorded an opt-out (idempotent, so a retried row can count again). */
  optedOut: number;
  /** Rows this pass whose text was a START-type keyword and cleared an opt-out. */
  optedIn: number;
  /** `true` iff `GHL_CONVERSATION_PROVIDER_ID` is unset — see this file's STEP 0 note. Every other counter is `0` when this is `true`. */
  blockedUnconfigured: boolean;
}

/**
 * Mutable, per-pass — see this file's CIRCUIT BREAKER note. Kept as a tiny
 * object (not a return-value threading exercise) so `processGhlInboundRow`
 * can update it directly.
 *
 * TWO SEPARATE COUNTERS, ONE PER GHL ENDPOINT (adversarial-review finding 2
 * fix): a single shared counter that resets on ANY success masks an
 * endpoint-specific outage. `upsertGhlContact` and `addGhlInboundMessage`
 * are different endpoints with independent failure modes — the normal case
 * is DISTINCT phones per row, so every row calls upsert fresh (no memo hit).
 * If only the messages endpoint is down, each row's sequence is
 * upsert-succeeds (would reset a shared counter to 0) THEN post-fails
 * (+1) — a shared counter never climbs past 1 and the breaker never trips,
 * burning every listed row's attempt budget against one outage (confirmed
 * by a fixture: 10 distinct-phone rows, upsert always ok, POST always 503 ->
 * 10 POSTs, not 5). Tracking the two endpoints separately means a contact-
 * upsert success can only ever reset the upsert counter, never the post
 * counter, so 5 consecutive POST failures still trip the breaker regardless
 * of how many (unrelated) upserts succeeded in between.
 */
interface CircuitBreakerState {
  consecutiveContactUpsertFailures: number;
  consecutivePostFailures: number;
}

/** `true` once EITHER endpoint has failed `CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES` times in a row. */
function breakerTripped(breaker: CircuitBreakerState): boolean {
  return (
    breaker.consecutiveContactUpsertFailures >= CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES ||
    breaker.consecutivePostFailures >= CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES
  );
}

/**
 * The one drain this phase runs — see this file's header for the full
 * per-row sequence and the retry table. Never throws; every failure (the
 * top-level list read, or one row's own pipeline) is caught and logged here,
 * mirroring `processInboundWhatsappReplies`/`drainGhlOutboundStatuses`'s
 * identical never-throws contract.
 */
export async function drainGhlInboundReplies(
  repo: GhlInboundRepo,
  deps: GhlInboundDeps = defaultGhlInboundDeps
): Promise<DrainGhlInboundRepliesResult> {
  const result: DrainGhlInboundRepliesResult = {
    candidates: 0,
    pushed: 0,
    rejected: 0,
    failed: 0,
    uncertain: 0,
    retried: 0,
    claimLost: 0,
    groupNotEnabled: 0,
    staleMissedCalls: 0,
    optedOut: 0,
    optedIn: 0,
    blockedUnconfigured: false,
  };

  const envProviderId = ghlConversationProviderId();
  if (!envProviderId) {
    console.error("[ghl-inbound] GHL_CONVERSATION_PROVIDER_ID is not configured — inbound push drain no-op this pass.");
    result.blockedUnconfigured = true;
    return result;
  }

  let rows: WhatsappInboundMessage[] = [];
  try {
    rows = await repo.getUnprocessedGhlInboundMessages(DRAIN_BATCH_CAP);
  } catch (err) {
    console.error("[ghl-inbound.drainGhlInboundReplies] failed to list unprocessed GHL-tenant rows (non-fatal):", err);
    return result;
  }
  result.candidates = rows.length;
  if (rows.length === 0) return result;

  const memos: PassMemos = { contactIdByKey: new Map(), numbersByLocation: new Map(), groupsByTenant: new Map() };
  const breaker: CircuitBreakerState = { consecutiveContactUpsertFailures: 0, consecutivePostFailures: 0 };

  for (const row of rows) {
    if (breakerTripped(breaker)) {
      console.error(
        `[ghl-inbound.drainGhlInboundReplies] aborting pass after ${CIRCUIT_BREAK_AFTER_CONSECUTIVE_FAILURES} consecutive GHL-call failures on one endpoint (contact upserts: ${breaker.consecutiveContactUpsertFailures}, message posts: ${breaker.consecutivePostFailures}) — remaining row(s) left untouched for the next pass.`
      );
      break;
    }
    try {
      await processGhlInboundRow(repo, deps, row, envProviderId, memos, result, breaker);
    } catch (err) {
      console.error(`[ghl-inbound.drainGhlInboundReplies] row ${row.id} failed unexpectedly (non-fatal):`, err);
      result.retried++;
    }
  }

  return result;
}

/**
 * Per-pass memos, all efficiency-only and never kept beyond one pass (a
 * number added or relabelled, or a group switched on or off, shows up on the
 * very next pass). Only successful reads are cached, so a throw is retried by
 * the next row too.
 */
interface PassMemos {
  /** Per-(tenant, phone) contact id — the upsert is safe to call twice regardless (step 2). */
  contactIdByKey: Map<string, string>;
  /** Multiple numbers (Task 3) — per-location number list (a batch is typically many rows for few locations). */
  numbersByLocation: Map<string, LocationNumber[]>;
  /** Opt-in groups — per-tenant group rows. A group contact created this pass is written into its entry, so later rows reuse it. */
  groupsByTenant: Map<string, WhatsappGroup[]>;
}

/**
 * Classify one inbound text and persist the opt-out / opt-in for that
 * (tenant, number). Whole-message keyword match only (`classifyOptOutMessage`).
 * Idempotent: recording an opt-out twice or clearing an absent one is
 * harmless, so a row retried after a failed GHL push is safe. The message
 * itself is still delivered to GHL by the caller.
 *
 * Opt-in groups (merge ruling): a GROUP row (`groupJid` set) is never
 * classified — a member typing "STOP" in a group the owner opted into is
 * talking to the group, not opting out of the business's one-to-one
 * messages. Multiple numbers: the opt-out is STORED on the number it arrived
 * on; the outbound check applies it across the location's numbers
 * (`optedOutReason`, src/lib/ghl-provider.ts), and a START clears it on
 * every number of the location (`processGhlInboundRow`).
 */
export async function applyOptOutKeyword(
  repo: Pick<GhlInboundRepo, "recordOptOut" | "clearOptOut">,
  row: WhatsappInboundMessage,
  ghlContactId: string | null
): Promise<"opt_out" | "opt_in" | null> {
  if (row.groupJid != null) return null;
  // A missed-call event is not text the contact typed.
  if (row.eventKind === "missed_call") return null;
  const decision = classifyOptOutMessage(row.body);
  if (!decision) return null;
  if (decision.kind === "opt_out") {
    await repo.recordOptOut({ tenantId: row.coachId, phone: row.fromPhone, keyword: decision.keyword, ghlContactId });
    return "opt_out";
  }
  await repo.clearOptOut(row.coachId, row.fromPhone);
  return "opt_in";
}

/** One row's full pipeline — see this file's header for the sequence and retry table. */
async function processGhlInboundRow(
  repo: GhlInboundRepo,
  deps: GhlInboundDeps,
  row: WhatsappInboundMessage,
  envProviderId: string,
  memos: PassMemos,
  result: DrainGhlInboundRepliesResult,
  breaker: CircuitBreakerState
): Promise<void> {
  // Exhaustion pre-check — mirrors `src/lib/ghl-provider.ts`'s
  // `drainPendingSend` exhaustion branch exactly (Phase 1-2 finding 1's own
  // fix shape). A row that has already failed `MAX_PUSH_ATTEMPTS` times sits
  // un-claimed (`processed_at` still null, so it keeps being listed) — this
  // is what actually stops it retrying forever, WITHOUT ever calling GHL
  // again. Does not touch the circuit breaker — no GHL call was made.
  if (row.pushAttempts >= MAX_PUSH_ATTEMPTS) {
    const claimed = await repo.claimWhatsappInboundMessage(row.id);
    if (!claimed) {
      result.claimLost++;
      return;
    }
    await repo.resolveGhlInboundMessage(row.id, { resolution: "ghl_push_failed", pushError: REASON_PUSH_EXHAUSTED });
    result.failed++;
    return;
  }

  // A missed call that is too old (the bridge was offline, or this drain was
  // stalled) is resolved without posting: a text-back hours later would be
  // worse than none. No GHL call, so the circuit breaker is untouched.
  if (row.eventKind === "missed_call" && Date.now() - Date.parse(row.receivedAt) > MISSED_CALL_STALE_MS) {
    const claimed = await repo.claimWhatsappInboundMessage(row.id);
    if (!claimed) {
      result.claimLost++;
      return;
    }
    await repo.resolveGhlInboundMessage(row.id, { resolution: MISSED_CALL_STALE_RESOLUTION, pushError: null });
    result.staleMissedCalls++;
    return;
  }

  // Opt-in groups — resolve the row's group by the ROW's tenant (the number
  // the message arrived on). Unknown or switched off: never reaches GHL. A
  // `groupJid` of any value (even an empty string) takes this path, so a
  // group row can never fall through to the one-to-one path below.
  let group: WhatsappGroup | null = null;
  if (row.groupJid != null) {
    group = await findRowGroup(repo, row.coachId, row.groupJid, memos.groupsByTenant);
    if (!group || !group.enabled) {
      const claimed = await repo.claimWhatsappInboundMessage(row.id);
      if (!claimed) {
        result.claimLost++;
        return;
      }
      await repo.resolveGhlInboundMessage(row.id, { resolution: GROUP_NOT_ENABLED_RESOLUTION, pushError: REASON_GROUP_NOT_ENABLED });
      result.groupNotEnabled++;
      return;
    }
  }

  // STOP/START: persist the opt-out before any GHL call or claim, so it holds
  // even if the push below fails; idempotent, so a retried row is harmless.
  // Never for a group row (`applyOptOutKeyword`).
  const optOutOutcome = await applyOptOutKeyword(repo, row, null);
  if (optOutOutcome === "opt_out") result.optedOut++;
  else if (optOutOutcome === "opt_in") result.optedIn++;

  // PUSH_ATTEMPTS LOST-UPDATE UNDER CONCURRENT PASSES (adversarial-review
  // finding 3, accepted — same call Phase 1-2 already made for
  // `send_attempts` in `src/lib/ghl-provider.ts`'s `drainPendingSend`, see
  // that file's own "Adversarial-review finding 8" comment): every
  // `recordGhlInboundPushFailure` call below writes `row.pushAttempts + 1`
  // computed from THIS pass's own list snapshot, and `recordGhlInboundPushFailure`
  // (src/lib/data/supabase.ts) is a blind write, not an atomic increment —
  // PostgREST cannot express `push_attempts = push_attempts + 1` in a plain
  // PATCH (only a Postgres RPC could, and that's a new function + migration
  // purely to tighten a counter that only ever gates "how many more times
  // might we retry," never "did this push happen"). Two overlapping passes
  // that both listed a row at `pushAttempts = N` can each stamp `N + 1`, so
  // the 5-attempt bound can stretch under repeated poke+cron overlap.
  // Harmless to at-most-once: every actual POST is still claim-guarded (this
  // counter never gates whether a message gets sent, only how long a
  // permanently-failing row keeps being retried before it terminalises).
  const account = await repo.getGhlAccountByTenantId(row.coachId);
  if (!account) {
    // Structurally shouldn't happen — the list query only ever returns rows
    // for a tenant an ACTIVE ghl_accounts row currently claims. Defensive:
    // treat like any other retryable failure rather than crash-loop or drop
    // the row silently.
    await repo.recordGhlInboundPushFailure(row.id, { attempts: row.pushAttempts + 1, pushError: REASON_ACCOUNT_NOT_FOUND, unclaim: false });
    result.retried++;
    return;
  }

  const accessToken = await resolveGhlAccessToken(repo, deps, account);
  if (!accessToken) {
    await repo.recordGhlInboundPushFailure(row.id, { attempts: row.pushAttempts + 1, pushError: REASON_NO_ACCESS_TOKEN, unclaim: false });
    result.retried++;
    return;
  }

  // Plan §Q1 — the location's own override wins when set; today no writer
  // ever sets it (0069), so this is always `envProviderId` in practice.
  const conversationProviderId = account.conversationProviderId ?? envProviderId;

  // Step 2 — upsert contact, PRE-CLAIM, idempotent (plan §Q2/§Q4). A group
  // row uses the group's contact instead (created on its first message, and
  // stored before the claim and post); the sender is never upserted.
  const memoKey = `${row.coachId}:${row.fromPhone}`;
  let contactId = group ? group.ghlContactId : (memos.contactIdByKey.get(memoKey) ?? null);
  if (!contactId) {
    const upsert = group
      ? await deps.upsertGroupContact(accessToken, account.locationId, { name: group.name, groupKey: ghlGroupContactKey(group.groupJid, group.tenantId) })
      : await deps.upsertContact(accessToken, account.locationId, row.fromPhone);
    if (!upsert.ok) {
      breaker.consecutiveContactUpsertFailures++;
      await repo.recordGhlInboundPushFailure(row.id, { attempts: row.pushAttempts + 1, pushError: upsert.error, unclaim: false });
      result.retried++;
      return;
    }
    // Resets ONLY the upsert counter — never the post counter (finding 2 fix,
    // see CircuitBreakerState's JSDoc). A healthy contacts endpoint says
    // nothing about the messages endpoint's health.
    breaker.consecutiveContactUpsertFailures = 0;
    contactId = upsert.contactId;
    if (group) {
      // Stored BEFORE anything is posted to it: a throw here leaves the row
      // un-claimed for the next pass, and GHL's upsert dedupes on the group's
      // placeholder email, so that retry gets the same contact back. The key
      // is per number (`ghlGroupContactKey`), so the same group on another of
      // the location's numbers is a separate contact.
      await repo.setWhatsappGroupContact(group.tenantId, group.groupJid, contactId);
      group.ghlContactId = contactId;
    } else {
      memos.contactIdByKey.set(memoKey, contactId);
    }
  }

  // Multiple numbers (Task 3) — read PRE-CLAIM, like the upsert: a failure
  // here throws to `drainGhlInboundReplies`'s per-row catch with the row
  // still un-claimed, so it is simply retried next pass (never pushed
  // without knowing which number it came in on). `row.coachId` — the number
  // this reply actually arrived on — is what the prefix describes, never
  // `account.tenantId` (the location's DEFAULT number, whichever number the
  // row came from — see `getGhlAccountByTenantId`'s JSDoc).
  // Memoised per location for this pass (`memos.numbersByLocation`); only a
  // successful read is cached, so a throw is retried by the next row too.
  let locationNumbers = memos.numbersByLocation.get(account.locationId);
  if (!locationNumbers) {
    locationNumbers = await repo.listLocationNumbers(account.locationId);
    memos.numbersByLocation.set(account.locationId, locationNumbers);
  }
  const numberPrefix = inboundNumberPrefix(locationNumbers, row.coachId);

  // Multiple numbers × STOP (merge ruling): the outbound check blocks a
  // contact opted out on ANY of the location's numbers, so a START must
  // clear the opt-out on every one of them, not only the number it arrived
  // on (already cleared in `applyOptOutKeyword`). Idempotent, pre-claim.
  if (optOutOutcome === "opt_in") {
    for (const n of locationNumbers) {
      if (n.tenantId !== row.coachId) await repo.clearOptOut(n.tenantId, row.fromPhone);
    }
  }

  // T10 — optional DND mirror (GHL_SYNC_DND, off by default). Never blocks the
  // opt-out (already persisted above) or the push; failures are logged only.
  if (optOutOutcome && isGhlDndSyncEnabled()) {
    try {
      const dnd = await deps.setContactDnd(accessToken, contactId, optOutOutcome === "opt_out");
      if (!dnd.ok) console.error(`[ghl-inbound] DND sync failed (non-fatal): ${dnd.error}`);
      if (optOutOutcome === "opt_out") await applyOptOutKeyword(repo, row, contactId); // idempotent; records the contact id
    } catch (err) {
      console.error("[ghl-inbound] DND sync threw (non-fatal):", err instanceof Error ? err.message : "unknown error");
    }
  }

  // Step 3 — atomic claim, reused verbatim from the coach drain (see this
  // file's header's CLAIM-VS-NO-CLAIM ASYMMETRY note).
  const claimed = await repo.claimWhatsappInboundMessage(row.id);
  if (!claimed) {
    result.claimLost++;
    return;
  }

  // Step 4 — POST the message. Plan §Q6 (text/placeholder), extended by the
  // media plan (docs/MEDIA-PLAN.md §6.2) for a row whose media was actually
  // captured. `resolveMediaAttachment` is the ONLY new branch here — a text
  // row (`row.body` set) is completely untouched, and `media_status` is
  // `null`/`undefined` for EVERY coach-tenant row and every row written
  // while `WA_MEDIA_INBOUND_ENABLED` was off, in which case this collapses
  // to exactly Q6's original placeholder-only behaviour.
  // A missed call carries a fixed string and never touches media resolution.
  const { body, attachments } =
    row.eventKind === "missed_call"
      ? { body: describeMissedCall(row.messageType), attachments: undefined }
      : row.body !== null
        ? { body: row.body, attachments: undefined }
        : await resolveMediaAttachment(repo, row);
  const post = await deps.addInboundMessage(accessToken, {
    contactId,
    conversationProviderId,
    // Multiple numbers (Task 3) — `[label] ` / `[Number N] ` when the
    // location has more than one number (media placeholders/labels
    // included), else "" so a single-number location's body is byte-for-byte
    // unchanged. No truncation needed: this module never length-caps the
    // body it posts (GHL takes the reply as-is), and the prefix is at most a
    // 40-char label (0006's CHECK) plus brackets. A group row adds its
    // sender after it: `[Sales] Jane: hello`.
    body: numberPrefix + (group ? `${groupSenderLabel(row)}: ` : "") + body,
    timestampIso: row.receivedAt,
    attachments,
  });

  if (post.ok) {
    breaker.consecutivePostFailures = 0;
    await repo.resolveGhlInboundMessage(row.id, { resolution: "ghl_pushed", pushError: null });
    result.pushed++;
    // Not for a group contact: it belongs to its group's number, and the
    // sender is not a contact at all.
    if (!group) await recordStickiness(repo, account.locationId, contactId, row);
    return;
  }

  breaker.consecutivePostFailures++;

  if (post.kind === "timeout_uncertain") {
    // At-most-once (plan §Q5's one genuinely ambiguous outcome) — TERMINAL,
    // NEVER retried. Row stays claimed.
    await repo.resolveGhlInboundMessage(row.id, { resolution: "ghl_push_uncertain", pushError: post.error });
    deps.notify(
      `A WhatsApp reply push to GHL location ${account.locationId} (${account.label}) timed out — outcome uncertain, check that GHL conversation by hand (row ${row.id}).`
    );
    result.uncertain++;
    return;
  }

  if (post.kind === "rejected") {
    // Terminal — a definite non-429/5xx refusal fails identically on retry.
    await repo.resolveGhlInboundMessage(row.id, { resolution: "ghl_rejected", pushError: post.error });
    result.rejected++;
    return;
  }

  // rate_limited / server_error / unauthorized — retryable, POST-stage. The
  // row WAS claimed just above — must UN-CLAIM so a later pass can retry it.
  // `unauthorized` (final cross-phase review finding 6) is a 401/403 on this
  // exact POST: `resolveGhlAccessToken` above already believed the token was
  // fresh, so this means it was invalidated between that check and this
  // request (a concurrent re-auth, a clock-skew edge, an in-flight
  // rotation) — not that GHL will refuse this message forever. A later pass
  // re-resolves the token from scratch before retrying.
  await repo.recordGhlInboundPushFailure(row.id, { attempts: row.pushAttempts + 1, pushError: post.error, unclaim: true });
  result.retried++;
}

/** Opt-in groups — the row's `whatsapp_groups` entry for its own tenant, or null. Memoised per tenant for the pass. */
async function findRowGroup(
  repo: GhlInboundRepo,
  tenantId: string,
  groupJid: string,
  groupsByTenant: Map<string, WhatsappGroup[]>
): Promise<WhatsappGroup | null> {
  let groups = groupsByTenant.get(tenantId);
  if (!groups) {
    groups = await repo.listWhatsappGroups(tenantId);
    groupsByTenant.set(tenantId, groups);
  }
  return groups.find((g) => g.groupJid === groupJid) ?? null;
}

/** Who wrote a group message: their WhatsApp display name, else their E.164 number. */
function groupSenderLabel(row: WhatsappInboundMessage): string {
  return row.senderName?.trim() || row.fromPhone;
}

/**
 * Multiple numbers (Task 3) — step 5b, only after a push that LANDED (and
 * after the row is already resolved `ghl_pushed`): this contact now sticks
 * to the number this reply arrived on, so the next outbound to them goes out
 * from it (`resolveSendingTenant`, src/lib/sending-number.ts).
 *
 *   - `row.coachId`, never `account.tenantId` — the account's tenant is the
 *     location's DEFAULT number regardless of which number the row came in
 *     on; recording it would silently re-stick every contact to the default.
 *   - `row.receivedAt` — when the contact wrote, not when this drain ran.
 *     The repository only overwrites a STRICTLY NEWER value
 *     (`shouldReplaceSticky`, plus the conditional `last_inbound_at <
 *     received_at` update in supabase.ts), so an out-of-order or replayed
 *     row drained after a newer one can never move the contact back.
 *   - Never throws: the reply is already in GHL and its row resolved — a
 *     stickiness write failing must not count the row as retried (it would
 *     never be re-pushed anyway, it is claimed). Worst case the contact
 *     keeps its previous sticky number (or the default) until their next
 *     reply.
 */
async function recordStickiness(repo: GhlInboundRepo, locationId: string, ghlContactId: string, row: WhatsappInboundMessage): Promise<void> {
  try {
    await repo.recordInboundForStickiness(locationId, ghlContactId, row.coachId, row.receivedAt);
  } catch (err) {
    console.error(`[ghl-inbound] row ${row.id} pushed, but recording the contact's sticky number failed (non-fatal):`, err);
  }
}

/**
 * Media plan (docs/MEDIA-PLAN.md §6.2) — resolves what to actually POST for
 * a non-text row (`row.body === null`). By construction, `row.mediaStatus`
 * reaching this function is one of:
 *   - `null`/`undefined`: media capture never applied (coach-tenant row, or
 *     any row written while `WA_MEDIA_INBOUND_ENABLED` was off) — Q6's
 *     original placeholder, unchanged.
 *   - `'stored'`: mint a signed URL and attach it, with the short fixed
 *     label (decision I2). A signing FAILURE (storage error, expired/missing
 *     object) degrades to the placeholder rather than blocking the row
 *     forever — the reply still reaches GHL as text, exactly the same
 *     "never lose the reply over a media hiccup" posture the rest of this
 *     module already has for every other failure mode.
 *   - `'pending'`: can ONLY be a STALE pending row reaching this point — the
 *     repo's list query (`getUnprocessedGhlInboundMessages`) already
 *     excludes any `'pending'` row younger than 10 minutes (the bridge may
 *     still be mid-download for those). A pending row this function ever
 *     sees is therefore treated exactly like `'failed'` (the bridge almost
 *     certainly died mid-capture — plan §6.1's crash-window acceptance).
 *   - `'too_large'`: the specific "we saw it, it was too big" wording (plan
 *     §6.3's table), not the generic Q6 placeholder.
 *   - `'rate_limited'`/`'failed'`: the ordinary Q6 placeholder — the abuse
 *     cap or a download/sniff/upload failure both degrade the same way a
 *     media-disabled row always has.
 */
async function resolveMediaAttachment(repo: GhlInboundRepo, row: WhatsappInboundMessage): Promise<{ body: string; attachments?: string[] }> {
  if (row.mediaStatus === "stored" && row.mediaPath) {
    const signedUrl = await repo.createWhatsappMediaSignedUrl(row.mediaPath);
    if (signedUrl) {
      return { body: describeStoredMediaLabel(row.messageType), attachments: [signedUrl] };
    }
    // Signing failed — fall through to the ordinary placeholder below rather
    // than leaving this row stuck; the file remains in storage regardless
    // (only the LINK failed to mint, not the object itself).
  }
  if (row.mediaStatus === "too_large") {
    return { body: describeTooLargeMediaPlaceholder(row.messageType) };
  }
  // null/undefined (capture never applied), 'pending' (stale — see JSDoc),
  // 'rate_limited', 'failed', or a 'stored' row whose signing just failed —
  // all collapse to the same Q6 placeholder.
  return { body: describeInboundMediaPlaceholder(row.messageType) };
}
