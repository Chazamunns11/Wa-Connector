/**
 * SessionManager — one Baileys socket per coach, plus each session's send
 * queue. This is the module that owns the four safety properties end to end:
 *
 *   SCOPING (hard rule 2): the ONLY way to send is
 *   `manager.send(coachId, …)`, and the only socket it can reach is
 *   `this.sessions.get(coachId).sock` — the coach id selects the session by
 *   map key, nothing in the request body can redirect a send onto another
 *   coach's socket. See src/server.ts for the matching route-level argument.
 *
 *   RIGHT PERSON (hard rule 3): `send()` re-validates strict E.164 (the
 *   route already did — belt and braces), and the queue worker calls
 *   `sock.onWhatsApp(number)` immediately before dispatch and sends to the
 *   JID WhatsApp itself returned — never to a JID we string-built from the
 *   number. No registered account => terminal 'not_on_whatsapp', no send.
 *
 *   ONCE (hard rule 3): the whatsapp_messages ledger row is created before
 *   anything else (idempotent accept), and the worker's atomic
 *   'accepted'->'sending' claim is the only gate to a real dispatch — see
 *   src/store.ts's claimMessage/sweepInterruptedMessages JSDoc for the
 *   crash-window analysis. `MessageRecord.dispatchAttempted` further splits
 *   a 'failed' row into "definitely never reached the wire, safe to
 *   reissue under a new key" vs "dispatch was attempted, outcome
 *   UNCERTAIN — never assume safe to retry" (see `drainQueue`).
 *
 *   PACED (hard rule 4): each session has its own SessionPacer; the worker
 *   sleeps `msUntilNextSendAllowed()` between dispatches, and `send()` now
 *   reserves budget at ACCEPT time too (`sentTodayCount() + inFlight + queued +
 *   units`), not only at dispatch time — a burst of N accepts arriving
 *   faster than the pacer can drain (e.g. an hourly cron finding 60 due
 *   steps at once) used to sail straight through the daily cap, because the
 *   cap counter only advanced on dispatch, 45-75s apart, while every queued
 *   accept saw the same stale "under cap" reading. Budget is in UNITS: a
 *   1:1 part costs 1, a group send `GROUP_SEND_CAP_UNITS` (5).
 *
 *   GROUPS (opt-in — src/groups.ts's header): a send may target an enabled
 *   WhatsApp group instead of a phone (`sendToGroup`). The JID must pass
 *   `isGroupJid` and be in the session's in-memory `enabledGroups` (loaded
 *   from `whatsapp_groups` on every 'open' and on /groups/refresh; empty —
 *   fail closed — until a load lands or after one fails). The worker swaps
 *   the `onWhatsApp` existence check for a participant check
 *   (`checkGroupMembership`, `sock.groupMetadata`) and sends to the stored
 *   JID itself, which came from WhatsApp's own group list — hard rule 3
 *   still holds. Group names and JIDs are never logged.
 *
 * CONCURRENCY (fix for "two concurrent /connect calls open two sockets"):
 * `startSession` used to check-then-await-then-write the session map with no
 * guard in between, so two overlapping calls (a double-clicked Connect
 * button, or — guaranteed on every deploy — a /connect landing during
 * `resumeAll()`) could both pass the "no session yet" check and both build a
 * live socket, because the split-brain LEASE is keyed by `instanceId`
 * (per-process), not per-attempt — a same-process race is invisible to it by
 * construction. Fixed with an in-flight promise map (`starting`) so a second
 * caller awaits the first attempt instead of racing it, plus identity checks
 * before any `sessions.delete`/`lock.release` so a stale teardown can never
 * evict a session object that has already been superseded.
 *
 * REDEPLOY SURVIVAL (fix for "a failed lease claim never retries"): Railway
 * deploys overlap (new container healthy before the old one's SIGTERM), so
 * the FIRST `resumeAll()` pass on a new instance typically loses every claim
 * to the still-live old instance. `resumeAll` used to be one-shot — a
 * `LeaseUnavailableError` was logged and never retried, so the new instance
 * ran with zero sessions until a human hit /connect for every coach by hand.
 * `resumeAll` now runs an initial sweep and then a periodic retry
 * (`attemptResumeSweep`, every `lockHeartbeatMs`) for any coach this instance
 * doesn't hold locally yet — it naturally succeeds once the old instance
 * SIGTERMs (releases immediately) or freezes past the lease TTL (stale
 * claim), so a new deploy takes over within one sweep interval of either.
 *
 * RECONNECT SURVIVAL (fix for "one failed reconnect attempt kills a session
 * forever"): the reconnect timer used to be a single `setTimeout` whose
 * failure path only logged — a transient failure (e.g. a Supabase blip
 * during `loadCreds`) permanently stranded the session with no further
 * retry, and `startSession` would keep returning that same dead object
 * forever (its early-return treats "existing, not stopping" as "already
 * running"). `scheduleReconnect` now reschedules itself on every failure
 * with the same capped exponential backoff, so retries continue
 * indefinitely until the session reconnects, the lease is lost, or the
 * manager tears it down explicitly.
 *
 * CONNECTION LIFECYCLE (Baileys 7.0.0-rc14): 'connection.update' carries
 * `{ connection, lastDisconnect, qr }`. QR strings are held IN MEMORY ONLY
 * with a ~60s TTL (a QR is a device-link grant — persisting one would let a
 * DB reader link themselves as the client's device). Close reasons are
 * mapped via the Boom error's statusCode against DisconnectReason:
 *   loggedOut (401) -> wipe creds, status 'logged_out' (human must re-link)
 *   forbidden (403) -> wipe creds, status 'banned'   (see README runbook)
 *   connectionReplaced (440) -> stop WITHOUT wiping (another web client took
 *     the session — usually our own split-brain rival; never fight it)
 *   restartRequired (515) -> immediate quiet reconnect (normal after pairing)
 *   anything else -> reconnect with exponential backoff, cap 60s — UNLESS
 *     the session has never completed pairing (no phoneNumber) and has
 *     already retried `WA_MAX_QR_RECONNECT_ATTEMPTS` times, in which case the
 *     bridge gives up rather than re-registering with WhatsApp forever for a
 *     QR nobody is scanning (see `config.maxQrReconnectAttempts`).
 *
 * INBOUND MESSAGES (Batch 1 of the reply/auto-stop/trigger package — see
 * src/inbound.ts's file header for the full filter chain and privacy
 * argument): every socket also gets a `messages.upsert` listener, wired
 * alongside `connection.update` in `openSocket` below. Every session is a
 * GHL-location tenant, so there is no ledger gate (and no per-session
 * ledger cache) — see src/inbound.ts's "NO LEDGER GATE" note.
 */
import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import type { WASocket } from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import type { Logger } from "pino";
import type { BridgeConfig } from "./config.js";
import type { BridgeStore, MessageRecord, MessageTarget, SessionStatus } from "./store.js";
import { useSupabaseAuthState } from "./auth-state.js";
import { SessionLock } from "./lock.js";
import { PendingWrites } from "./pending-writes.js";
import { SessionPacer } from "./pacing.js";
import { simulateTyping, typingDurationMs } from "./typing.js";
import { isE164 } from "./phone.js";
import {
  GROUP_SEND_CAP_UNITS,
  GROUP_SYNC_OFF_REASON,
  NOT_IN_GROUP_REASON,
  checkGroupMembership,
  isGroupJid,
  toGroupList,
  type GroupDetail,
  type GroupListEntry,
  type GroupMetadataLike,
} from "./groups.js";
import { GroupActionLimits } from "./group-limits.js";
import {
  CreateRequestCache,
  createGroup as createManagedGroup,
  getGroupDetail as getManagedGroupDetail,
  getGroupInviteLink as getManagedGroupInviteLink,
  leaveGroup as leaveManagedGroup,
  updateGroup as updateManagedGroup,
  updateGroupParticipants as updateManagedGroupParticipants,
  withRecentlyCreated,
  type CreateGroupInput,
  type CreatedGroup,
  type GroupOpContext,
  type GroupOpOutcome,
  type GroupPatch,
  type ParticipantResult,
  type ParticipantsRequest,
} from "./group-management.js";
import { processInboundBatch, type InboundMediaRef } from "./inbound.js";
import { MissedCallTracker } from "./calls.js";
import { ReceiptApplier } from "./receipts.js";
import { MediaAbuseGate } from "./media-abuse-gate.js";
import { runMediaCapture } from "./media-capture.js";
import { prepareOutboundAudio, resolveOutboundAttachment } from "./media-fetch.js";
import { buildBaileysMediaContent, extensionForMime, ftypBrandForLog, type SniffedMime } from "./media.js";
import type { TranscodeResult } from "./voice-transcode.js";
import type { PortalPoke } from "./poke.js";

/** How long a boot-interrupted 'accepted' message may wait before it is failed instead of re-enqueued — see store.sweepInterruptedMessages. */
const REQUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** In-memory QR TTL — WhatsApp rotates QRs about every 60s anyway; never serve a stale one. */
const QR_TTL_MS = 60_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/**
 * Shutdown-flush tuning (see `shutdownOneSession` and src/pending-writes.ts)
 * — module constants, not operator env vars, matching this file's existing
 * `RECONNECT_BASE_MS`/`RECONNECT_MAX_MS` style: `WA_SHUTDOWN_FLUSH_TIMEOUT_MS`
 * (src/config.ts) is the one knob an operator plausibly needs to tune for
 * their own infra; how many passes and how long a grace wait between them
 * are implementation details of `PendingWrites.flush`'s draining strategy,
 * not something a deploy-time env var should expose.
 */
/** Safety backstop for `PendingWrites.flush`'s pass loop — should be unreachable in practice (each pass only re-runs because a settling write chained a new one), but bounds the worst case regardless. */
const SHUTDOWN_FLUSH_MAX_PASSES = 10;
/** Grace wait between two consecutive empty checks in `PendingWrites.flush` — catches a write that registers a beat after `sock.end()` returns (see src/pending-writes.ts's file header). */
const SHUTDOWN_FLUSH_SETTLE_GRACE_MS = 50;
/**
 * Safety backstop for `SessionManager.shutdown()`'s teardown loop — same
 * "should be unreachable, bounds the worst case regardless" posture as
 * `SHUTDOWN_FLUSH_MAX_PASSES` above. The PRIMARY guarantee that no session
 * started during shutdown gets orphaned is `doStartSession`'s own
 * unconditional, sticky-flag-backed check immediately before `openSocket`
 * (see `SessionManager.shuttingDown`'s field JSDoc for the full argument and
 * the mutation-testing results behind it) — that guarantee does not depend
 * on this loop at all. This extra pass exists for a narrower purpose: a
 * session already sitting in `this.sessions` when the FIRST pass's snapshot
 * is taken is handled by that first pass directly; this backstop only
 * matters if some future edit lets a session slip into `this.sessions`
 * AFTER that snapshot despite `shuttingDown` already being true (bypassing
 * the earlier, non-load-bearing checks that normally prevent that insert) —
 * in which case a straggler still gets torn down within a few extra passes
 * instead of sitting orphaned until `WA_LOCK_TTL_MS` expires.
 */
const SHUTDOWN_TEARDOWN_MAX_PASSES = 3;

/** Media plan (docs/MEDIA-PLAN.md §5.3) — the caller-supplied attachment shape, exactly `{ url, fileName? }`; already validated (https, length bounds) by server.ts before this is ever constructed. */
export interface OutboundAttachment {
  url: string;
  fileName?: string;
}

/**
 * Outbound media seams (voice notes plan, Task 3). `resolveAttachment`
 * defaults to the real SSRF-guarded fetch (tests inject a fake). `transcode`
 * null or absent = voice transcoding off: main.ts passes it only when
 * WA_VOICE_TRANSCODE_ENABLED is on AND the boot probe found ffmpeg with
 * libopus, so with it off outbound audio behaves exactly as before.
 */
export interface SessionMediaDeps {
  resolveAttachment?: typeof resolveOutboundAttachment;
  transcode?: ((buf: Buffer, mime: SniffedMime) => Promise<TranscodeResult>) | null;
}

/** Media plan (docs/MEDIA-PLAN.md §5.1/§5.3) — a queued send is EITHER a text part or an attachment part, never both (mirrors the bridge API's own xor contract). */
type QueuePayload = { kind: "text"; text: string } | { kind: "attachment"; attachment: OutboundAttachment };

interface QueueItem {
  record: MessageRecord;
  payload: QueuePayload;
  /** Daily-cap units this item costs: 1 for a 1:1 part, `GROUP_SEND_CAP_UNITS` for a group send — reserved at accept time (`queuedUnits`), recorded at dispatch. */
  units: number;
}

/** Units reserved by a session's queue — what the accept-time cap check counts, so a queued group send weighs 5, not 1. Summed from the queue itself, so it can never drift from it. */
function queuedUnits(session: { queue: readonly QueueItem[] }): number {
  return session.queue.reduce((sum, item) => sum + item.units, 0);
}

/** What an error log may carry for this row: the message for a 1:1 send (as before), only the error's NAME for a group send — a Baileys message can quote the group JID, and group JIDs are never logged (src/groups.ts). */
function logSafeError(err: Error, record: MessageRecord): string {
  return record.groupJid !== null ? err.name : err.message;
}

/** True iff a ledger row's target is exactly `target` — the idempotency replay/conflict test. A phone row never matches a group target, or the other way round. */
function sameTarget(record: MessageRecord, target: MessageTarget): boolean {
  return "groupJid" in target ? record.groupJid === target.groupJid : record.groupJid === null && record.toPhone === target.toPhone;
}

interface Session {
  coachId: string;
  sock: WASocket | null;
  lock: SessionLock;
  pacer: SessionPacer;
  status: SessionStatus;
  phoneNumber: string | null;
  qr: string | null;
  qrAt: number;
  queue: QueueItem[];
  draining: boolean;
  reconnectAttempts: number;
  /** Set when the manager (not WhatsApp) is tearing the session down — suppresses the auto-reconnect in the close handler. */
  stopping: boolean;
  /**
   * Tracks every in-flight Signal key/creds write for this session (see
   * src/pending-writes.ts's file header for the incident this fixes) — MUST
   * live here, on the Session, constructed exactly ONCE in `doStartSession`,
   * and survive socket bounces like the queue/pacer do.
   * `openSocket` runs on every reconnect, so a tracker built INSIDE it
   * instead (e.g. as a local to `useSupabaseAuthState`'s caller) would be a
   * brand-new empty set each time — `shutdownOneSession`'s flush would then
   * only ever see the LATEST socket's writes, while every write issued by a
   * previous socket generation (still legitimately in flight; Baileys does
   * not wait for a write to settle before letting the socket move on) would
   * be invisible to it and get killed on shutdown regardless — silently
   * reintroducing the exact bug this whole package fixes.
   */
  pendingWrites: PendingWrites;
  /**
   * Media plan (docs/MEDIA-PLAN.md §9) — abuse-cap counters for inbound media
   * capture, constructed once per session (survives socket bounces, exactly
   * like `pendingWrites` above). Built unconditionally for every session
   * (cheap — no DB read happens until `checkAndReserve` is actually called),
   * but only ever CONSULTED when `WA_MEDIA_INBOUND_ENABLED` is true — see
   * `openSocket`'s `messages.upsert` wiring for the hard boundary
   * (docs/MEDIA-PLAN.md §2 rule 4/§8).
   */
  mediaAbuseGate: MediaAbuseGate;
  /**
   * Daily group create/add limits (src/group-limits.ts), built once per
   * session beside `mediaAbuseGate` and seeded lazily from
   * `whatsapp_group_actions`, so a socket bounce or restart keeps the day's
   * spend.
   */
  groupLimits: GroupActionLimits;
  /** Create `requestId`s seen in the last 10 minutes (src/group-management.ts) — a retried create replays, never makes a second group. */
  groupCreateRequests: CreateRequestCache;
  /** Groups this session created in the last 10 minutes (JID -> created at, ms). `loadEnabledGroups` keeps them in the enabled set until the app's record and refresh have surely landed. */
  recentlyCreated: Map<string, number>;
  /**
   * The group JIDs this number's owner has enabled (src/groups.ts) — the
   * ONLY groups inbound accepts and outbound sends to. Starts EMPTY (fail
   * closed) and is replaced wholesale by `loadEnabledGroups`, on every
   * 'open' and on /groups/refresh; a failed load empties it again.
   */
  enabledGroups: Set<string>;
  /** Generation counter for `loadEnabledGroups` — only the newest load may write `enabledGroups`, so a slow, stale read can never overwrite a fresher one. */
  enabledGroupsLoad: number;
  /** Cap units of the item the drain worker has shifted off the queue but not yet recorded (`recordSend`) or let go undispatched — counted by the accept-time reservation alongside `queuedUnits`. 0 when nothing is in flight. */
  inFlightUnits: number;
}

export type SendOutcome =
  | { kind: "accepted"; record: MessageRecord; fresh: boolean }
  | { kind: "invalid_phone" }
  | { kind: "group_not_enabled" }
  | { kind: "idempotency_conflict"; existing: MessageRecord }
  | { kind: "session_not_connected"; status: SessionStatus }
  | { kind: "daily_cap_reached"; cap: number }
  | { kind: "lease_unavailable" };

export type GroupListOutcome = { kind: "ok"; groups: GroupListEntry[] } | { kind: "session_not_connected"; status: SessionStatus } | { kind: "list_failed" };

export type GroupRefreshOutcome = { kind: "refreshed" } | { kind: "session_not_connected"; status: SessionStatus } | { kind: "refresh_failed" };

export interface SessionSnapshot {
  coachId: string;
  status: SessionStatus;
  phoneNumber: string | null;
  /** Present only while status is 'waiting_qr' AND the in-memory QR is fresh. */
  qr: string | null;
  sentToday: number;
  dailyCap: number;
  /** Items waiting in the send queue. */
  queueLength: number;
  /** Daily-cap units those queued items will cost (a group send is `GROUP_SEND_CAP_UNITS`, a 1:1 part 1). */
  queuedUnits: number;
  /** Daily-cap units of the item being dispatched right now (0 when none). */
  inFlightUnits: number;
}

/**
 * Fixed-string mapping from a Baileys/Boom close statusCode to a reason
 * safe to persist and echo over the API (hard rule 1's "never log/return
 * anything credential-adjacent" extends to never returning an upstream
 * error body at all — a Boom error can carry stanza/frame detail). The
 * three "special" codes (401/403/440) are handled with their own fixed
 * strings before this is ever consulted; this covers everything else.
 */
function disconnectReasonLabel(statusCode: number | undefined): string {
  switch (statusCode) {
    case DisconnectReason.restartRequired:
      return "restart required (normal right after device pairing)";
    case DisconnectReason.timedOut:
      return "connection timed out";
    case DisconnectReason.badSession:
      return "bad session state — device state invalid";
    case DisconnectReason.connectionLost:
      return "connection lost";
    case DisconnectReason.connectionClosed:
      return "connection closed by WhatsApp";
    case DisconnectReason.multideviceMismatch:
      return "multi-device mismatch";
    case DisconnectReason.unavailableService:
      return "WhatsApp service unavailable";
    default:
      return statusCode !== undefined ? `connection closed (code ${statusCode})` : "connection closed (reason unknown)";
  }
}

/**
 * Fixed-string mapping for a send-path failure — deliberately generic
 * rather than parsing the underlying error, because the whole point is to
 * never let an upstream error's text (which can embed request/stanza
 * detail) reach the `whatsapp_messages.error` column or an API response.
 * The raw `err.message` is still logged (not persisted, not returned) so an
 * operator can diagnose from Railway logs.
 */
function mapSendErrorReason(stage: "existence_check" | "send"): string {
  return stage === "existence_check"
    ? "could not verify WhatsApp registration before sending — not dispatched"
    : "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key";
}

/**
 * Outbound text content, with link previews deliberately, permanently OFF.
 * See README's "Why outbound messages never render link previews" for the
 * full writeup; the short version:
 *
 * Baileys only attempts preview generation
 * (`generateWAMessageContent`, node_modules/@whiskeysockets/baileys/lib/
 * Utils/messages.js) when `linkPreview` is STRICTLY `undefined` — an
 * explicit `null` skips `getUrlInfo` entirely, and the type this bridge
 * targets (`AnyRegularMessageContent`) allows exactly that:
 * `linkPreview?: WAUrlInfo | null`. We deliberately do NOT add the
 * `link-preview-js` package Baileys' own preview path depends on, because
 * doing so would make this bridge server-side FETCH ARBITRARY URLs found in
 * message TEXT — attacker-controlled, since the text is whatever the portal
 * forwarded from a client's own typing — on every single outbound send. That
 * is a brand-new SSRF / outbound-fetch surface, for a purely cosmetic
 * preview card, on a service whose entire job is holding real clients' live
 * WhatsApp sessions. Behaviour is otherwise IDENTICAL to plain `{ text }`.
 *
 * If you're reading this because you deleted `linkPreview: null` to "fix" a
 * missing preview card: don't — see test/sessions-text-content.test.ts,
 * which pins this exact decision and will fail if it's reverted.
 */
export function buildOutboundTextContent(text: string): { text: string; linkPreview: null } {
  return { text, linkPreview: null };
}

// ---------------------------------------------------------------------------
// GHL custom conversation provider, Phase 2 (docs/GHL-PROVIDER-PLAN.md, file
// list #16) — "mark terminal outcome in the store, then poke the portal"
// extracted as three small, module-level, directly-testable functions rather
// than inlined in `drainQueue` below. `drainQueue` itself needs a live
// Baileys socket to reach (see this file's header), which a unit test cannot
// construct; these three do not — they take the store and the poke as plain
// arguments, so `test/sessions-poke.test.ts` can assert "exactly one poke
// per terminal outcome, zero when unconfigured" with fakes for both, no
// Baileys involved at all. `drainQueue` calls these instead of
// `store.markMessageX` directly for the three terminal outcomes.
// ---------------------------------------------------------------------------

/** Terminal outcome: delivered. Marks the ledger row, then schedules the outbound poke (no-op if `poke` is null — see `SessionManager`'s `outboundPoke` JSDoc). */
export async function recordSent(store: BridgeStore, poke: PortalPoke | null, messageId: string, waMessageId: string | null): Promise<void> {
  await store.markMessageSent(messageId, waMessageId);
  poke?.schedule();
}

/** Terminal outcome: failed (either stage — see `mapSendErrorReason`). Marks the ledger row, then schedules the outbound poke. */
export async function recordFailed(store: BridgeStore, poke: PortalPoke | null, messageId: string, errorMessage: string, dispatchAttempted: boolean): Promise<void> {
  await store.markMessageFailed(messageId, errorMessage, dispatchAttempted);
  poke?.schedule();
}

/** Terminal outcome: recipient has no WhatsApp account. Marks the ledger row, then schedules the outbound poke. */
export async function recordNotOnWhatsapp(store: BridgeStore, poke: PortalPoke | null, messageId: string): Promise<void> {
  await store.markMessageNotOnWhatsapp(messageId);
  poke?.schedule();
}

/**
 * A session reached `connection === "open"` (first link or a reconnect).
 * Schedules the outbound poke so the portal's held-message release pass runs
 * now (src/lib/ghl-held.ts); the hourly cron is the backstop (hard rule 6).
 * No-op if `poke` is null (unconfigured).
 */
export function recordReconnected(poke: PortalPoke | null): void {
  poke?.schedule();
}

/**
 * The exact fields `shutdownOneSession` touches, and nothing else —
 * deliberately STRUCTURAL rather than importing `Session` itself, so
 * `test/sessions-shutdown.test.ts` can pin the ordering that fixes the
 * ratchet-desync incident with plain fake objects: no real `SessionLock`
 * (which needs a `BridgeStore`), no real Baileys `WASocket`, nothing that
 * would drag Supabase or a live connection into a unit test. `pendingWrites`
 * is the one exception — it's the real `PendingWrites` class, not a fake,
 * because that class is itself dependency-free and cheap to construct (see
 * its own file header), so there's nothing to gain from faking it too.
 */
export interface ShutdownableSession {
  coachId: string;
  stopping: boolean;
  sock: { end: (error: Error | undefined) => void } | null;
  pendingWrites: PendingWrites;
  lock: { release: () => Promise<void> };
}

/**
 * Graceful teardown for ONE session — extracted to module level, directly
 * testable, following the same rationale as `recordSent`/`recordFailed`/
 * `recordNotOnWhatsapp` above (this file's own
 * established pattern for "needs a live dependency `SessionManager`'s
 * private methods can't easily fake, so pull it out and take everything as
 * a plain argument instead").
 *
 * THIS IS THE FIX for the incident where a graceful shutdown killed an
 * in-flight Signal key write mid-persist, leaving the replacement
 * container's ratchet behind the real one (src/pending-writes.ts's file
 * header has the full mechanism). The order below is NON-NEGOTIABLE:
 *
 *   1. `stopping = true` — suppresses the close-handler's auto-reconnect
 *      (see `Session.stopping`'s own JSDoc); this is a manager-initiated
 *      teardown, not a network blip.
 *   2. `sock?.end()`, try/catch — stops new traffic from arriving. A
 *      throw here (socket already half-dead) must not skip the flush/
 *      release that follow; there may still be writes in flight from
 *      messages processed moments ago regardless of the socket's own state.
 *   3. `await pendingWrites.flush(...)` — waits for everything `useSupabase
 *      AuthState` (src/auth-state.ts) handed to `pending.track(...)` while
 *      the lease was still held. THIS is the step that did not exist before
 *      the incident: `sock.end()` used to be followed immediately by
 *      `lock.release()`, so any `setKeys`/`saveCreds` call still in flight
 *      at that instant got killed by the process exiting.
 *   4. Flush stats logged — counts only (`passes`/`remaining`/`timedOut`),
 *      never which keys or what they contained.
 *   5. `await lock.release()` — ONLY NOW. Flush must fully settle before
 *      `release()` is CALLED, not merely before it resolves, because
 *      `release()` drops the lock's `held` flag SYNCHRONOUSLY on entry
 *      (src/lock.ts:131) — the instant that happens, a rival instance's
 *      next claim attempt can succeed and start writing the SAME rows a
 *      still-in-flight write from this instance would then race against.
 *      The `await` on step 3 is what guarantees step 5 can never overlap
 *      it. Do NOT "optimise" this by starting the release earlier, and do
 *      NOT add a grace-period write allowance through `canWrite()` instead
 *      of this ordering — either would reopen the exact split-brain window
 *      src/auth-state.ts's write gate exists to close.
 *   6. The pre-existing "session shut down, lease released" info line —
 *      unchanged text, so log-based alerting/dashboards built against it
 *      keep working.
 */
export async function shutdownOneSession(session: ShutdownableSession, opts: { flushTimeoutMs: number }, log: Logger): Promise<void> {
  const { coachId } = session;
  session.stopping = true;
  try {
    session.sock?.end(undefined);
  } catch {
    // socket may already be gone — flush and release regardless (see JSDoc step 2).
  }

  const stats = await session.pendingWrites.flush({
    timeoutMs: opts.flushTimeoutMs,
    maxPasses: SHUTDOWN_FLUSH_MAX_PASSES,
    settleGraceMs: SHUTDOWN_FLUSH_SETTLE_GRACE_MS,
  });
  log.info({ coachId, passes: stats.passes, remaining: stats.remaining, timedOut: stats.timedOut }, "shutdown flush complete");

  // THE NON-NEGOTIABLE ORDERING — see this function's own JSDoc step 5.
  await session.lock.release();
  log.info({ coachId }, "session shut down, lease released");
}

/**
 * The exact fields `SessionManager.stopSession` touches — deliberately
 * structural, same rationale as `ShutdownableSession` above, and
 * deliberately WITHOUT a `pendingWrites` field: `stopSession` must never
 * flush (see `stopSession`'s own JSDoc — every caller has either just wiped
 * creds it would be catastrophic to resurrect, or is tearing down a session
 * whose in-flight writes are stale by definition). Omitting the field means
 * test/sessions-stop-session.test.ts can hand `stopSessionCore` a fake with
 * a THROWING `pendingWrites` getter and prove the "never flushes" invariant
 * holds at runtime, not merely at the type level where a careless edit could
 * still smuggle a flush back in through the class method wrapper.
 */
export interface StoppableSession {
  coachId: string;
  stopping: boolean;
  sock: { end: (error: Error | undefined) => void } | null;
  lock: { release: () => Promise<void> };
}

/**
 * Core of `SessionManager.stopSession` — extracted to module level, same
 * "needs a live dependency the class can't cheaply fake" rationale as
 * `shutdownOneSession` above.
 *
 * THE FIX for a second production-incident follow-up: a terminal close
 * (loggedOut/banned/connectionReplaced/QR-give-up) racing a SIGTERM.
 * `SessionManager.handleClose` checks `session.stopping` exactly once, at
 * entry. If it's already past that check and awaiting its own
 * `wipeCreds`/`persistStatus` round trip (a 1-2 Supabase RTT window) when
 * SIGTERM lands, `SessionManager.shutdown()` starts `shutdownOneSession` for
 * the SAME session CONCURRENTLY — which sets `stopping = true` itself and
 * begins ITS OWN flush. If this function then went on to unconditionally
 * release the lease once its own await chain resolved, `held` would drop
 * SYNCHRONOUSLY (src/lock.ts:131) while `shutdownOneSession`'s flush is
 * still in flight — and the replacement deploy's lease-claim poll (running
 * BECAUSE of the SIGTERM) could win the lease and start writing before those
 * tracked writes have settled. That is the exact split-brain window
 * `shutdownOneSession`'s flush exists to close, reopened from the other
 * side.
 *
 * Fix: capture whether `stopping` was ALREADY true on entry, BEFORE
 * overwriting it. If so, `shutdownOneSession` got here first for this exact
 * session and OWNS its flush and lease release — skip `lock.release()`
 * entirely and let that call finish the job. `wipe` still runs either way
 * (it is unrelated to the lease race), and this function still never
 * flushes regardless of which branch runs — see `stopSession`'s own JSDoc
 * for why a flush here specifically would be wrong, not just redundant.
 */
export async function stopSessionCore(session: StoppableSession, wipe: (() => Promise<void>) | null): Promise<void> {
  const alreadyStopping = session.stopping;
  session.stopping = true;
  try {
    session.sock?.end(undefined);
  } catch {
    // already dead — fine.
  }
  if (wipe) await wipe();
  // See this function's own JSDoc — skipping release here when
  // `alreadyStopping` is what closes the SIGTERM race.
  if (!alreadyStopping) {
    await session.lock.release();
  }
}

/**
 * The exact fields `SessionManager.teardownLocal` touches — deliberately
 * structural, same rationale as `StoppableSession` above. No `pendingWrites`
 * field, for the same "must never flush" reason (see `teardownLocal`'s own
 * JSDoc — the lease is already gone by the time `onLost` fires, so there is
 * nothing safe to wait for). No `lock` field either: `teardownLocal` never
 * releases one, since `markLost` already flipped `held` to false before this
 * ever runs.
 */
export interface LocallyTeardownable {
  coachId: string;
  stopping: boolean;
  sock: { end: (error: Error | undefined) => void } | null;
}

/**
 * Core of `SessionManager.teardownLocal` — extracted to module level, same
 * rationale as `stopSessionCore` above. The identity check
 * (`this.sessions.get(session.coachId) !== session`) deliberately stays in
 * the class method, since it needs the manager's own session map; everything
 * else — the part a future "helpful" flush could actually be added to —
 * lives here, where `LocallyTeardownable`'s missing `pendingWrites` field
 * makes that addition impossible to wire up without also widening the type.
 */
export function teardownLocalCore(session: LocallyTeardownable): void {
  session.stopping = true;
  try {
    session.sock?.end(undefined);
  } catch {
    // already dead — fine.
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** In-flight `startSession` calls per coach — collapses concurrent callers onto one attempt instead of letting them race independent socket opens (see file header). */
  private readonly starting = new Map<string, Promise<Session>>();
  private claimRetryTimer: NodeJS.Timeout | null = null;
  /** Delivered / read receipts (src/receipts.ts); null unless WA_READ_RECEIPTS_ENABLED. Shared across sessions: its keys include the coach id. */
  private readonly receipts: ReceiptApplier | null;
  readonly instanceId = crypto.randomUUID();
  /**
   * Set exactly once, at the very top of `shutdown()`, before anything else
   * in that method runs, and NEVER reset back to `false` — this flag is
   * permanent for the rest of the process's life. THE OTHER HALF of the fix
   * for the incident where a dead container's leases sat held for the full
   * `WA_LOCK_TTL_MS` (see src/main.ts's `wireGracefulShutdown` for the
   * first half — registering signal handlers before `resumeAll()` is
   * awaited). That reordering means a signal can now legitimately arrive
   * WHILE `resumeAll()` — and therefore `doStartSession` — is still in
   * flight for one or more coaches.
   *
   * THE GUARANTEE, and why it holds regardless of exact timing: because this
   * flag is STICKY (once true, stays true), a single unconditional check of
   * it ANYWHERE between "a lease might have been claimed" and "the function
   * is about to return a live session to its caller" is enough to catch a
   * shutdown that began at ANY earlier point — it does not matter whether
   * shutdown() started before `doStartSession` was even called, mid-way
   * through claiming the lease, or after the session was already sitting in
   * `this.sessions`. `doStartSession` places exactly that unconditional
   * check immediately before `await this.openSocket(session)` — the last
   * possible point before a socket (and a "connected" result) would exist —
   * and its surrounding `catch` block unconditionally cleans up (removes
   * from `this.sessions` if still present, calls `lock.release()`) for
   * ANY error thrown inside that try block, `ShuttingDownError` included.
   * That pairing (sticky flag + one mandatory late checkpoint + unconditional
   * cleanup on the thrown path) is what ACTUALLY makes orphaning impossible,
   * and it does not depend on precise interleaving timing at all.
   *
   * VERIFIED, not just argued: each guard below was mutation-tested by
   * temporarily deleting it and re-running test/sessions-shutdown-race.test.ts.
   * Deleting the pre-`openSocket` check broke 2 of the 5 tests immediately
   * (a paused `doStartSession` proceeded into REAL `useSupabaseAuthState`,
   * which threw because the test's fake store has no `loadCreds` — a fast,
   * clear failure, not a hang). Deleting the top-of-function check broke the
   * "already shut down, zero store calls" test. Deleting the check
   * immediately after `session.lock.acquire()` (see below) broke NOTHING —
   * every test still passed, because the later pre-`openSocket` check catches
   * that case too, exactly per the guarantee above.
   *
   * So why keep the earlier checks (top-of-function, immediately before
   * `lock.acquire()`, and immediately after it) if the late one is what
   * actually prevents orphaning? They are still worth having, just for a
   * different reason — EFFICIENCY and TIGHTENING, not correctness:
   *   - Top-of-function and pre-acquire: skip pointless Supabase round trips
   *     (`ensureSessionRow`/`getDailyActivity`, or a
   *     claim-then-immediately-release cycle) once shutdown is already known
   *     to have started.
   *   - Immediately after `acquire()` succeeds, before `this.sessions.set`:
   *     releases the lease and skips the interrupted-message sweep entirely
   *     rather than holding the lease through it pointlessly, AND keeps
   *     `this.sessions` from ever containing a session claimed after
   *     shutdown began — this is the ordering that determines WHICH path
   *     performs cleanup (this method's own release, vs. `shutdown()`'s
   *     `shutdownOneSession` finding it in a snapshot) but is not the sole
   *     thing standing between a claim and an orphan; the late check is.
   *
   * `attemptResumeSweep` also checks this flag on every loop iteration, not
   * just on entry, since that loop can span several `startSession` calls
   * (several Supabase round trips) and shutdown can begin partway through —
   * this too is a "stop wasting effort promptly" measure, not the thing that
   * prevents an orphan (a straggler it fails to stop still resolves safely
   * through `doStartSession`'s own late checkpoint).
   *
   * `shutdown()` additionally runs a small bounded number of extra teardown
   * passes after the first (`SHUTDOWN_TEARDOWN_MAX_PASSES`) as further
   * defense-in-depth for the ONE case none of the above covers: a session
   * that was already sitting in `this.sessions` (inserted before shutdown's
   * snapshot) is torn down by the first pass directly — no flag check
   * involved at all on that path, since `shutdownOneSession` just iterates
   * whatever the snapshot contains.
   */
  private shuttingDown = false;

  constructor(
    private readonly store: BridgeStore,
    private readonly config: BridgeConfig,
    private readonly log: Logger,
    /** Optional (hard rule 6): null when PORTAL_INBOUND_URL/WA_INBOUND_POKE_SECRET are unset — inbound replies are still written to Supabase, they just wait for the portal's hourly cron drain instead of being poked within seconds. */
    private readonly poke: PortalPoke | null = null,
    /**
     * GHL custom conversation provider, Phase 2 (docs/GHL-PROVIDER-PLAN.md,
     * file list #16) — the outbound delivery-status poke, fired right after
     * `drainQueue` reaches a terminal dispatch outcome (sent/failed/
     * not_on_whatsapp) via `recordSent`/`recordFailed`/`recordNotOnWhatsapp`
     * below. Optional, same hard-rule-6 posture as `poke`: null when
     * `PORTAL_OUTBOUND_URL` is unset — the outcome is still written to
     * `whatsapp_messages` either way; only the "tell the portal within
     * seconds" latency optimisation is gated on this.
     */
    private readonly outboundPoke: PortalPoke | null = null,
    /** Outbound media seams — see `SessionMediaDeps`. */
    private readonly mediaDeps: SessionMediaDeps = {}
  ) {
    this.receipts = config.readReceiptsEnabled ? new ReceiptApplier(store, Date.now, log) : null;
  }

  /**
   * Boot: resume every coach that already has linked creds, then keep
   * retrying (every `lockHeartbeatMs`) for any coach this instance still
   * doesn't hold locally — see the file header's REDEPLOY SURVIVAL note for
   * why a single one-shot pass is not enough on Railway's overlapping-deploy
   * model. The retry loop is cheap and self-limiting: once every resumable
   * coach is held locally, each sweep is a no-op past the initial DB list
   * read.
   */
  async resumeAll(): Promise<void> {
    await this.attemptResumeSweep();
    // shutdown() may have begun WHILE the initial sweep above was still
    // running — signal handlers are now wired up before this call is even
    // awaited (see src/main.ts's `wireGracefulShutdown`), specifically so that
    // can happen. Arming a retry timer after that would be a pure leak: it
    // would keep firing (each tick immediately no-opping against
    // `shuttingDown` in `attemptResumeSweep` below) for however long the
    // rest of an already-exiting process takes to actually exit.
    if (this.shuttingDown) return;
    this.claimRetryTimer = setInterval(() => void this.attemptResumeSweep(), this.config.lockHeartbeatMs);
    this.claimRetryTimer.unref();
  }

  private async attemptResumeSweep(): Promise<void> {
    if (this.shuttingDown) return; // see `shuttingDown`'s own JSDoc — nothing to resume once we're on the way out.
    let coachIds: string[] = [];
    try {
      coachIds = await this.store.listResumableCoachIds();
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "resume sweep: could not list resumable sessions (non-fatal, will retry)");
      return;
    }
    for (const coachId of coachIds) {
      // Checked EVERY iteration, not just on entry: this loop can span
      // several Supabase round trips (one `startSession` attempt per
      // coach), and shutdown() can begin at any point during it. Continuing
      // to claim fresh leases after that would be exactly the orphaned-lease
      // bug this whole package fixes, just triggered from the resume
      // sweep's side instead of a direct /connect call.
      if (this.shuttingDown) return;
      const existing = this.sessions.get(coachId);
      if (existing && !existing.stopping) continue; // already held locally — nothing to do this sweep.
      try {
        await this.startSession(coachId);
      } catch (err) {
        if (err instanceof LeaseUnavailableError) {
          // Expected during a normal deploy overlap — the other instance
          // still owns it. Silent; the next sweep tries again.
          continue;
        }
        if (err instanceof ShuttingDownError) {
          // shutdown() started somewhere inside this startSession attempt
          // (see `shuttingDown`'s JSDoc) — stop the whole sweep now rather
          // than looping to the next coachId, which the top-of-loop check
          // would just reject anyway.
          return;
        }
        this.log.error({ coachId, err: (err as Error).message }, "resume sweep: session start failed (non-fatal, will retry next sweep)");
      }
    }
  }

  /**
   * Start (or return the existing/in-flight) session for a coach. Called by
   * POST /sessions/:coachId/connect and by the resume sweep. If no creds
   * exist yet, the socket comes up unauthenticated and emits a QR.
   *
   * Concurrency: a second caller arriving while a first call is still
   * mid-flight (before the session object is even in `this.sessions`)
   * awaits the SAME promise rather than starting its own — see the file
   * header's CONCURRENCY note for why the split-brain lease alone cannot
   * prevent this.
   */
  async startSession(coachId: string): Promise<Session> {
    const existing = this.sessions.get(coachId);
    if (existing && !existing.stopping) return existing;

    const inFlight = this.starting.get(coachId);
    if (inFlight) return inFlight;

    const attempt = this.doStartSession(coachId).finally(() => {
      // Only clear our own attempt — a fresh call that arrived after this
      // one settled would already have installed a newer promise.
      if (this.starting.get(coachId) === attempt) this.starting.delete(coachId);
    });
    this.starting.set(coachId, attempt);
    return attempt;
  }

  private async doStartSession(coachId: string): Promise<Session> {
    // Refuse to start anything new once shutdown has begun — see
    // `shuttingDown`'s own JSDoc for the full race this guards against.
    // Checked here, before any Supabase round trip, so a /connect (or
    // resume-sweep) call arriving after shutdown starts does zero work
    // instead of doing several reads only to be rejected many awaits later.
    if (this.shuttingDown) throw new ShuttingDownError();

    await this.store.ensureSessionRow(coachId);

    const activity = await this.store.getDailyActivity(coachId);

    // Two-step construction: the lease's onLost callback must close over
    // THIS session object (not the coachId), so that teardown can check
    // identity against the map instead of blindly evicting by key — a
    // stale teardown must never delete a session that has since been
    // superseded. `session` is assigned synchronously right after the
    // literal below and before any lock callback can possibly fire.
    let session!: Session;
    session = {
      coachId,
      sock: null,
      lock: new SessionLock(
        this.store,
        coachId,
        this.instanceId,
        this.config.lockHeartbeatMs,
        this.config.lockTtlMs,
        this.log,
        () => this.teardownLocal(session)
      ),
      pacer: new SessionPacer(
        { minGapMs: this.config.sendMinGapMs, jitterMs: this.config.sendJitterMs, dailyCap: this.config.dailyCap },
        activity.attemptCount,
        undefined,
        undefined,
        activity.lastAttemptAt ? Date.parse(activity.lastAttemptAt) : null
      ),
      status: "disconnected",
      phoneNumber: null,
      qr: null,
      qrAt: 0,
      queue: [],
      draining: false,
      reconnectAttempts: 0,
      stopping: false,
      pendingWrites: new PendingWrites(),
      mediaAbuseGate: new MediaAbuseGate(this.config.inboundMediaPerSenderDaily, this.config.inboundMediaPerTenantDaily, {
        countSenderToday: (tenantId, senderPhone) => this.store.countInboundMediaAttemptsForSenderToday(tenantId, senderPhone),
        countTenantToday: (tenantId) => this.store.countInboundMediaAttemptsForTenantToday(tenantId),
      }),
      groupLimits: new GroupActionLimits(this.store, { createDaily: this.config.groupCreateDaily, addDaily: this.config.groupAddDaily }),
      groupCreateRequests: new CreateRequestCache(),
      recentlyCreated: new Map(),
      enabledGroups: new Set(),
      enabledGroupsLoad: 0,
      inFlightUnits: 0,
    };

    // Re-checked immediately before claiming — shutdown may have begun
    // during the awaits above (ensureSessionRow/getDailyActivity). No lease has been touched yet, so there is
    // nothing to release; bailing here just avoids a pointless
    // claim-then-immediately-release round trip against Supabase.
    if (this.shuttingDown) throw new ShuttingDownError();

    const gotLease = await session.lock.acquire();
    if (!gotLease) {
      // Another instance (overlapping deploy) still owns this session. Do
      // NOT open a socket. The row's status stays whatever the owner says it
      // is; our caller sees that via the DB-backed portal read. The resume
      // sweep (see resumeAll) will try again next interval.
      this.log.warn({ coachId }, "session lease held by another instance — not opening a socket here");
      throw new LeaseUnavailableError();
    }

    // Re-checked immediately after the lease is granted, before this session
    // is ever added to `this.sessions` — NOT the sole thing preventing an
    // orphaned lease (the later check right before `openSocket`, backed by
    // this flag's stickiness, is what actually guarantees that — see
    // `shuttingDown`'s own JSDoc, including the mutation-testing results
    // that showed removing THIS specific check alone breaks nothing). This
    // one is still worth having: it releases the lease immediately and skips
    // the interrupted-message sweep entirely instead of holding the lease
    // through it pointlessly, and it keeps `this.sessions` from ever
    // containing a session whose lease was claimed after shutdown began —
    // which keeps "what does shutdown() need to tear down" simple (found
    // via its own snapshot) rather than relying on the later checkpoint for
    // every single case.
    if (this.shuttingDown) {
      this.log.warn({ coachId }, "shutdown began while claiming this session's lease — releasing immediately rather than holding it through the sweep that follows");
      await session.lock.release();
      throw new ShuttingDownError();
    }

    this.sessions.set(coachId, session);

    try {
      // Boot-time interrupted-message sweep + re-enqueue (see store JSDoc).
      try {
        const requeue = await this.store.sweepInterruptedMessages(coachId, REQUEUE_MAX_AGE_MS);
        for (const record of requeue) {
          // The original body was never stored (privacy — 0046 header); an
          // interrupted 'accepted' row without its body cannot be re-sent,
          // so it is failed — dispatchAttempted=false, since these rows
          // never reached the send API — rather than delivered empty. The
          // idempotency row stays, so a future caller's retry policy can
          // reissue under a NEW key if it decides that's warranted.
          //
          // Adversarial-review finding 11: through `recordFailed`, not
          // `store.markMessageFailed` directly — a message this sweep fails
          // can belong to a GHL tenant just as easily as a coach (the store
          // treats every session key as opaque), and `recordFailed` is what
          // schedules the outbound-status poke (`this.outboundPoke`) so the
          // portal's GHL drain hears about it within seconds instead of
          // waiting up to an hour for the cron backstop. Calling the store
          // method directly here silently skipped that poke — a restart-time
          // failure was still correct (the DB row IS the terminal state),
          // just needlessly slow to reach GHL's conversation view.
          await recordFailed(
            this.store,
            this.outboundPoke,
            record.id,
            "bridge restarted before dispatch; body not retained (never stored) — reissue under a new key if still wanted",
            false
          );
        }
      } catch (err) {
        this.log.error({ coachId, err: (err as Error).message }, "interrupted-message sweep failed (non-fatal)");
      }

      // THE CHECKPOINT THAT ACTUALLY GUARANTEES NO ORPHANED LEASE — see
      // `shuttingDown`'s own JSDoc for the full argument (and the
      // mutation-testing results proving it, not just arguing it: deleting
      // this exact check is the one mutation that broke tests in
      // test/sessions-shutdown-race.test.ts). Unconditional, and reached on
      // every path through this function before a socket could ever exist —
      // whether shutdown began before this attempt started, mid-claim, right
      // after insertion, or (as tested here) while the interrupted-message
      // sweep above was in flight. If shutdown() already found this session
      // via its own `this.sessions` snapshot, `shutdownOneSession` already
      // owns (or has already finished) releasing its lease; the `catch`
      // block below still calls `lock.release()` again regardless, which is
      // a safe no-op in that case (SessionLock.release's "safe to call
      // twice" contract) and the REAL release in every other case.
      if (this.shuttingDown) throw new ShuttingDownError();

      await this.openSocket(session);
      return session;
    } catch (err) {
      // openSocket (or the sweep above) threw: this session must NOT be
      // left half-alive — wedged in the map, holding (and heartbeating) the
      // lease, with no socket and no way for a future /connect to recover
      // it (the early-return at the top of `startSession` would just hand
      // back this same dead object forever). Tear down and let the NEXT
      // /connect (or the resume sweep) start clean.
      if (!(err instanceof ShuttingDownError)) {
        // A ShuttingDownError reaching here is expected, not a failure —
        // shutdown() itself already owns (or is already finishing) this
        // session's teardown. Logging it as an ERROR would just be noise on
        // every redeploy that happens to catch a session mid-start.
        this.log.error({ coachId, err: (err as Error).message }, "session start failed — releasing lease and clearing local state");
      }
      if (this.sessions.get(coachId) === session) this.sessions.delete(coachId);
      await session.lock.release();
      throw err;
    }
  }

  /** The Baileys socket itself — split out so reconnects reuse the session object (queue, pacer, lease all survive a socket bounce). */
  private async openSocket(session: Session): Promise<void> {
    const { coachId } = session;
    const { state, saveCreds } = await useSupabaseAuthState(
      this.store,
      coachId,
      () => session.lock.isHeld(),
      session.pendingWrites,
      this.log.child({ coachId, module: "auth-state" })
    );
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as unknown as [number, number, number] }));
    // Spread `version` in only when it resolved — see the `makeWASocket`
    // call below for why `version: undefined` (as opposed to the key being
    // ABSENT) is a real bug, not a style nit.
    const versionOpt = version ? { version } : {};

    // ZOMBIE-SOCKET GUARD: `useSupabaseAuthState` and `fetchLatestBaileysVersion`
    // above are the two awaits in this function that happen BEFORE a socket
    // exists — together they're a Supabase round trip plus an external HTTP
    // call, easily tens to hundreds of ms. If SIGTERM lands anywhere in that
    // window, teardown (`shutdownOneSession`/`stopSessionCore`/
    // `teardownLocalCore` — whichever path called this session's `stopping`
    // true) runs to completion WHILE we're still suspended here: it finds
    // `session.sock === null` (this function hasn't reached line
    // `session.sock = sock` yet, so `sock?.end()` is a harmless no-op) and
    // — critically — releases this session's lease, believing teardown is
    // now complete. Without this check, `makeWASocket` below would run
    // anyway the instant these awaits resolve, opening a REAL WebSocket and
    // starting a REAL Signal handshake on creds whose lease may already be
    // held by whatever replaces this container — the exact split-brain
    // (two live sockets for the same coach) src/lock.ts's file header exists
    // to prevent, just reached via a different interleaving than the one
    // `doStartSession`'s own pre-`openSocket` `shuttingDown` check covers.
    // That check runs ONCE, synchronously right before the FIRST call to
    // `openSocket` for a session, and — with `SessionManager.shutdown()` now
    // awaiting every in-flight `doStartSession` before it ever snapshots
    // `this.sessions` (see `shutdown()`'s own JSDoc) — a whole-manager
    // shutdown racing that first call is serialised safely without ever
    // needing this guard at all. This guard is what covers everything that
    // check cannot reach:
    //   - a RECONNECT's `openSocket` call, made directly by
    //     `scheduleReconnect` on a `setTimeout` with no `doStartSession` (and
    //     therefore no `this.starting` entry `shutdown()` would wait on) in
    //     the picture at all;
    //   - a SINGLE-SESSION teardown — `logout()`, or `handleClose`'s
    //     401/403/440 branches via `stopSession` — racing either a first
    //     connect's or a reconnect's `openSocket`, entirely independent of
    //     whether the whole manager is shutting down.
    // `session.stopping` (not `this.shuttingDown`) is what catches BOTH:
    // every one of those teardown paths sets it before touching the lease.
    if (session.stopping) return;

    const sock = makeWASocket({
      // NOT `version: version ?? undefined` — that key would still be
      // PRESENT (just `undefined`-valued), and `makeWASocket`'s own default
      // merge is `{ ...DEFAULT_CONNECTION_CONFIG, ...config }` (verified
      // against this bridge's installed `lib/Socket/index.js`): an object
      // spread copies an `undefined`-valued key too, so an explicit
      // `version: undefined` OVERRIDES `DEFAULT_CONNECTION_CONFIG.version`
      // with `undefined` instead of falling through to it — the exact
      // opposite of the intended "fall back to Baileys' own pinned default
      // when the version-fetch failed" behaviour. `versionOpt` above is
      // either `{ version }` or `{}` for exactly this reason — only spreading
      // the key in when it's genuinely known leaves the library default
      // alone on a fetch failure.
      ...versionOpt,
      auth: {
        creds: state.creds,
        // Baileys' own read-through cache around our Supabase store — cuts
        // per-message key reads from N queries to ~0 once warm.
        keys: makeCacheableSignalKeyStore(state.keys, this.log.child({ coachId, module: "signal-keys" })),
      },
      // 'warn' floor regardless of LOG_LEVEL: Baileys' debug/trace logs frame
      // contents (hard rule 1 — never log anything credential-adjacent).
      logger: this.log.child({ coachId, module: "baileys" }, { level: "warn" }),
      // This bridge keeps no outbound message store of its own (foundation
      // package sends only — see src/store.ts), so `getMessage` always
      // returns `undefined`. That does NOT mean "we resend nothing on
      // decryption retry" (the old comment here, now WRONG as of 7.x) —
      // `enableRecentMessageCache` below means Baileys itself keeps a short
      // in-memory cache of every message THIS socket just sent, and consults
      // THAT before it ever calls `getMessage` at all. See that option's own
      // comment for what actually happens.
      getMessage: async () => undefined,
      // Baileys 7.x defaults this to `true` (verified against this bridge's
      // installed `lib/Defaults/index.js`) — kept EXPLICIT here, matching
      // every other socket option in this block, rather than relying on a
      // library default this file doesn't itself pin. `false` would ask the
      // phone for its FULL chat history on every fresh link; this bridge
      // never reads chat history (only `messages.upsert`'s live firehose —
      // see src/inbound.ts), so accepting it would mean paying a real
      // decrypt burst (every historical message gets Signal-decrypted just
      // to be thrown away) for zero benefit — pure cost, no upside, on a
      // socket that already has plenty of other work to do at link time.
      syncFullHistory: false,
      // KEPT ENABLED, deliberately — this is a SEPARATE, complementary piece
      // of 7.x's decrypt-failure handling, not the LID fix itself (that's
      // the `resolvePnForLid` wiring below and Baileys' own `lid-mapping`/
      // `migrateSession` machinery — see README's "Baileys version"
      // section). Do not disable this while investigating a decrypt-retry
      // issue; disabling it removes a working mitigation without touching
      // whatever the actual root cause turns out to be.
      //
      // Baileys 7.x defaults this `true` too, but it is pinned explicitly
      // here because what it does is load-bearing enough to want spelled
      // out, not inferred from a library default: it makes this SOCKET keep
      // a short-lived, in-memory-only cache (~512 messages, ~5 minute TTL —
      // `lib/Utils/message-retry-manager.js`) of every message it JUST sent,
      // keyed by (destination JID, message id). When WhatsApp's OWN client
      // asks this socket to resend because it couldn't decrypt the first
      // delivery (`SessionError: No session record at …` is exactly this —
      // the LID-machinery incident this whole upgrade exists to fix, see
      // README), Baileys checks that cache FIRST, before ever calling our
      // `getMessage` above. A hit means Baileys re-encrypts and re-sends the
      // SAME content under the SAME `key.id` entirely on its own — this
      // bridge is never asked to do anything and never even sees the retry.
      // Crucially, "same `key.id`" is why the whatsapp_messages ledger's
      // ONCE property (this file's own header) still holds: a resend
      // triggered by this cache is a redelivery ATTEMPT of a send this
      // bridge's ledger already recorded once, not a second, distinct
      // message the ledger would need to (and cannot) tell apart from the
      // first. The OLD comment here ("we resend nothing on decryption
      // retry") was true under 6.7.x, where no such cache existed and a
      // retry that `getMessage` couldn't answer just failed outright — that
      // silent failure is exactly what a client's own phone showing
      // "Waiting for this message" looks like from the outside.
      enableRecentMessageCache: true,
      markOnlineOnConnect: false, // never make the client's phone stop ringing because a robot looks "online".
    });
    session.sock = sock;

    sock.ev.on("creds.update", () => void saveCreds().catch((err) => this.log.error({ coachId, err: (err as Error).message }, "creds persist failed")));

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.qr = qr;
        session.qrAt = Date.now();
        session.status = "waiting_qr";
        void this.persistStatus(session, "waiting_qr");
      }

      if (connection === "open") {
        session.qr = null;
        session.status = "connected";
        session.reconnectAttempts = 0;
        // Baileys `me.id` is `<number>:<device>@s.whatsapp.net` — extract the number for the UI card.
        const rawId = sock.user?.id ?? "";
        const number = rawId.split(":")[0]?.split("@")[0] ?? "";
        session.phoneNumber = number ? `+${number}` : null;
        if (this.config.warmupEnabled && session.phoneNumber) {
          // Warm-up (src/pacing.ts): assume brand new until the ledger says
          // otherwise, so the window before the read lands is stricter, never
          // looser. markPhoneLinked compares against the stored number, so it
          // runs before the status write replaces it.
          session.pacer.setLinkedAt(Date.now());
          const phoneNumber = session.phoneNumber;
          void (async () => {
            await this.safely(session.coachId, async () => session.pacer.setLinkedAt(await this.store.markPhoneLinked(session.coachId, phoneNumber)));
            await this.persistStatus(session, "connected", { phoneNumber, touchLastConnected: true, disconnectReason: null });
          })();
        } else {
          void this.persistStatus(session, "connected", { phoneNumber: session.phoneNumber, touchLastConnected: true, disconnectReason: null });
        }
        // Opt-in groups (src/groups.ts): re-read the enabled set on every
        // open, so a toggle made while the socket was down still lands.
        // Never awaited; until it resolves the set stays as it was (empty on
        // a fresh session — fail closed).
        void this.loadEnabledGroups(session);
        void this.drainQueue(session);
        recordReconnected(this.outboundPoke);
      }

      if (connection === "close") {
        session.sock = null;
        session.qr = null;
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        void this.handleClose(session, statusCode);
      }
    });

    // Inbound replies (Batch 1 — see src/inbound.ts's file header for the
    // full filter chain). `processInboundBatch` is entirely self-wrapped
    // (per-message try/catch), so this handler can never throw into the
    // Baileys event loop regardless of what a malformed message or a
    // Supabase blip does downstream.
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // Media plan (docs/MEDIA-PLAN.md §2 rule 4/§8) — THE hard boundary,
      // enforced HERE in code, not as a config default: `deps.media` is only
      // ever constructed when `WA_MEDIA_INBOUND_ENABLED` is true. (PortalHub
      // also required a confirmed 'ghl_location' tenant; every session here
      // is one.)
      const media =
        this.config.mediaInboundEnabled
          ? { beginCapture: (input: { coachId: string; fromPhone: string; waMessageId: string; mediaRef: InboundMediaRef }) => this.beginMediaCapture(session, input) }
          : undefined;

      void processInboundBatch(messages, type, coachId, {
        recordInboundMessage: (input) => this.store.recordInboundMessage(input),
        schedulePoke: () => this.poke?.schedule(),
        media,
        // Baileys 7.x LID machinery (see this file's header + README's
        // "Baileys version" section) — the LAST resort for a LID-routed
        // message whose `remoteJidAlt` was absent or itself not
        // `@s.whatsapp.net`-suffixed (src/inbound.ts's `needs_lid_resolution`
        // kind). `getPNForLID` (verified against this bridge's installed
        // `lib/Signal/lid-mapping.js`) is STORE/CACHE-ONLY — an in-memory LRU
        // in front of this session's own `'lid-mapping'` auth-state rows,
        // NO USync/network round trip on a miss — which is exactly why it is
        // safe to hand straight to the inbound hot path with no extra
        // debouncing/fire-and-forget wrapper: worst case it resolves
        // instantly to `null`. Bound via an arrow (not a bare method
        // reference) so it always reads `sock` from THIS closure — a
        // reconnect's `openSocket` call installs its own fresh listener with
        // its own `sock`, so a stale reference to a previous socket's
        // repository is never possible here.
        resolvePnForLid: (lidJid) => sock.signalRepository.lidMapping.getPNForLID(lidJid),
        // Opt-in groups (src/inbound.ts "GROUPS") — read at event time, so a
        // refresh that replaced the set applies to the very next batch.
        enabledGroups: session.enabledGroups,
        log: this.log,
      }).catch((err) => {
        // processInboundBatch is itself per-message try/catch'd — this
        // outer catch exists purely so a bug in that wrapping can never
        // reach (and crash) the Baileys event loop (hard rule 6).
        this.log.error({ coachId, err: (err as Error).message }, "processInboundBatch threw unexpectedly — should be impossible");
      });
    });

    // Missed calls (src/calls.ts) — observe only, never answer or reject.
    // Subscribed only when WA_MISSED_CALLS_ENABLED is on.
    if (this.config.missedCallsEnabled) {
      const tracker = new MissedCallTracker({
        resolvePnForLid: (lidJid) => sock.signalRepository.lidMapping.getPNForLID(lidJid),
        hasRecentMissedCall: (id, phone, since) => this.store.hasRecentMissedCall(id, phone, since, this.log),
        recordInboundMessage: (input) => this.store.recordInboundMessage(input),
        schedulePoke: () => this.poke?.schedule(),
        ownPhone: () => session.phoneNumber,
        log: this.log,
      });
      sock.ev.on("call", (events) => {
        void tracker.handle(coachId, events);
      });
    }

    // Delivered / read receipts (src/receipts.ts). Subscribed only when
    // WA_READ_RECEIPTS_ENABLED is on.
    if (this.config.readReceiptsEnabled && this.receipts) {
      const receipts = this.receipts;
      sock.ev.on("messages.update", (updates) => {
        void receipts.handle(coachId, updates);
      });
    }
  }

  /**
   * Media plan (docs/MEDIA-PLAN.md §6.1) — the real-deps wiring for
   * `runMediaCapture` (src/media-capture.ts). Fire-and-forget from the
   * caller's point of view (`messages.upsert`'s `deps.media.beginCapture`,
   * via `InboundDeps` in src/inbound.ts) — `runMediaCapture` itself never
   * throws (see its own header), and this wrapper adds one more `.catch` as
   * belt-and-braces so a bug in the wiring below still can never reach the
   * Baileys event loop, matching every other handler in this file.
   */
  private beginMediaCapture(
    session: Session,
    input: { coachId: string; fromPhone: string; waMessageId: string; mediaRef: InboundMediaRef }
  ): void {
    void runMediaCapture(input, {
      checkAndReserve: (tenantId, senderPhone) => session.mediaAbuseGate.checkAndReserve(tenantId, senderPhone),
      // POLISH 12 (deliberate, not an oversight): no third `options` arg is
      // passed here, so no `reuploadRequest` is ever wired in — Baileys'
      // re-upload hook exists for media keys that have gone stale (e.g. a
      // portal-drain-time download, long after the message was received).
      // Capture here runs at RECEIPT time, inside `messages.upsert`
      // (`beginMediaCapture`'s only caller), while the media key is still
      // fresh off the wire — decision I1 in docs/MEDIA-PLAN.md §6.1 chose
      // exactly this timing FOR that reason ("download promptly or lose the
      // file"). If capture is ever moved off the receipt-time path, this
      // omission needs revisiting alongside it.
      downloadContent: (mediaRef) => downloadContentFromMessage(mediaRef.downloadable, mediaRef.kind),
      uploadObject: (path, bytes, contentType) => this.store.uploadMediaObject(this.config.mediaBucket, path, bytes, contentType),
      updateMediaStatus: (coachId, waMessageId, patch) => this.store.updateInboundMediaStatus(coachId, waMessageId, patch),
      // Same inbound poke as a genuine text reply (src/poke.ts) — "poke
      // after resolve" (plan §6.1 point 3) reuses the identical contentless
      // "drain now" signal; the portal's own drain reads media_status off
      // the row itself, no separate poke channel needed.
      poke: () => this.poke?.schedule(),
      maxBytes: this.config.inboundMediaMaxBytes,
      log: this.log,
    }).catch((err) => {
      this.log.error({ coachId: session.coachId, waMessageId: input.waMessageId, err: (err as Error).message }, "runMediaCapture threw unexpectedly — should be impossible");
    });
  }

  private async handleClose(session: Session, statusCode: number | undefined): Promise<void> {
    const { coachId } = session;
    if (session.stopping) return; // manager-initiated teardown — the initiator wrote the final status already.

    if (statusCode === DisconnectReason.loggedOut) {
      // The client unlinked us from their phone — their explicit choice.
      this.log.warn({ coachId }, "device logged out from phone — wiping creds");
      session.status = "logged_out";
      await this.safely(coachId, () => this.store.wipeCreds(coachId, "logged_out", "logged out from phone"));
      await this.stopSession(session, /* wipe */ false);
      return;
    }
    if (statusCode === DisconnectReason.forbidden) {
      // 403 = WhatsApp banned the number. Creds are dead; the human runbook
      // (README) takes over from here.
      this.log.error({ coachId }, "WhatsApp returned 403 forbidden — number banned; wiping creds");
      session.status = "banned";
      await this.safely(coachId, () => this.store.wipeCreds(coachId, "banned", "banned by WhatsApp (403)"));
      await this.stopSession(session, /* wipe */ false);
      return;
    }
    if (statusCode === DisconnectReason.connectionReplaced) {
      // Another WhatsApp Web client took over this session — either the
      // client linked a rival tool, or our own split-brain rival won. Never
      // fight over a session: stop locally, leave creds alone, record why.
      this.log.warn({ coachId }, "connection replaced by another client — stopping without wiping creds");
      session.status = "disconnected";
      await this.persistStatus(session, "disconnected", { disconnectReason: "connection replaced by another client" });
      await this.stopSession(session, /* wipe */ false);
      return;
    }

    // An unscanned QR (never successfully paired) would otherwise re-open a
    // fresh unauthenticated registration socket roughly every reconnect
    // cycle FOREVER — an external fetchLatestBaileysVersion call plus two
    // Supabase writes per cycle, indefinitely, for a coach who simply
    // hasn't scanned yet (and, at volume, a pattern that risks WhatsApp
    // rate-limiting the whole box's IP). Give up after
    // `maxQrReconnectAttempts` and require an explicit /connect to retry.
    if (session.phoneNumber === null && session.reconnectAttempts >= this.config.maxQrReconnectAttempts) {
      this.log.warn({ coachId, attempts: session.reconnectAttempts }, "giving up on an unscanned QR after max reconnect attempts — run /connect again to retry");
      session.status = "disconnected";
      await this.persistStatus(session, "disconnected", { disconnectReason: "QR not scanned after repeated attempts — run /connect again to retry" });
      await this.stopSession(session, /* wipe */ false);
      return;
    }

    // Everything else (515 restartRequired, stream errors, network blips):
    // reconnect. 515 is EXPECTED right after a QR pairing completes.
    const attempt = statusCode === DisconnectReason.restartRequired ? 0 : session.reconnectAttempts++;
    session.status = "disconnected";
    await this.persistStatus(session, "disconnected", { disconnectReason: disconnectReasonLabel(statusCode) });
    this.log.info({ coachId, statusCode, attempt }, "connection closed — reconnecting");
    this.scheduleReconnect(session, attempt);
  }

  /**
   * Schedules one reconnect attempt with capped exponential backoff, and —
   * critically — reschedules ITSELF on failure instead of giving up (see
   * the file header's RECONNECT SURVIVAL note). Only a lost lease or an
   * explicit teardown (`session.stopping`) stops the chain.
   */
  private scheduleReconnect(session: Session, attempt: number): void {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    setTimeout(() => {
      if (session.stopping || !session.lock.isHeld()) return;
      void this.openSocket(session).catch((err) => {
        this.log.error({ coachId: session.coachId, err: (err as Error).message }, "reconnect attempt failed — scheduling another retry");
        session.reconnectAttempts += 1;
        this.scheduleReconnect(session, session.reconnectAttempts);
      });
    }, delay).unref();
  }

  /**
   * The send entry point (POST /sessions/:coachId/send). Validates,
   * resolves idempotency, enqueues, kicks the drain worker.
   *
   * ORDER MATTERS (fix for two related findings):
   *   1. Idempotency lookup runs FIRST, before the connected/cap checks —
   *      previously a retry of an ALREADY-SENT message (e.g. the portal's
   *      5s client timeout fired before the 202 arrived, so a cron re-run
   *      repeats the call) could land after the session had since
   *      disconnected or hit its cap, and get told 409/429 about a message
   *      that had, in truth, already sent.
   *   2. A payload mismatch on an existing key (same idempotency key, a
   *      DIFFERENT `to`) is refused as a conflict rather than silently
   *      replaying the OLD row — without this, a corrected phone number
   *      reusing the same run id would report "accepted" while the
   *      corrected number is never actually messaged.
   *   3. Daily-cap accounting now reserves budget at ACCEPT time
   *      (`sentTodayCount() + inFlight + queued units + units`), not at dispatch only —
   *      the pacer's counter previously only advanced on dispatch (45-75s
   *      apart), so a burst of due sends arriving together (e.g. an hourly
   *      cron finding 60 due steps at once) could all see the same
   *      under-cap reading and blow straight through the daily limit
   *      before any of them had actually dispatched.
   */
  async send(coachId: string, to: string, text: string, idempotencyKey: string): Promise<SendOutcome> {
    return this.acceptAndEnqueue(coachId, { toPhone: to }, idempotencyKey, "text", { kind: "text", text });
  }

  /**
   * Opt-in groups (file header GROUPS, src/groups.ts) — `send()` to an
   * enabled WhatsApp group instead of a phone. Same accept-time contract
   * (`acceptAndEnqueue`), plus: the JID must pass `isGroupJid` and be in
   * this session's `enabledGroups`, else `group_not_enabled`; and the cap
   * reservation is `GROUP_SEND_CAP_UNITS`, not 1.
   */
  async sendToGroup(coachId: string, groupJid: string, text: string, idempotencyKey: string): Promise<SendOutcome> {
    return this.acceptAndEnqueue(coachId, { groupJid }, idempotencyKey, "text", { kind: "text", text });
  }

  /** `sendAttachment()` to an enabled group — see `sendToGroup`. */
  async sendAttachmentToGroup(coachId: string, groupJid: string, attachment: OutboundAttachment, idempotencyKey: string): Promise<SendOutcome> {
    return this.acceptAndEnqueue(coachId, { groupJid }, idempotencyKey, "media", { kind: "attachment", attachment });
  }

  /**
   * Media plan (docs/MEDIA-PLAN.md §5.3) — the attachment counterpart to
   * `send()` above, sharing the EXACT same accept-time contract (idempotency
   * replay/conflict, connected check, daily-cap reservation) via
   * `acceptAndEnqueue`. The only difference is what gets queued and,
   * therefore, what `drainQueue` does at dispatch time (fetch/sniff/map
   * before the send, vs. text going straight through). `server.ts` is the
   * ONLY caller, and only when `WA_MEDIA_OUTBOUND_ENABLED` is true — this
   * method itself has no flag check of its own (matches `send()`'s own
   * posture: validation is the route's job, this is the accept/enqueue
   * logic).
   */
  async sendAttachment(coachId: string, to: string, attachment: OutboundAttachment, idempotencyKey: string): Promise<SendOutcome> {
    return this.acceptAndEnqueue(coachId, { toPhone: to }, idempotencyKey, "media", { kind: "attachment", attachment });
  }

  /**
   * Shared accept/enqueue logic for both `send()` and `sendAttachment()` —
   * see `send()`'s own JSDoc for the three order-matters rules (idempotency
   * first, mismatch-conflict, accept-time cap reservation), which apply
   * IDENTICALLY to an attachment part: a GHL message's N attachments are N
   * separate `/send` calls from the portal's point of view (plan §5.1), each
   * with its own idempotency key, each going through this exact same path.
   */
  private async acceptAndEnqueue(
    coachId: string,
    target: MessageTarget,
    idempotencyKey: string,
    kind: "text" | "media",
    payload: QueuePayload
  ): Promise<SendOutcome> {
    // Route checked already — belt and braces (hard rule 3).
    const isGroup = "groupJid" in target;
    if (isGroup ? !isGroupJid(target.groupJid) : !isE164(target.toPhone)) {
      return isGroup ? { kind: "group_not_enabled" } : { kind: "invalid_phone" };
    }

    const existing = await this.store.getMessage(coachId, idempotencyKey);
    if (existing) {
      if (!sameTarget(existing, target)) {
        return { kind: "idempotency_conflict", existing };
      }
      return { kind: "accepted", record: existing, fresh: false };
    }

    const session = this.sessions.get(coachId);
    if (!session || session.status !== "connected" || !session.sock) {
      return { kind: "session_not_connected", status: session?.status ?? "disconnected" };
    }
    // Opt-in groups: only a group the owner enabled (and the number has not
    // left), per this session's in-memory set. After the replay check above,
    // so a retry of an already-sent group message still gets its true row.
    if (isGroup && !session.enabledGroups.has(target.groupJid)) {
      return { kind: "group_not_enabled" };
    }
    // Each part (text OR attachment) is one pacer slot; a 1:1 part is one
    // cap unit (plan §5.6 decision O3 — "the pacer must count what WhatsApp
    // counts"), a group send `GROUP_SEND_CAP_UNITS`. Queued UNITS are
    // reserved, not queue.length, so a queued group send weighs 5 — plus the
    // item the drain is mid-way through dispatching (`inFlightUnits`).
    const units = isGroup ? GROUP_SEND_CAP_UNITS : 1;
    if (session.pacer.atDailyCap() || session.pacer.sentTodayCount() + session.inFlightUnits + queuedUnits(session) + units > session.pacer.effectiveDailyCap()) {
      return { kind: "daily_cap_reached", cap: session.pacer.effectiveDailyCap() };
    }

    const { record, fresh } = await this.store.acceptMessage(coachId, idempotencyKey, target, kind);
    if (!fresh) {
      // Someone else inserted between our lookup above and this insert (a
      // genuine race, not the common case) — apply the same mismatch check.
      if (!sameTarget(record, target)) return { kind: "idempotency_conflict", existing: record };
      return { kind: "accepted", record, fresh: false };
    }

    session.queue.push({ record, payload, units });
    void this.drainQueue(session);
    return { kind: "accepted", record, fresh: true };
  }

  /**
   * The per-session queue worker. Single-flight per session (`draining`
   * flag), so ordering and pacing hold even under concurrent /send calls.
   * Every dispatch: pace-sleep -> atomic claim -> onWhatsApp existence check
   * -> send to the JID WhatsApp returned -> mark terminal status.
   *
   * Failure handling is split into two stages so `dispatchAttempted` is
   * always accurate (see `MessageRecord.dispatchAttempted`'s JSDoc):
   *   - the onWhatsApp existence check failing means the send API was NEVER
   *     invoked — `dispatchAttempted = false`, safe to reissue;
   *   - `sock.sendMessage` throwing means it WAS invoked and the outcome is
   *     unknown (the frame may have reached WhatsApp before an ack timeout,
   *     for instance) — `dispatchAttempted = true`, never safe to assume a
   *     retry won't double-deliver.
   */
  private async drainQueue(session: Session): Promise<void> {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.queue.length > 0) {
        if (session.status !== "connected" || !session.sock || !session.lock.isHeld()) return; // resume on next 'open'.

        const waitMs = session.pacer.msUntilNextSendAllowed();
        if (waitMs > 0) await sleep(waitMs);
        if (session.status !== "connected" || !session.sock) return; // state may have moved while we slept.

        const item = session.queue.shift();
        if (!item) break;
        const { record, payload, units } = item;
        // In flight from here until `recordSend(units)` moves them into
        // `sentToday` (same synchronous step) or the item exits undispatched:
        // the accept-time reservation counts these units too, so the awaits
        // below (claim, existence/membership check, attachment fetch, typing)
        // can never open a window where they are counted nowhere. The
        // `finally` clears them on EVERY exit path, `continue` included.
        session.inFlightUnits = units;
        try {
          const sock = session.sock;

          let claimed: boolean;
          try {
            claimed = await this.store.claimMessage(record.id);
          } catch (err) {
            this.log.error({ coachId: session.coachId, messageId: record.id, err: (err as Error).message }, "claim failed before dispatch");
            await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, "internal error before dispatch — not sent", false));
            continue;
          }
          if (!claimed) continue; // someone else resolved this row (boot sweep / rival) — never double-send.

          let jid: string | undefined;
          if (record.groupJid !== null) {
            // Opt-in group (file header GROUPS). The target is the stored JID
            // itself — it came from WhatsApp's own group list and passed
            // `isGroupJid` at accept — so hard rule 3 holds without
            // `onWhatsApp`. Two checks replace it, both before anything is
            // dispatched (every failure here is dispatchAttempted=false):
            //   1. still enabled — the owner may have switched the group off
            //      since this was accepted ("disabling stops outbound at once");
            //   2. our number is still a participant (`groupMetadata`).
            // Never log the group JID or name — ids only.
            const groupJid = record.groupJid;
            if (!session.enabledGroups.has(groupJid)) {
              this.log.warn({ coachId: session.coachId, messageId: record.id }, "group no longer enabled — not dispatched");
              await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, GROUP_SYNC_OFF_REASON, false));
              continue;
            }
            const membership = await checkGroupMembership(sock, groupJid);
            if (membership.kind === "check_failed") {
              // Same as a failed existence check: never reached the send API.
              // The error's name only — its message could quote the JID.
              this.log.error({ coachId: session.coachId, messageId: record.id, err: membership.err.name }, "group membership check failed");
              await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, mapSendErrorReason("existence_check"), false));
              continue;
            }
            if (membership.kind === "not_member") {
              this.log.warn({ coachId: session.coachId, messageId: record.id }, "number is no longer in the group — not dispatched");
              await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, NOT_IN_GROUP_REASON, false));
              continue;
            }
            jid = groupJid;
          } else {
            // Existence check (hard rule 3): ask WhatsApp, and send to the JID
            // IT returns — never to a JID we built by string concatenation.
            try {
              // A non-group row always has to_phone (0008's one-target CHECK).
              const results = await sock.onWhatsApp(record.toPhone ?? "");
              jid = results?.find((r) => r.exists)?.jid;
            } catch (err) {
              // The send API was never reached — safe to reissue under a new key.
              this.log.error({ coachId: session.coachId, messageId: record.id, err: (err as Error).message }, "existence check failed");
              await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, mapSendErrorReason("existence_check"), false));
              continue;
            }
            if (!jid) {
              await recordNotOnWhatsapp(this.store, this.outboundPoke, record.id);
              continue;
            }
          }

          // Media plan (docs/MEDIA-PLAN.md §5.4) — an attachment part resolves
          // (fetch + sniff + type-cap + map) HERE, after the existence check
          // and BEFORE `pacer.recordSend()` — a fetch/sniff/cap/type failure
          // never consumes a pacer slot or a `sendMessage` call, exactly
          // mirroring the existence-check failure branch just above (never
          // dispatched -> `dispatchAttempted: false`, safe to reissue).
          let messageContent: { text: string; linkPreview: null } | Record<string, unknown>;
          if (payload.kind === "text") {
            messageContent = buildOutboundTextContent(payload.text);
          } else {
            const transcode = this.mediaDeps.transcode ?? null;
            const resolveAttachment = this.mediaDeps.resolveAttachment ?? resolveOutboundAttachment;
            const resolved = await resolveAttachment(payload.attachment.url, {
              timeoutMs: this.config.mediaFetchTimeoutMs,
              voiceTranscode: transcode !== null,
              caps: {
                image: this.config.mediaMaxImageBytes,
                video: this.config.mediaMaxVideoBytes,
                audio: this.config.mediaMaxAudioBytes,
                document: this.config.mediaMaxDocumentBytes,
              },
            });
            if (!resolved.ok) {
              const reason =
                resolved.reason === "unsupported_type"
                  ? "attachment type is not supported for WhatsApp delivery"
                  : resolved.reason === "too_large_for_type"
                    ? "attachment exceeds the size limit for its type"
                    : "attachment could not be fetched";
              this.log.warn({ coachId: session.coachId, messageId: record.id, reason: resolved.reason }, "outbound attachment resolution failed — not dispatched");
              await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, reason, false));
              continue;
            }
            let content: Parameters<typeof buildBaileysMediaContent>[0] = resolved;
            // A transcode candidate's fallback is named by the bridge
            // (`voice-note.<ext>` for a webm/wav document), never by GHL —
            // except a video (`has_video`): that is the coach's file, sent as
            // a document under GHL's own name (or a generic one).
            let fileName = resolved.transcodeCandidate ? undefined : payload.attachment.fileName;
            if (resolved.transcodeCandidate && transcode !== null) {
              // Voice note (voice notes plan, Task 3): non-opus audio becomes
              // an ogg/opus voice note. Any failure, whatever its reason, sends
              // the original file instead (prepareOutboundAudio's fallback) —
              // never a failed row. Like the typing window below, the socket
              // can drop while ffmpeg runs: nothing is dispatched yet, so a
              // drop fails the row as NOT attempted (safe to reissue).
              const startedAt = Date.now();
              const prepared = await prepareOutboundAudio(resolved, { transcode });
              this.log.info(
                { coachId: session.coachId, messageId: record.id, mime: resolved.mimetype, outcome: prepared.outcome, ms: Date.now() - startedAt },
                "outbound voice note prepared"
              );
              if (session.sock !== sock || session.status !== "connected") {
                await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, "session disconnected before sending — not dispatched", false));
                continue;
              }
              // The owner may also have switched the group off while ffmpeg
              // ran ("disabling stops outbound at once") — re-check it here.
              if (record.groupJid !== null && !session.enabledGroups.has(record.groupJid)) {
                this.log.warn({ coachId: session.coachId, messageId: record.id }, "group no longer enabled — not dispatched");
                await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, GROUP_SYNC_OFF_REASON, false));
                continue;
              }
              content = prepared.content;
              if (prepared.outcome === "has_video") fileName = payload.attachment.fileName ?? `attachment.${extensionForMime(resolved.mimetype)}`;
            }
            // One line per outbound attachment (the real-device check reads it):
            // the sniffed type of the bytes GHL sent and the shape we send.
            // Never the file name, URL, bytes or a group JID.
            const ftypBrand = ftypBrandForLog(resolved.buffer, resolved.mimetype);
            this.log.info(
              {
                coachId: session.coachId,
                messageId: record.id,
                sniffedMime: resolved.mimetype,
                ...(ftypBrand !== undefined ? { ftypBrand } : {}),
                kind: content.kind,
                ptt: content.ptt === true,
              },
              "outbound attachment"
            );
            messageContent = buildBaileysMediaContent(content, fileName);
          }

          // Typing simulation (src/typing.ts) — "typing…" before a TEXT part,
          // to the JID WhatsApp returned above (or the group's own JID — a
          // person typing into a group shows as composing there too). Best effort: presence errors
          // never fail the send. The socket can drop during the window, so it
          // is re-checked after: nothing has been dispatched yet, so a drop
          // here fails the row as NOT attempted (safe to reissue), the same as
          // the existence-check failure branch above.
          if (payload.kind === "text") {
            const typingMs = typingDurationMs(payload.text, { enabled: this.config.typingIndicatorEnabled, maxMs: this.config.typingMaxMs });
            await simulateTyping(sock, jid, typingMs, sleep, (err) =>
              this.log.warn({ coachId: session.coachId, messageId: record.id, err: logSafeError(err, record) }, "typing presence update failed — sending anyway")
            );
            if (session.sock !== sock || session.status !== "connected") {
              await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, "session disconnected before sending — not dispatched", false));
              continue;
            }
          }

          session.pacer.recordSend(units); // count the ATTEMPT, in cap units (5 for a group) — see pacer JSDoc.
          session.inFlightUnits = 0; // now in sentToday — never count them twice.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Baileys' AnyMessageContent union is intentionally not re-imported into media.ts (see buildBaileysMediaContent's own JSDoc); both branches above already produce a shape Baileys accepts.
            const sent = await sock.sendMessage(jid, messageContent as any);
            await recordSent(this.store, this.outboundPoke, record.id, sent?.key?.id ?? null);
            // An ack may have beaten markMessageSent; apply it now (never throws).
            if (this.receipts && sent?.key?.id) await this.receipts.afterSent(session.coachId, sent.key.id);
          } catch (err) {
            // sendMessage WAS invoked — the frame may already be with
            // WhatsApp (e.g. an ack timeout after transmit). Never log the
            // body or the error object wholesale (Baileys errors can embed
            // frames) — message + ids only, and only a fixed reason persists.
            this.log.error({ coachId: session.coachId, messageId: record.id, err: logSafeError(err as Error, record) }, "send attempt failed");
            await this.safely(session.coachId, () => recordFailed(this.store, this.outboundPoke, record.id, mapSendErrorReason("send"), true));
          }
        } finally {
          session.inFlightUnits = 0;
        }
      }
    } finally {
      session.draining = false;
    }
  }

  /**
   * Replaces `session.enabledGroups` with the tenant's current enabled,
   * not-left groups (`store.listEnabledGroupJids`, already `isGroupJid`-
   * filtered). Generation-guarded: if a newer load started while this one
   * was in flight, this one's result is discarded. A failed read EMPTIES
   * the set (fail closed — a group switched off must stop at once, so
   * "unknown" can never mean "keep forwarding") and returns false. Never
   * throws, never logs a JID.
   */
  private async loadEnabledGroups(session: Session): Promise<boolean> {
    const generation = ++session.enabledGroupsLoad;
    try {
      const jids = await this.store.listEnabledGroupJids(session.coachId);
      const { enabled, lookupFailed } = await withRecentlyCreated(jids.filter(isGroupJid), session.recentlyCreated, Date.now(), (pending) =>
        this.store.groupRowStates(session.coachId, pending)
      );
      if (lookupFailed) this.log.error({ coachId: session.coachId }, "recently created groups could not be checked — not kept enabled by this load");
      if (session.enabledGroupsLoad === generation) session.enabledGroups = enabled;
      return true;
    } catch (err) {
      this.log.error({ coachId: session.coachId, err: (err as Error).message }, "enabled-groups load failed — group traffic dropped until the next load");
      if (session.enabledGroupsLoad === generation) session.enabledGroups = new Set();
      return false;
    }
  }

  /** POST /sessions/:coachId/groups/refresh — reloads the enabled set for a session this instance holds (any status; 'open' reloads again anyway). */
  async refreshEnabledGroups(coachId: string): Promise<GroupRefreshOutcome> {
    const session = this.sessions.get(coachId);
    if (!session) return { kind: "session_not_connected", status: "disconnected" };
    return (await this.loadEnabledGroups(session)) ? { kind: "refreshed" } : { kind: "refresh_failed" };
  }

  /**
   * GET /sessions/:coachId/groups — the groups this number is in, straight
   * from WhatsApp (`groupFetchAllParticipating`), for the owner to choose
   * from. Connected sessions only. Nothing here is stored or logged.
   */
  async listGroups(coachId: string): Promise<GroupListOutcome> {
    const session = this.sessions.get(coachId);
    if (!session || session.status !== "connected" || !session.sock) {
      return { kind: "session_not_connected", status: session?.status ?? "disconnected" };
    }
    try {
      const all = await session.sock.groupFetchAllParticipating();
      return { kind: "ok", groups: toGroupList(all as Record<string, GroupMetadataLike>) };
    } catch (err) {
      // The error's name only — a Baileys error message could quote group detail.
      this.log.error({ coachId, err: (err as Error).name }, "group list fetch failed");
      return { kind: "list_failed" };
    }
  }

  // -------------------------------------------------------------------------
  // Group management — the rules and Baileys calls live in
  // src/group-management.ts; these only resolve the session and delegate.
  // Connected sessions only.
  // -------------------------------------------------------------------------

  private groupOpContext(coachId: string): GroupOpContext | null {
    const session = this.sessions.get(coachId);
    if (!session || session.status !== "connected" || !session.sock) return null;
    return {
      coachId,
      sock: session.sock,
      groups: session,
      limits: session.groupLimits,
      createDaily: this.config.groupCreateDaily,
      inWarmup: () => session.pacer.isInWarmup(),
      store: this.store,
      createRequests: session.groupCreateRequests,
      log: this.log,
      now: Date.now,
    };
  }

  /** POST /sessions/:coachId/groups — creates a group, empty if WhatsApp allows, and adds it to the enabled set. */
  async createGroup(coachId: string, input: CreateGroupInput): Promise<GroupOpOutcome<CreatedGroup>> {
    const ctx = this.groupOpContext(coachId);
    return ctx ? createManagedGroup(ctx, input) : { kind: "session_not_connected" };
  }

  /** GET /sessions/:coachId/groups/:jid — an enabled group's settings and members. */
  async getGroupDetail(coachId: string, jid: string): Promise<GroupOpOutcome<GroupDetail>> {
    const ctx = this.groupOpContext(coachId);
    return ctx ? getManagedGroupDetail(ctx, jid) : { kind: "session_not_connected" };
  }

  /** PATCH /sessions/:coachId/groups/:jid — name, description, admins-only messages, join approval. Admins only. */
  async updateGroup(coachId: string, jid: string, patch: GroupPatch): Promise<GroupOpOutcome<null>> {
    const ctx = this.groupOpContext(coachId);
    return ctx ? updateManagedGroup(ctx, jid, patch) : { kind: "session_not_connected" };
  }

  /** POST /sessions/:coachId/groups/:jid/participants — add by phone; remove/promote/demote by member id. Admins only. */
  async updateGroupParticipants(coachId: string, jid: string, req: ParticipantsRequest): Promise<GroupOpOutcome<ParticipantResult[]>> {
    const ctx = this.groupOpContext(coachId);
    return ctx ? updateManagedGroupParticipants(ctx, jid, req) : { kind: "session_not_connected" };
  }

  /** GET /sessions/:coachId/groups/:jid/invite — the group's current invite link. Admins only. */
  async getGroupInviteLink(coachId: string, jid: string): Promise<GroupOpOutcome<{ link: string }>> {
    const ctx = this.groupOpContext(coachId);
    return ctx ? getManagedGroupInviteLink(ctx, jid) : { kind: "session_not_connected" };
  }

  /** POST /sessions/:coachId/groups/:jid/invite/reset — revokes the link and returns the new one. Admins only. */
  async resetGroupInviteLink(coachId: string, jid: string): Promise<GroupOpOutcome<{ link: string }>> {
    const ctx = this.groupOpContext(coachId);
    return ctx ? getManagedGroupInviteLink(ctx, jid, true) : { kind: "session_not_connected" };
  }

  /** POST /sessions/:coachId/groups/:jid/leave — our number leaves; the group drops out of the enabled set. */
  async leaveGroup(coachId: string, jid: string): Promise<GroupOpOutcome<null>> {
    const ctx = this.groupOpContext(coachId);
    return ctx ? leaveManagedGroup(ctx, jid) : { kind: "session_not_connected" };
  }

  /**
   * Explicit unlink (POST /sessions/:coachId/logout). Only acts if THIS
   * instance actually holds the session — previously this unconditionally
   * wiped creds/keys even when `this.sessions.get(coachId)` was undefined
   * (no local session, hence no lease held here), so an instance that
   * merely received a misrouted logout call during a deploy overlap could
   * destroy the ACTIVE owner's key material out from under it (the owner
   * would then re-write `creds_enc` moments later via its own
   * `creds.update`, leaving a row with valid-looking creds but zero Signal
   * key rows — a session that reads as healthy but can no longer decrypt).
   * A live (`confirmHeld`, not the cached flag) lease check is used because
   * this is destructive and authoritative: the ≤1-heartbeat staleness
   * window that's an acceptable trade for the frequent per-key write gate
   * (src/auth-state.ts) is not acceptable here.
   */
  async logout(coachId: string): Promise<void> {
    const session = this.sessions.get(coachId);
    if (!session) {
      // Nothing running locally for this coach on THIS instance. Do not
      // touch the row blind — if another instance genuinely owns it
      // (split-brain overlap), only its own logout call may wipe it.
      return;
    }
    const stillOurs = await session.lock.confirmHeld();
    if (!stillOurs) {
      this.teardownLocal(session);
      return;
    }
    if (session.sock) {
      try {
        await session.sock.logout();
      } catch (err) {
        this.log.warn({ coachId, err: (err as Error).message }, "sock.logout failed — wiping creds anyway");
      }
    }
    // 'logged_out' (not 'disconnected') — a deliberate unlink must read
    // differently in the portal than a network blip.
    await this.store.wipeCreds(coachId, "logged_out", "unlinked via bridge API");
    await this.stopSession(session, false);
  }

  getSnapshot(coachId: string): SessionSnapshot | null {
    const session = this.sessions.get(coachId);
    if (!session) return null;
    const qrFresh = session.qr !== null && Date.now() - session.qrAt < QR_TTL_MS;
    return {
      coachId,
      status: session.status,
      phoneNumber: session.phoneNumber,
      qr: session.status === "waiting_qr" && qrFresh ? session.qr : null,
      sentToday: session.pacer.sentTodayCount(),
      dailyCap: session.pacer.effectiveDailyCap(),
      queueLength: session.queue.length,
      queuedUnits: queuedUnits(session),
      inFlightUnits: session.inFlightUnits,
    };
  }

  /**
   * Graceful shutdown (SIGTERM): flush every session's in-flight Signal
   * key/creds writes, THEN release its lease, so the replacement deploy
   * takes over immediately (instead of waiting out the TTL) with a ratchet
   * state that actually matches what shipped — see `shutdownOneSession`'s
   * own JSDoc for the full ordering rationale.
   *
   * CONCURRENT, not sequential: 12+ sessions, each with a flush that can
   * legitimately take up to `WA_SHUTDOWN_FLUSH_TIMEOUT_MS`, cannot fit
   * inside src/main.ts's 10s hard stop if run one after another. Awaiting
   * them all together makes total shutdown time ≈ the SLOWEST single
   * session's flush, not the sum across every session on the box.
   *
   * ALSO awaits every in-flight `this.starting` promise (see the code
   * comment at `startingSettled` below for the full incident this closes)
   * — STARTED concurrently with the snapshot-based teardown loop, same
   * "concurrent, not sequential" reasoning as the loop's own
   * `Promise.allSettled` above: a coach whose `lock.acquire()` is still in
   * flight has nothing in `this.sessions` yet for the loop to find, so
   * making the loop wait on it first would serialise two unrelated waits
   * (this coach's claim round trip, and every OTHER already-connected
   * session's flush) that have no reason to block each other. Only
   * awaited — not raced, not skipped — right before this method itself can
   * resolve, which is what actually matters: without it, this method could
   * resolve — and src/main.ts's `.finally(() => process.exit(0))` fire —
   * before that claim's own release ever runs.
   *
   * `Promise.allSettled`, not `Promise.all`: one session's flush/release
   * throwing must never skip another session's lease release — a stuck
   * lease costs a rival instance up to `WA_LOCK_TTL_MS` before it can take
   * over, and the whole point of this method is to avoid making a redeploy
   * cost more than it has to.
   *
   * `this.shuttingDown = true` is set FIRST, synchronously, before ANYTHING
   * else in this method (including the `Array.from(this.sessions.values())`
   * snapshot below) — this flag is what `doStartSession`'s own guard against
   * an orphaned lease depends on being true as early as possible (see
   * `shuttingDown`'s field JSDoc for the full guarantee, including the
   * mutation-testing results pinning exactly which checkpoint is load-bearing
   * versus which are pure efficiency). Setting it late, or after an `await`,
   * would not silently reopen a hole in that guarantee (the flag is STICKY,
   * so a later `doStartSession` call still gets caught at its own
   * pre-`openSocket` checkpoint) — but it WOULD widen the window where
   * `resumeAll`/`attemptResumeSweep`/`doStartSession`'s early checks keep
   * doing pointless work believing shutdown hasn't started yet. Keep it
   * first regardless: there is no upside to moving it.
   *
   * The teardown loop below runs a SMALL BOUNDED number of extra passes
   * (`SHUTDOWN_TEARDOWN_MAX_PASSES`) past the first, tearing down anything
   * that shows up in `this.sessions` that wasn't already handled — pure
   * defense-in-depth (see that constant's own JSDoc): the happens-before
   * proof says a second pass should always find nothing, but checking again
   * costs one cheap map scan against what an orphaned lease costs.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.claimRetryTimer) {
      clearInterval(this.claimRetryTimer);
      this.claimRetryTimer = null;
    }

    // THE FIX for the incident this ENTIRE method exists to prevent, closed
    // from the one angle the rest of it does not cover: a lease claim that
    // is STILL IN FLIGHT — `session.lock.acquire()`'s UPDATE already sent to
    // Supabase, response not back yet — when SIGTERM lands.
    //
    // Walk the interleaving: `doStartSession` passes its pre-acquire
    // `shuttingDown` check, then awaits `lock.acquire()`. SIGTERM arrives
    // and this method runs. At this exact instant the session is in NEITHER
    // place this method otherwise looks: not in `this.sessions` (that
    // insert happens only after `acquire()` resolves), and not touched by
    // the teardown loop below (which only ever iterates a SNAPSHOT of
    // `this.sessions`). Without waiting on it, the loop below would find
    // nothing, finish immediately, and this method would RESOLVE — and
    // src/main.ts's `shutdown()` closure does `.finally(() => process.exit(0))`
    // the instant this promise settles. `lock.acquire()`'s response is a
    // real Supabase round trip (a macrotask), so it has not been processed
    // yet — `doStartSession`'s post-acquire `shuttingDown` check, and the
    // `lock.release()` it would call, NEVER RUN IN THIS PROCESS. The lease
    // then sits held by a container that no longer exists until
    // `WA_LOCK_TTL_MS` expires — precisely the incident this class exists to
    // close, reopened from the one interleaving that snapshotting
    // `this.sessions` cannot see.
    //
    // The existing race test (test/sessions-shutdown-race.test.ts, "shutdown()
    // racing the lease-claim step") asserts the release CALL happens, but
    // used to do so by awaiting `manager.shutdown()` to completion BEFORE
    // ever resolving the claim — which only proved the release happens
    // EVENTUALLY, in a test process kept alive by its own `await`. Production
    // has no such await past this method: the moment it resolves, the
    // process is gone. Awaiting every in-flight `startSession` attempt
    // before THIS method can resolve is what makes "the release call
    // eventually happens" into "the release call happens before shutdown()
    // resolves, and therefore before process.exit ever fires".
    //
    // `Promise.allSettled`, not `Promise.all`: one attempt rejecting (the
    // expected, common case — every in-flight `startSession` is about to
    // reject with `ShuttingDownError` or `LeaseUnavailableError`) must never
    // stop this method from waiting on the others.
    //
    // Bounded by construction, not by an extra timeout here: every awaited
    // promise is a `doStartSession` call, and `doStartSession` has no
    // unbounded wait of its own on this path — `lock.acquire()` is one
    // Supabase round trip. This still runs inside src/main.ts's 10s hard
    // stop (`setTimeout(() => process.exit(1), 10_000)`), which remains the
    // backstop if Supabase itself hangs.
    //
    // STARTED here, AWAITED only at the very end (after the teardown loop) —
    // deliberately not `await`ed on this line. A coach stuck at
    // `lock.acquire()` has no session in `this.sessions` for the loop below
    // to find, so blocking the loop on this settling first would needlessly
    // serialise this coach's claim round trip against every OTHER already-
    // connected session's independent flush, shrinking the effective time
    // budget those flushes get inside the 10s hard stop for no reason.
    const startingSettled = Promise.allSettled(Array.from(this.starting.values()));

    const torn = new Set<Session>();
    const errors: unknown[] = [];
    for (let pass = 0; pass < SHUTDOWN_TEARDOWN_MAX_PASSES; pass++) {
      const remaining = Array.from(this.sessions.values()).filter((session) => !torn.has(session));
      if (remaining.length === 0) break;
      const outcomes = await Promise.allSettled(
        remaining.map((session) => shutdownOneSession(session, { flushTimeoutMs: this.config.shutdownFlushTimeoutMs }, this.log))
      );
      for (const [i, outcome] of outcomes.entries()) {
        torn.add(remaining[i]);
        if (outcome.status === "rejected") errors.push(outcome.reason);
      }
    }
    for (const err of errors) {
      this.log.error({ err: (err as Error)?.message }, "session shutdown failed (non-fatal — other sessions still torn down)");
    }

    const stillUntorn = Array.from(this.sessions.values()).filter((session) => !torn.has(session));
    if (stillUntorn.length > 0) {
      // Should be unreachable per `shuttingDown`'s happens-before proof —
      // logged loudly rather than silently leaving these leases held, since
      // reaching this branch means that proof's invariant broke somewhere.
      this.log.error(
        { coachIds: stillUntorn.map((session) => session.coachId), passes: SHUTDOWN_TEARDOWN_MAX_PASSES },
        "shutdown: sessions still appearing after every teardown pass — giving up; their leases may be left held until WA_LOCK_TTL_MS expires"
      );
    }

    // Cleared here, right after the teardown loop, NOT after the
    // `startingSettled` join below — every session this loop can ever see is
    // already fully torn down at this point (lease released, socket ended),
    // and a coach still stuck mid-`startSession` was never in this map to
    // begin with (see `startingSettled`'s own comment above). Nothing
    // upstream (`getSnapshot`, a straggling already-accepted HTTP request —
    // `server.close()` only stops NEW ones) needs this map to stay populated
    // one moment longer than the sessions in it are actually still alive.
    this.sessions.clear();

    // NOW join the in-flight-`startSession` wait kicked off above
    // (`startingSettled`) — this is the actual fix: this method must not
    // resolve (and therefore src/main.ts's `.finally(() => process.exit(0))`
    // must not fire) until every `startSession` attempt that was mid-flight
    // when shutdown began has fully unwound, including a lease claim that
    // was still in transit and is only released once `doStartSession`
    // itself observes `shuttingDown` and calls `lock.release()`.
    await startingSettled;
  }

  /**
   * Local teardown after a LOST lease — no DB writes at all: the rival owns
   * the rows now (see src/lock.ts file header). Identity-checked so a stale
   * callback can never evict a session that has since been superseded.
   *
   * DELIBERATELY NO FLUSH HERE (unlike `shutdownOneSession`): by the time
   * `onLost` fires, `markLost` has already flipped `lock.held` to false
   * (src/lock.ts), so the lease is ALREADY gone — the rival, not us, owns
   * `whatsapp_session_keys` for this coach. Waiting for our own in-flight
   * writes here would only widen the exact split-brain window src/lock.ts's
   * file header bounds, for writes `auth-state.ts`'s gate has already
   * refused to make (any write still in flight when the lease was lost was
   * gated out the moment `canWrite()` was next checked — see auth-state.ts's
   * WRITE GATE). There is nothing safe to wait for.
   */
  private teardownLocal(session: Session): void {
    if (this.sessions.get(session.coachId) !== session) return;
    teardownLocalCore(session);
    this.sessions.delete(session.coachId);
  }

  /**
   * Identity-checked so a stale/duplicate teardown can never evict or
   * unlock a session object that has since been superseded (see file
   * header's CONCURRENCY note).
   *
   * DELIBERATELY NO FLUSH HERE (unlike `shutdownOneSession`) on ANY caller
   * of this method:
   *   - `logout()` and the 401/403 close-handler branches call this AFTER
   *     `wipeCreds` has already run — flushing would persist Signal key
   *     material we just deliberately destroyed, i.e. resurrect creds the
   *     wipe was supposed to remove.
   *   - `connectionReplaced` (440) means another client — usually our own
   *     split-brain rival — now owns the live ratchet; our pending writes
   *     reflect a session state that is stale by definition the moment that
   *     close reason arrives, so persisting them would write over the real
   *     owner's truth, not preserve it.
   *   - The QR-give-up path (never completed pairing) has no real creds or
   *     keys yet — nothing here is worth the wait.
   * `shutdownOneSession`'s flush exists specifically for the ONE case none
   * of the above are: a clean process exit where the in-flight writes are
   * legitimately this instance's own current, still-valid state.
   *
   * ALSO handles a race with a CONCURRENT SIGTERM — see `stopSessionCore`'s
   * own JSDoc for the full mechanism. Short version: if `session.stopping`
   * is already true when this runs, `shutdownOneSession` got here first and
   * owns this session's flush and lease release, so `stopSessionCore` skips
   * `lock.release()` here entirely rather than racing it.
   */
  private async stopSession(session: Session, wipe: boolean): Promise<void> {
    await stopSessionCore(
      session,
      wipe ? () => this.safely(session.coachId, () => this.store.wipeCreds(session.coachId, "disconnected", "session stopped")) : null
    );
    if (this.sessions.get(session.coachId) === session) {
      this.sessions.delete(session.coachId);
    }
  }

  /**
   * A LIVE lease check (`confirmHeld`, not the cached `isHeld` flag) before
   * every status write — this column is the ONLY signal the portal reads,
   * so a write that lands after we've actually (but not yet locally-known)
   * lost the lease must not silently overwrite the new holder's truth. See
   * src/lock.ts's `confirmHeld` JSDoc for why this path, specifically,
   * warrants the extra round trip that the hot per-key write gate does not.
   */
  private async persistStatus(session: Session, status: SessionStatus, opts?: Parameters<BridgeStore["setSessionStatus"]>[2]): Promise<void> {
    if (!(await session.lock.confirmHeld())) return; // lost the lease — the new holder writes status now.
    await this.safely(session.coachId, () => this.store.setSessionStatus(session.coachId, status, opts));
  }

  private async safely(coachId: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error({ coachId, err: (err as Error).message }, "store write failed (non-fatal)");
    }
  }
}

export class LeaseUnavailableError extends Error {
  constructor() {
    super("session lease held by another bridge instance");
  }
}

/**
 * Thrown by `doStartSession` once `SessionManager.shutdown()` has begun —
 * see `shuttingDown`'s own JSDoc for the race this closes. Deliberately a
 * DIFFERENT type from `LeaseUnavailableError`: that one means a RIVAL
 * instance owns the lease (retry later — it may well succeed soon, e.g.
 * against whichever instance replaces this one); this one means THIS
 * instance is the one going away, so retrying against it specifically is
 * pointless.
 */
export class ShuttingDownError extends Error {
  constructor() {
    super("bridge instance is shutting down — not starting new sessions");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
