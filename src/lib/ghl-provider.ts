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
 *   |   (SMS fallback B sent the text as SMS)   | not_on_whatsapp | failed + "Not on WhatsApp — sent as SMS instead" |
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
 * THE pending_text ADAPTATION (Phase 2, flagged in the go-live report; extended
 * by 0013): 0069 committed to "no message body stored" for
 * `ghl_outbound_messages`, but the plan's own D3 requires the drain to retry a
 * bridge-unreachable send under the SAME idempotency key with the SAME text
 * (resending different text under that key would be ACCEPTED as the real
 * content — the bridge's own ledger has no row yet for a send that never
 * reached it). `pending_text` (0070) closes that gap, and 0013 keeps it on an
 * accepted row until its status is reported (only while workflow triggers or
 * the SMS fallback are on), so a "not on WhatsApp" trigger can carry the
 * unsent text and the SMS fallback (`src/lib/sms-fallback.ts`) can send it. It
 * is cleared on refusal, on accept when both are off, when the status is reported,
 * and by the cron for an accepted row never reported within 7 days.
 */
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import {
  APP_MESSAGE_ID_PREFIX,
  buildOutboundText,
  deriveAttachmentIdempotencyKey,
  deriveIdempotencyKey,
  deriveMediaFallbackIdempotencyKey,
  isAppOriginatedMessageId,
  isMediaOutboundEnabled,
  refreshGhlToken,
  type sendGhlSms,
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
import { resolveSendingTenant, type SendingNumber } from "@/lib/sending-number";
import type { GhlRepository } from "@/lib/data";
import { decideNotConnected, REASON_NUMBER_BANNED, type NotConnectedDecision } from "@/lib/ghl-held-rules";
import type { TriggerKey } from "@/lib/ghl-trigger-keys";
import { isWorkflowTriggersEnabled, type TriggerPayloads, type TriggerRepo } from "@/lib/ghl-triggers";
import type { GhlAccount, GhlOutboundAttachment, GhlOutboundAttachmentDraft, GhlOutboundMessage, LocationNumber, SmsFallbackEcho } from "@/lib/types";
import { REASON_SENT_AS_SMS, REASON_SMS_FALLBACK_LOOP, smsFallbackEchoMatches } from "@/lib/sms-fallback-shared";
import type { SmsFallbackOutcome } from "@/lib/sms-fallback";

/** Repo slice this module needs — every method it touches is already on `GhlRepository` (Phase 2's extension of Phase 1's interface — see that Pick list's own comment, src/lib/data/index.ts). Both entry points are only ever driven via `webhookRepo` (the webhook route, the poke route, the reminders cron — none carry a user session). */
export type GhlProviderRepo = Pick<
  GhlRepository,
  | "getGhlAccountByLocationId"
  | "getAccountById"
  | "getWhatsappSessionSummary"
  | "isOptedOut"
  | "recordGhlOutboundMessage"
  | "updateGhlOutboundSendState"
  | "listHeldGhlOutboundMessages"
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
  // Phone-sent mirror (0016) — the echo guard in `handleProviderOutboundMessage`.
  | "isMirroredPhoneSentMessage"
  // Multiple numbers (Task 3) — which of the location's numbers an outbound
  // goes out from (`resolveOutboundSendingNumber` below).
  | "listLocationNumbers"
  | "getStickyTenant"
  // Opt-in groups (Task 9) — a GHL contact standing for a WhatsApp group is
  // sent to that group, from the group's own number
  // (`resolveGroupOutbound` below), and a group our number has left is
  // marked so (`noteGroupLeft`).
  | "getWhatsappGroupByContact"
  | "markWhatsappGroupLeft"
  // Workflow triggers — "not on WhatsApp" fires from the status drain.
  | "listTriggerSubscriptions"
  | "getTenantPhone"
  // SMS fallback — contacts remembered as not on WhatsApp.
  | "rememberNotOnWhatsapp"
  | "isRememberedNotOnWhatsapp"
  // SMS fallback B (0014) — the text sent as an SMS (`src/lib/sms-fallback.ts`)
  // and the loop guard in `handleProviderOutboundMessage`.
  | "recordSmsFallbackEcho"
  | "markSmsFallbackEchoSent"
  | "findSmsFallbackEcho"
  | "deleteSmsFallbackEcho"
  | "blockSmsFallback"
  | "claimSmsFallback"
  | "setSmsFallbackResult"
  | "failSmsFallback"
  | "getGhlOutboundMessage"
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
   * `queuedUnits`/`inFlightUnits`, falling back to `queueLength`), the same numbers `GET /sessions/:coachId` already
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
  ) => Promise<{ ok: true } | { ok: false; error: string; status?: number }>;
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
  /**
   * Workflow triggers: fires one WhatsApp event to the subscribed GHL
   * workflows. Optional so tests can fake it; unset, the real
   * `fireWorkflowTrigger` is used (loaded lazily — `ghl-triggers` imports this
   * module — and it reads the firing flag itself). See `fireTriggerBestEffort`.
   */
  fireTrigger?: FireTrigger;
  /**
   * Runs background work that must outlive the response (Next's `after()`).
   * Never throws; used for the send-path trigger fire.
   */
  defer: (fn: () => Promise<void>) => void;
  /** SMS fallback B — GHL's send-an-SMS call. Optional so tests can fake it; unset, the real `sendGhlSms`. */
  sendSms?: typeof sendGhlSms;
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
  defer: (fn) => {
    try {
      after(fn);
    } catch {
      // Outside a request scope: just run it in the background.
      void fn().catch(() => {});
    }
  },
};

/** Fires one trigger event; the shape of `fireWorkflowTrigger` (`src/lib/ghl-triggers.ts`). */
export type FireTrigger = <K extends TriggerKey>(repo: TriggerRepo, locationId: string, key: K, payload: TriggerPayloads[K]) => Promise<unknown>;

/**
 * Fires a workflow trigger without ever throwing or changing the caller's
 * outcome. Uses `deps.fireTrigger` when injected, else the real helper (which
 * does nothing unless `GHL_WORKFLOW_TRIGGERS_ENABLED` is "true"). Logs nothing
 * itself: the helper logs fixed strings, and a throw here is swallowed.
 * Resolves false when the fire threw or reported failed targets.
 */
export async function fireTriggerBestEffort<K extends TriggerKey>(
  repo: TriggerRepo,
  deps: GhlTokenRefreshDeps & { fireTrigger?: FireTrigger },
  locationId: string,
  key: K,
  payload: TriggerPayloads[K]
): Promise<boolean> {
  try {
    let outcome: unknown;
    if (deps.fireTrigger) {
      outcome = await deps.fireTrigger(repo, locationId, key, payload);
    } else {
      const triggers = await import("@/lib/ghl-triggers");
      outcome = await triggers.fireWorkflowTrigger(repo, triggers.defaultTriggerDeps(deps), locationId, key, payload);
    }
    const failed = (outcome as { failed?: unknown } | null | undefined)?.failed;
    return !(typeof failed === "number" && failed > 0);
  } catch {
    // Best effort: a trigger can never change a drain result.
    return false;
  }
}

/** Overall time a drain pass waits for its started fires before returning anyway. */
export const TRIGGER_PASS_CAP_MS = 8_000;

type TriggerTarget = { number: string; numberLabel: string | null };

/**
 * The fires one drain pass starts. Fires are started without being awaited
 * inline (`startTrigger`) and awaited together, under one cap, when the pass
 * ends (`settleTriggers`), so a slow or hanging trigger endpoint can never hold
 * up a row. After the first fire that fails or throws, later fires in the pass
 * are not started and are counted as skipped. Also memoises the number lookups.
 */
export interface TriggerPass {
  pending: Promise<void>[];
  stopped: boolean;
  /** Counts one fire not started. */
  skip: () => void;
  /** Payload `number` / `numberLabel` per `${locationId}:${tenantId}`; a failed lookup is dropped so it is retried. */
  targets: Map<string, Promise<TriggerTarget | null>>;
}

export function newTriggerPass(onSkip: () => void): TriggerPass {
  return { pending: [], stopped: false, skip: onSkip, targets: new Map() };
}

/**
 * Starts `run` (which resolves false when the fire failed) in the background,
 * unless firing is switched off (nothing is read or built) or the pass has
 * stopped after a failure. Never throws and never awaits.
 */
export function startTrigger(pass: TriggerPass, run: () => Promise<boolean>): void {
  if (!isWorkflowTriggersEnabled()) return;
  if (pass.stopped) {
    pass.skip();
    return;
  }
  pass.pending.push(
    (async () => {
      try {
        if (!(await run())) pass.stopped = true;
      } catch {
        pass.stopped = true;
      }
    })()
  );
}

/** Waits for the pass's started fires, at most `TRIGGER_PASS_CAP_MS` in all, then returns regardless. Never throws. */
export async function settleTriggers(pass: TriggerPass, capMs: number = TRIGGER_PASS_CAP_MS): Promise<void> {
  if (pass.pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pass.pending), new Promise<void>((resolve) => (timer = setTimeout(resolve, capMs)))]);
  } catch {
    // never changes the drain result
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The `number` / `numberLabel` of a trigger payload for `tenantId`'s number, or
 * null when its phone is unknown or unreadable (the trigger is then skipped).
 * Memoised on the pass; `knownNumbers` skips the label read when the caller has it.
 */
export function resolvePassTarget(
  repo: Pick<GhlRepository, "getTenantPhone" | "listLocationNumbers">,
  pass: TriggerPass,
  locationId: string,
  tenantId: string,
  knownNumbers?: LocationNumber[]
): Promise<TriggerTarget | null> {
  const key = `${locationId}:${tenantId}`;
  let lookup = pass.targets.get(key);
  if (!lookup) {
    lookup = (async () => {
      try {
        const phone = await repo.getTenantPhone(tenantId);
        if (!phone) return null;
        const numbers = knownNumbers ?? (await repo.listLocationNumbers(locationId));
        const label = numbers.find((n) => n.tenantId === tenantId)?.label?.trim();
        return { number: phone, numberLabel: label ? label : null };
      } catch {
        return null;
      }
    })();
    pass.targets.set(key, lookup);
    void lookup.then((t) => {
      if (!t) pass.targets.delete(key);
    });
  }
  return lookup;
}

/** The text we could not send, at most 500 code points. */
export function capTriggerMessage(text: string | null): string {
  return text === null ? "" : Array.from(text).slice(0, 500).join("");
}

/** The trigger pass of each running status drain, keyed by its result object (the drain helpers already receive it). */
const passByResult = new WeakMap<object, TriggerPass>();

/** Starts `whatsapp_not_on_whatsapp` for a row the bridge reported as not on WhatsApp. Never throws or awaits. */
function fireNotOnWhatsapp(repo: GhlProviderRepo, deps: GhlProviderDeps, result: object, row: GhlOutboundMessage, text: string | null): void {
  const pass = passByResult.get(result);
  if (!pass) return;
  startTrigger(pass, async () => {
    const target = await resolvePassTarget(repo, pass, row.locationId, row.tenantId);
    if (!target) return true;
    // `text` is the row's `pendingText` as read BEFORE the failure was reported
    // (reporting clears it from the database); never logged.
    return fireTriggerBestEffort(repo, deps, row.locationId, "whatsapp_not_on_whatsapp", {
      ...target,
      contactId: row.ghlContactId,
      message: capTriggerMessage(text),
    });
  });
}

/** How long a contact stays remembered as not on WhatsApp. */
export const NOT_ON_WHATSAPP_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remembers a one-to-one phone as not on WhatsApp for 30 days. Best effort:
 * never throws or changes the drain result; a group row (no `toPhone`) is skipped.
 */
async function rememberNotOnWhatsappBestEffort(repo: GhlProviderRepo, row: GhlOutboundMessage): Promise<void> {
  if (!row.toPhone) return;
  try {
    await repo.rememberNotOnWhatsapp(row.locationId, row.toPhone, new Date(Date.now() + NOT_ON_WHATSAPP_MEMORY_MS).toISOString());
  } catch {
    console.error("[ghl-provider] could not remember a not-on-WhatsApp contact (non-fatal)");
  }
}

/** The GHL status reason for a not-on-WhatsApp message, by what the SMS fallback did. */
function notOnWhatsappReason(sms: SmsFallbackOutcome): string {
  return sms === "sent" ? REASON_SENT_AS_SMS : REASON_NOT_ON_WHATSAPP;
}

/**
 * `whatsapp_not_on_whatsapp` fires only when no SMS went and none is pending:
 * not when it was sent (a workflow must not send a second SMS), not for an
 * opted-out contact (STOP wins), not when the loop guard already fired it for
 * the echoed original, and not while another pass holds the row (`busy`).
 */
function shouldFireNotOnWhatsapp(sms: SmsFallbackOutcome): boolean {
  return sms === "failed" || sms === "skipped";
}

/**
 * Runs `trySmsFallback` (`src/lib/sms-fallback.ts`), loaded lazily so that
 * module (which imports this one) is never part of this module's load.
 * Never throws: a load failure counts as "skipped".
 */
async function runSmsFallback(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  input: { account: GhlAccount | null; row: GhlOutboundMessage; text: string | null }
): Promise<SmsFallbackOutcome> {
  try {
    const { trySmsFallback } = await import("@/lib/sms-fallback");
    return await trySmsFallback(repo, deps, input);
  } catch {
    return "skipped";
  }
}

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
/**
 * Multiple numbers (Task 3) — the not-connected refusal when the number this
 * contact is routed to is NOT the location's default (i.e. it is their
 * sticky number). Deliberately a different sentence from
 * `REASON_NOT_CONNECTED`: the GHL user needs to know it is THIS contact's
 * number that is down (the location's other numbers may be fine), and that
 * nothing was sent from another number instead. The default number keeps
 * `REASON_NOT_CONNECTED` unchanged (controller ruling).
 */
const REASON_STICKY_NUMBER_DISCONNECTED = "The WhatsApp number this contact uses is disconnected — reconnect it to reply";
/** Reliability (W10) — the recipient replied STOP to this number; checked before the bridge, so nothing is sent. */
const REASON_OPTED_OUT = "contact replied STOP to this number — not sent (they can reply START to opt back in)";
/**
 * Multiple numbers × STOP (merge ruling) — the recipient replied STOP to
 * ANOTHER of this location's numbers. A STOP is the contact's choice about
 * the business, so it blocks every number of the location; this string says
 * so honestly instead of "to this number".
 */
const REASON_OPTED_OUT_OTHER_NUMBER = "Contact opted out (STOP) on this sub-account — not sent";
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
export const TEXT_PART_NOT_APPLICABLE = "media plan internal: no text part — attachments only, never reported to GHL";
/**
 * Opt-in groups (Task 9) — a GHL message to a group contact whose group is
 * switched off (`whatsapp_groups.enabled = false`), or the bridge's own
 * `group_not_enabled` refusal (switched off mid-flight). Controller ruling,
 * verbatim.
 */
const REASON_GROUP_SYNC_OFF = "WhatsApp group sync is turned off for this group";
/**
 * Opt-in groups (Task 9) — the bridge's own fixed ledger `error` for a group
 * send our number can no longer make (`NOT_IN_GROUP_REASON`,
 * services/whatsapp-bridge/src/groups.ts — must stay byte-identical). The
 * drain forwards it to GHL like any ledger error, and marks the group left
 * (`noteGroupLeft`).
 */
const REASON_GROUP_LEFT = "This WhatsApp number is no longer in that group";
/**
 * The bridge charges a group send this many units of the daily cap
 * (`GROUP_SEND_CAP_UNITS`, services/whatsapp-bridge/src/groups.ts) — mirrored
 * here only for the media split's best-effort up-front budget check; the
 * bridge's own reservation stays authoritative.
 */
export const GROUP_SEND_CAP_UNITS = 5;

/**
 * Where one outbound goes (Task 9): a phone, or an enabled group. Spread
 * straight into the bridge input (`{ ...target }`), so exactly one of the two
 * ever reaches `SendWhatsappInput`/`SendWhatsappAttachmentInput`.
 */
type OutboundTarget = { to: string } | { groupJid: string };

/** The two facts about the sending number this module uses — a `SendingNumber`, or a group's own number. */
type OutboundNumber = Pick<SendingNumber, "tenantId" | "isDefault">;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every non-transient bridge failure code mapped to a fixed, human-readable reason — never the bridge's own `message` text (which can embed a recipient's stored phone number, e.g. `idempotency_conflict`'s message — see `services/whatsapp-bridge/src/server.ts`). */
export function mapBridgeFailureReason(code: string): string {
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
    // Opt-in groups (Task 9) — the group was switched off between our own
    // check and the bridge's (or the bridge's set was reloaded meanwhile).
    case "group_not_enabled":
      return REASON_GROUP_SYNC_OFF;
    default:
      return REASON_BRIDGE_REFUSED;
  }
}

/**
 * `mapBridgeFailureReason`, aware of which number the send went from
 * (multiple numbers, Task 3) — the ONE "which refusal string" decision,
 * shared by the webhook path and every drain retry site. The ONLY
 * difference: `session_not_connected` from a non-default number reports
 * `REASON_STICKY_NUMBER_DISCONNECTED`. Every other code — and every code
 * from the default number — maps exactly as before.
 *
 * `isDefaultNumber` comes from `SendingNumber.isDefault` at webhook time and
 * from `isDefaultNumberForRow` in the drain.
 */
export function mapSendFailureReason(code: string, isDefaultNumber: boolean): string {
  if (code === "session_not_connected" && !isDefaultNumber) return REASON_STICKY_NUMBER_DISCONNECTED;
  return mapBridgeFailureReason(code);
}

/**
 * The drain's answer to "was this row sent from the location's default
 * number?" (multiple numbers, Task 3). `ghl_accounts.tenant_id` mirrors the
 * CURRENT default (`markDefault` in src/lib/data/supabase.ts writes it), so
 * a row whose own tenant differs from it went out from a non-default
 * (sticky) number. With no account at all (structurally shouldn't happen
 * for a row the drain lists), treat it as the default — today's string.
 */
export function isDefaultNumberForRow(row: GhlOutboundMessage, account: GhlAccount | null): boolean {
  return !account || row.tenantId === account.tenantId;
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
  // Terminal for the bridge call itself; every path (single text, multipart
  // text part, attachment parts) turns it into a HOLD via `resolveNotConnected`
  // for a previously linked number, and refuses it otherwise.
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
  // Opt-in groups (Task 9) — the group is not enabled for this number;
  // retrying the same send would be refused identically.
  "group_not_enabled",
]);

export function isTransientBridgeFailure(code: string): boolean {
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

const REASON_SENDING_NUMBER_NOT_ON_LOCATION = "Sending number isn't on this sub-account — not sent";

// The app-originated message id helpers live in `src/lib/ghl.ts` (a leaf, so
// `src/lib/sms-fallback.ts` can use them); re-exported here for existing callers.
export { APP_MESSAGE_ID_PREFIX, isAppOriginatedMessageId };

/**
 * Report one status outcome to GHL, then stamp the ledger row accordingly.
 * Shared by the webhook's inline refusal path and the drain's own
 * resolution/give-up paths — see `Repository.markGhlOutboundReported`'s
 * Phase 2 JSDoc for the "leave unreported, stamp report_error" contract this
 * relies on when the PUT itself fails.
 */
export async function reportGhlOutcome(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  account: GhlAccount | null,
  row: GhlOutboundMessage,
  status: "delivered" | "failed",
  reason: string | null
): Promise<GhlReportOutcome> {
  if (isAppOriginatedMessageId(row.ghlMessageId)) {
    // Sent by this app (a group invite), not by GHL: GHL has no such message
    // to update. Mark the row reported locally so no pass retries it; any
    // GHL conversation post is a separate step by the caller.
    const won = await repo.markGhlOutboundReported(row.id, { reportedStatus: status, reportError: null });
    return won ? "reported" : "already_reported";
  }
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
    const won = await repo.markGhlOutboundReported(row.id, { reportedStatus: status, reportError: null });
    return won ? "reported" : "already_reported";
  }
  await repo.markGhlOutboundReported(row.id, { reportedStatus: null, reportError: put.error });
  return "unreported";
}

/**
 * `reported` — this call stored the status (the only outcome that may remember
 * or fire anything). `already_reported` — the PUT went through but an
 * overlapping pass had already stored the row's status: count it like
 * `reported`, but never fire. `unreported` — left for the next pass.
 */
export type GhlReportOutcome = "reported" | "already_reported" | "unreported";

/** True when the row's status is stored, by this call or an overlapping one. */
export function isReportedOutcome(outcome: GhlReportOutcome): boolean {
  return outcome !== "unreported";
}

export type HandleProviderOutboundOutcome =
  | { kind: "ignored"; reason: "non_sms_type" | "malformed_payload" | "unknown_location" | "mirrored_phone_send" }
  | { kind: "duplicate" }
  | { kind: "accepted" }
  /** The number is offline (linked once before): the row is `held` and sends when it reconnects. Nothing is reported to GoHighLevel yet. */
  | { kind: "held" }
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
  // Opt-in groups (Task 9) — `null` only for an unreadable phone; a group
  // contact's target is its group. `groupRefusal` is set for a switched-off
  // group, or an enabled group the number has left.
  let target: OutboundTarget | null;
  let groupRefusal: string | null = null;
  let textResult: ReturnType<typeof buildOutboundText>;
  // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — both hoisted so
  // Phase B (below) can reach them; see the assignment site's own comment.
  let mediaSplit: boolean;
  let attachments: string[];
  // SMS fallback B — hoisted for Phase B (the loop guard and the SMS text).
  let rawMessage: string;
  // Multiple numbers (Task 3) — hoisted for Phase B like the two above.
  let sendingNumber: OutboundNumber;
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

    // Opt-in groups (Task 9) — FIRST, before phone normalisation and before
    // sticky/default routing (controller ruling): a contact that stands for
    // a WhatsApp group goes to that group, from the group's OWN number, and
    // never gets a sticky row. Not a group contact -> today's path, unchanged.
    const group = await repo.getWhatsappGroupByContact(account.locationId, contactId);
    if (group) {
      toPhone = null;
      target = { groupJid: group.groupJid };
      // Switched off wins; an enabled group the number has left (left_at
      // set — the bridge leaves it out of its enabled set) gets the bridge's
      // own "no longer in that group" string, never "turned off".
      // A group of a number since removed from the location is "turned
      // off" too (removing a number switches its groups off).
      groupRefusal = group.numberRemoved || !group.enabled ? REASON_GROUP_SYNC_OFF : group.left ? REASON_GROUP_LEFT : null;
    } else {
      const phone = typeof payload.phone === "string" ? payload.phone : null;
      toPhone = normalisePhoneE164(phone, "GB");
      target = toPhone ? { to: toPhone } : null;
    }

    rawMessage = typeof payload.message === "string" ? payload.message : "";
    attachments = Array.isArray(payload.attachments) ? payload.attachments.filter((a): a is string => typeof a === "string") : [];

    // Phone-sent mirror echo guard (migration 0016, src/lib/ghl-inbound.ts):
    // a message we posted into this conversation because the business
    // already sent it from the phone must never be delivered over WhatsApp
    // a second time, should GHL ever hand it to this Delivery URL.
    if (
      await repo.isMirroredPhoneSentMessage({
        locationId: account.locationId,
        defaultTenantId: account.tenantId,
        ghlMessageId: messageId,
        toPhone,
        body: rawMessage,
      })
    ) {
      return { kind: "ignored", reason: "mirrored_phone_send" };
    }
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

    // Multiple numbers (Task 3) — WHICH of the location's numbers this goes
    // out from, decided ONCE, here, before the intake row exists, and
    // recorded as the row's `tenantId`. Everything downstream (this
    // handler's own sends, the drain's retries and its bridge-ledger joins)
    // reads `row.tenantId`, never `account.tenantId` (which is only the
    // location's DEFAULT number), so a row can never be retried or resolved
    // against a different number than the one it was routed to. Kept as one
    // named call so a check that must win over sticky/default routing (a
    // group contact belongs to its group's number) can sit in front of it.
    // A failure here is pre-intake: `{ kind: "error", recorded: false }`, so
    // GHL's own retry gets a chance — nothing has been sent from any number.
    // A removed number's group is refused below; its row goes on the
    // location's default number, never on a number the location no longer has.
    sendingNumber = group
      ? groupSendingNumber(account, group.numberRemoved ? account.tenantId : group.tenantId)
      : await resolveOutboundSendingNumber(repo, account, contactId);

    ({ message: row, isNew } = await repo.recordGhlOutboundMessage({
      locationId: account.locationId,
      tenantId: sendingNumber.tenantId,
      ghlMessageId: messageId,
      ghlContactId: contactId,
      idempotencyKey: deriveIdempotencyKey(messageId),
      toPhone,
      hadAttachments: attachments.length > 0,
      // Only carried forward when we're actually going to attempt a bridge
      // send with it — see this file's pending_text note in the header.
      pendingText: target && groupRefusal === null && textResult.ok ? textResult.text : null,
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
    // SMS fallback B loop guard — FIRST, before any send or other refusal: our
    // own fallback SMS handed back to us by GHL (PingWren is this
    // sub-account's SMS provider) is refused, never sent on WhatsApp, and
    // switches the fallback off for the sub-account.
    const echo = await refuseIfSmsFallbackEcho(repo, deps, account, row, rawMessage);
    if (echo) return echo;

    // Accounts gate, then the STOP check — before the media split, so the
    // media path is gated too (see `refuseIfGatedOrOptedOut`).
    const blocked = await refuseIfGatedOrOptedOut(repo, deps, account, row, toPhone);
    if (blocked) return blocked;

    // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — split off
    // ENTIRELY before any of the legacy single-send logic below runs. With
    // `mediaSplit` false (flag off, or no attachments), execution never
    // reaches this branch at all — everything from here down in this `try`
    // is byte-for-byte the pre-media-plan code path, which is what makes the
    // flags-off regression guarantee true regardless of what
    // `handleMediaSplitOutbound` does.
    // Opt-in groups (Task 9) — a switched-off group, or one the number has
    // left, is refused before anything else, with or without attachments:
    // nothing goes to the group.
    if (groupRefusal !== null) {
      await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: groupRefusal });
      await reportGhlOutcome(repo, deps, account, row, "failed", groupRefusal);
      return { kind: "refused", reason: groupRefusal };
    }

    // The SMS carries the message text only, never the attachment links.
    const remembered = await refuseIfNotOnWhatsapp(repo, deps, account, row, textResult.ok ? textResult.text : "", rawMessage);
    if (remembered) return remembered;

    if (mediaSplit) {
      return await handleMediaSplitOutbound(repo, deps, account, row, target, textResult, attachments, messageId, sendingNumber);
    }

    // Terminal refusals that never reach the bridge at all (plan's D5/D6).
    if (!target) {
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

    return await continueTextOutbound(repo, deps, { account, row, target, text: textResult.text, sendingNumber });
  } catch (err) {
    console.error(`[ghl-provider] handleProviderOutboundMessage: post-intake failure for row ${row.id} (row already recorded — the drain owns it from here):`, err);
    return { kind: "error", recorded: true };
  }
}

/**
 * SMS fallback B loop guard. When this message matches the contact's pending
 * echo of a fallback SMS we asked GHL to send, it is that SMS coming back
 * through our own provider webhook (PingWren is this sub-account's SMS
 * provider). A match is GHL's message id once the send's response gave one,
 * else the hash of the normalised text, once the send succeeded or while it
 * may still be in flight (`smsFallbackEchoMatches`). Checked whatever the flag (an echo
 * may still be pending after it is switched off).
 *
 * On a match: the row is stamped refused FIRST (so no later pass can send it),
 * then the echo is consumed, the fallback is blocked for the sub-account, the
 * original message is corrected (`failSmsFallback`, the trigger fired with its
 * text, and "recipient has no WhatsApp account" reported if it is not yet
 * reported), and this message is reported with `REASON_SMS_FALLBACK_LOOP`.
 * A read error fails open (the message carries on as normal). Returns null to go on.
 */
async function refuseIfSmsFallbackEcho(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  account: GhlAccount,
  row: GhlOutboundMessage,
  rawMessage: string
): Promise<HandleProviderOutboundOutcome | null> {
  if (!rawMessage.trim()) return null;
  let echo: SmsFallbackEcho | null;
  try {
    echo = await repo.findSmsFallbackEcho(account.locationId, row.ghlContactId, new Date().toISOString());
  } catch {
    console.error("[ghl-provider] SMS fallback echo read failed (sending normally)");
    return null;
  }
  if (!echo) return null;
  if (!smsFallbackEchoMatches(echo, { ghlMessageId: row.ghlMessageId, text: rawMessage }, Date.now())) return null;

  console.error("[ghl-provider] SMS fallback echo came back through PingWren — refused, and the fallback is switched off for this sub-account");
  await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_SMS_FALLBACK_LOOP });
  try {
    await repo.deleteSmsFallbackEcho(account.locationId, row.ghlContactId, echo.outboundMessageId);
  } catch {
    // It expires in 10 minutes; until then it only keeps the cooldown.
    console.error("[ghl-provider] could not consume the SMS fallback echo (non-fatal)");
  }
  try {
    await repo.blockSmsFallback(account.locationId);
  } catch {
    console.error("[ghl-provider] could not switch the SMS fallback off for this sub-account (non-fatal)");
  }
  await correctEchoedOriginal(repo, deps, account, echo.outboundMessageId, rawMessage);
  await reportGhlOutcome(repo, deps, account, row, "failed", REASON_SMS_FALLBACK_LOOP);
  return { kind: "refused", reason: REASON_SMS_FALLBACK_LOOP };
}

/**
 * The original message whose fallback SMS came back did not reach the contact:
 * mark its fallback failed (its own pass re-reads this just before reporting)
 * and, only when that moved it from claimed or sent, fire
 * `whatsapp_not_on_whatsapp` for it with the text and report "recipient has no
 * WhatsApp account" when it has not been reported yet. Best effort.
 */
async function correctEchoedOriginal(repo: GhlProviderRepo, deps: GhlProviderDeps, account: GhlAccount, originalId: string, text: string): Promise<void> {
  try {
    // Only the call that moved it to failed fires and reports, so an original
    // already failed (its own pass fired) never fires twice.
    if (!(await repo.failSmsFallback(originalId))) return;
    const original = await repo.getGhlOutboundMessage(originalId);
    if (!original) return;
    fireNotOnWhatsappFromSend(repo, deps, original, text);
    if (original.reportedStatus === null) await reportGhlOutcome(repo, deps, account, original, "failed", REASON_NOT_ON_WHATSAPP);
  } catch {
    console.error("[ghl-provider] could not correct the original of an echoed SMS fallback (non-fatal)");
  }
}

/**
 * The two refusals that precede everything else for a phone row: the accounts
 * gate, then the STOP check. Shared by `handleProviderOutboundMessage` (which
 * runs it before the media split) and `sendAppOriginatedText`. Returns the
 * refused outcome (row already stamped and reported), or `null` to go on.
 */
async function refuseIfGatedOrOptedOut(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  account: GhlAccount,
  row: GhlOutboundMessage,
  toPhone: string | null
): Promise<HandleProviderOutboundOutcome | null> {
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

  // Reliability (W10): a contact who replied STOP gets nothing — refused
  // before the media split and before any bridge call, reported to
  // GoHighLevel as not sent with a fixed reason. Multiple numbers (merge
  // ruling): a STOP recorded on ANY of this location's numbers blocks the
  // send from every one of them (`optedOutReason`). A group row has no
  // phone (`toPhone` null), so a member's STOP never blocks a group send.
  const optedOut = toPhone ? await optedOutReason(repo, account.locationId, row.tenantId, toPhone) : null;
  if (optedOut) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: optedOut });
    await reportGhlOutcome(repo, deps, account, row, "failed", optedOut);
    return { kind: "refused", reason: optedOut };
  }
  return null;
}

/**
 * SMS fallback: a one-to-one contact remembered as not on WhatsApp is refused
 * with no bridge call (text or attachments), and `whatsapp_not_on_whatsapp`
 * fires so a workflow can send it by SMS. Runs after the gate/STOP check and
 * the group refusal. A group row has no `toPhone` and ignores the memory; a
 * needs_reauth/disabled account is left to its own refusal; a read error
 * fails open. Returns the refused outcome, or null to go on.
 */
async function refuseIfNotOnWhatsapp(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  account: GhlAccount,
  row: GhlOutboundMessage,
  text: string,
  smsText: string = text
): Promise<HandleProviderOutboundOutcome | null> {
  if (!row.toPhone || account.status === "needs_reauth" || account.status === "disabled") return null;
  if (!(await isRememberedNotOnWhatsappSafe(repo, row.locationId, row.toPhone))) return null;
  // SMS fallback B, once per send (the row is new; a redelivery is a
  // duplicate). Before the refusal is stamped, so the stored reason (which a
  // later pass reports if this report fails) says whether it went as SMS.
  const sms = await runSmsFallback(repo, deps, { account, row, text: smsText });
  const reason = notOnWhatsappReason(sms);
  await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
  const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", reason);
  // An unreported PUT still fires (no later pass fires for a refused row); a
  // status an overlapping pass already stored never fires twice.
  if (outcome !== "already_reported" && shouldFireNotOnWhatsapp(sms)) fireNotOnWhatsappFromSend(repo, deps, row, text);
  return { kind: "refused", reason };
}

/** True when the contact is remembered as not on WhatsApp; false on any read error. */
async function isRememberedNotOnWhatsappSafe(repo: GhlProviderRepo, locationId: string, phone: string): Promise<boolean> {
  try {
    return await repo.isRememberedNotOnWhatsapp(locationId, phone, new Date().toISOString());
  } catch {
    console.error("[ghl-provider] not-on-WhatsApp memory read failed (sending normally)");
    return false;
  }
}

/**
 * Fires `whatsapp_not_on_whatsapp` for a send refused from the memory. Not in a
 * drain: starts the fire in the background on a one-fire pass, never awaited,
 * so the send response is never held; every error is swallowed.
 */
function fireNotOnWhatsappFromSend(repo: GhlProviderRepo, deps: GhlProviderDeps, row: GhlOutboundMessage, text: string): void {
  try {
    const pass = newTriggerPass(() => {});
    startTrigger(pass, async () => {
      const target = await resolvePassTarget(repo, pass, row.locationId, row.tenantId);
      if (!target) return true;
      return fireTriggerBestEffort(repo, deps, row.locationId, "whatsapp_not_on_whatsapp", {
        ...target,
        contactId: row.ghlContactId,
        message: capTriggerMessage(text),
      });
    });
    // Hand the capped wait to the host so the fire survives the response.
    deps.defer(() => settleTriggers(pass));
  } catch {
    // best effort
  }
}

/** What `continueTextOutbound` needs to carry a text row through to the bridge. */
export interface TextOutboundContext {
  account: GhlAccount;
  row: GhlOutboundMessage;
  target: OutboundTarget;
  text: string;
  sendingNumber: OutboundNumber;
}

/**
 * The text path of an outbound row, from the needs_reauth/disabled refusal on:
 * hold-behind, bridge send, then hold/refuse. Extracted unchanged from
 * `handleProviderOutboundMessage` so other entry points (`sendAppOriginatedText`)
 * share it. Callers run `refuseIfGatedOrOptedOut` first. Throws like the
 * inline code did; callers own the try/catch.
 */
export async function continueTextOutbound(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  ctx: TextOutboundContext
): Promise<HandleProviderOutboundOutcome> {
  const { account, row, sendingNumber } = ctx;
  // Ordering note: `embedStateFor` (dashboard) reports disabled/needs_reauth
  // before the account gate because it describes the *first thing the owner
  // must fix*. This path deliberately gates first: a refusal for billing or
  // activation is the commercial truth and reaches GoHighLevel with the
  // fixed customer string either way, and no message is sent in both orders.
  //
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

  // Ordering: older messages for this number still waiting (held) go first,
  // so this one waits behind them and the release pass sends in order.
  // Per number: `row.tenantId` (the sticky/default/group number this row
  // was routed to), never `account.tenantId` (merge ruling).
  if (await holdBehindHeldRows(repo, row.tenantId, row)) return { kind: "held" };

  // `row.tenantId` — the number `resolveOutboundSendingNumber` routed this
  // row to (Task 3), not `account.tenantId` (the location's default). A
  // disconnected number — sticky or default — is decided by the bridge's
  // own `session_not_connected` below: HELD if it was linked before
  // (merge ruling: holding wins over the sticky refusal), and NEVER swapped
  // for another number.
  const sendResult = await deps.sendWhatsapp({
    coachId: row.tenantId,
    ...ctx.target,
    text: ctx.text,
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

  if (sendResult.code === "session_not_connected") {
    const decision = await resolveNotConnected(repo, row, row, sendingNumber.isDefault);
    if (decision.kind === "hold") return { kind: "held" };
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: decision.reason });
    await reportGhlOutcome(repo, deps, account, row, "failed", decision.reason);
    return { kind: "refused", reason: decision.reason };
  }

  const reason = mapSendFailureReason(sendResult.code, sendingNumber.isDefault);
  await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
  await reportGhlOutcome(repo, deps, account, row, "failed", reason);
  return { kind: "refused", reason };
}

/**
 * An invite (or any text this app originates) sent as a normal outbound: the
 * same gate, STOP check (across all of the location's numbers), hold-behind,
 * pacing and hold/refuse rules as a GHL-originated text, from exactly
 * `input.tenantId`. The row's `ghlMessageId` is `pwapp_`-prefixed so
 * `reportGhlOutcome` never PUTs it to GHL; `ghl_outbound_messages` has no
 * conversation id column, so the contact id is all it records. Never throws:
 * a repo failure resolves to `{ kind: "error", recorded }`.
 */
export async function sendAppOriginatedText(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  input: { account: GhlAccount; tenantId: string; ghlContactId: string; toPhone: string; text: string }
): Promise<HandleProviderOutboundOutcome> {
  const { account } = input;
  try {
    const numbers = await repo.listLocationNumbers(account.locationId);
    if (!numbers.some((n) => n.tenantId === input.tenantId)) return { kind: "refused", reason: REASON_SENDING_NUMBER_NOT_ON_LOCATION };
  } catch (err) {
    console.error("[ghl-provider] sendAppOriginatedText: could not read the location's numbers (nothing sent):", err instanceof Error ? err.name : "unknown");
    return { kind: "error", recorded: false };
  }
  const sendingNumber = groupSendingNumber(account, input.tenantId);
  const ghlMessageId = APP_MESSAGE_ID_PREFIX + randomUUID().replaceAll("-", "");
  let row: GhlOutboundMessage;
  try {
    ({ message: row } = await repo.recordGhlOutboundMessage({
      locationId: account.locationId,
      tenantId: sendingNumber.tenantId,
      ghlMessageId,
      ghlContactId: input.ghlContactId,
      idempotencyKey: deriveIdempotencyKey(ghlMessageId),
      toPhone: input.toPhone,
      hadAttachments: false,
      pendingText: input.text,
    }));
  } catch (err) {
    console.error("[ghl-provider] sendAppOriginatedText: could not record the outbound row (nothing sent):", err instanceof Error ? err.name : "unknown");
    return { kind: "error", recorded: false };
  }
  try {
    const blocked = await refuseIfGatedOrOptedOut(repo, deps, account, row, input.toPhone);
    if (blocked) return blocked;
    const remembered = await refuseIfNotOnWhatsapp(repo, deps, account, row, input.text);
    if (remembered) return remembered;
    return await continueTextOutbound(repo, deps, { account, row, target: { to: input.toPhone }, text: input.text, sendingNumber });
  } catch (err) {
    console.error(`[ghl-provider] sendAppOriginatedText: post-intake failure for row ${row.id} (row already recorded — the drain owns it from here):`, err instanceof Error ? err.name : "unknown");
    return { kind: "error", recorded: true };
  }
}

/**
 * Multiple numbers (Task 3) — the ONE place an outbound is routed to a
 * number: the contact's sticky number if it is still one of the location's
 * numbers, else the default (`resolveSendingTenant`, src/lib/sending-number.ts).
 * `account.tenantId` is passed only as the fallback for a location with no
 * `ghl_location_numbers` rows at all (structurally impossible after Task 2;
 * see `resolveSendingTenant`'s JSDoc) — then this is exactly the
 * pre-multiple-numbers behaviour.
 */
function resolveOutboundSendingNumber(repo: GhlProviderRepo, account: GhlAccount, ghlContactId: string): Promise<SendingNumber> {
  return resolveSendingTenant(repo, account.locationId, ghlContactId, account.tenantId);
}

/**
 * Opt-in groups (Task 9) — a group contact's sending number is the number
 * the group lives on, full stop: no sticky lookup, no sticky write. "Default"
 * by the same test the drain uses (`isDefaultNumberForRow`:
 * `ghl_accounts.tenant_id` mirrors the current default), so the webhook and
 * every drain retry pick the same refusal strings for this row.
 */
function groupSendingNumber(account: GhlAccount, groupTenantId: string): OutboundNumber {
  return { tenantId: groupTenantId, isDefault: groupTenantId === account.tenantId };
}

/**
 * Opt-in groups (Task 9) — where a drain retry of `row` goes. A phone row
 * goes to its phone, exactly as before. A row with no phone is a group row
 * when its contact is still a group contact ON THE ROW'S OWN NUMBER; then it
 * goes to that group whether or not the group is still switched on — the
 * bridge checks its idempotency replay BEFORE its enabled set, so an earlier
 * attempt that did land still resolves to its true row, and a genuinely new
 * send to a switched-off group comes back `group_not_enabled` (terminal,
 * `REASON_GROUP_SYNC_OFF`). `null`: no phone and no such group — the
 * caller's existing defensive give-up.
 */
export async function resolveDrainTarget(repo: GhlProviderRepo, row: GhlOutboundMessage): Promise<OutboundTarget | null> {
  if (row.toPhone) return { to: row.toPhone };
  const group = await repo.getWhatsappGroupByContact(row.locationId, row.ghlContactId);
  return group && group.tenantId === row.tenantId ? { groupJid: group.groupJid } : null;
}

/**
 * Opt-in groups (Task 9) — when a group row's terminal failure is the
 * bridge's "no longer in that group", stamp the group left on the row's
 * number (`markWhatsappGroupLeft`; the embed then shows it as "Left").
 * Best effort: never throws into the drain — a failure here is logged and
 * the status report goes ahead regardless.
 */
async function noteGroupLeft(repo: GhlProviderRepo, row: GhlOutboundMessage, reasons: (string | null)[]): Promise<void> {
  if (row.toPhone || !reasons.includes(REASON_GROUP_LEFT)) return;
  try {
    const group = await repo.getWhatsappGroupByContact(row.locationId, row.ghlContactId);
    if (group && group.tenantId === row.tenantId) await repo.markWhatsappGroupLeft(row.tenantId, group.groupJid);
  } catch (err) {
    console.error(`[ghl-provider] could not mark the group left for row ${row.id} (non-fatal):`, err);
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
  const { dailyCap, sentToday, queueLength, queuedUnits, inFlightUnits } = session.session;
  // The same sum the bridge's own reservation uses (sent + in flight + queued
  // units). An older bridge without the unit fields: one unit per queued item.
  const remaining = dailyCap - sentToday - (queuedUnits ?? queueLength) - (inFlightUnits ?? 0);
  return unitsNeeded <= remaining;
}

async function handleMediaSplitOutbound(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  account: GhlAccount,
  row: GhlOutboundMessage,
  target: OutboundTarget | null,
  textResult: ReturnType<typeof buildOutboundText>,
  attachmentUrls: string[],
  ghlMessageId: string,
  sendingNumber: OutboundNumber
): Promise<HandleProviderOutboundOutcome> {
  // Multiple numbers (Task 3) — every send below goes from `row.tenantId`
  // (the number `resolveOutboundSendingNumber` routed this row to), never
  // `account.tenantId` (the location's default).
  // Terminal refusals shared with the legacy path, in the SAME order — see
  // `handleProviderOutboundMessage`'s own comments for why each exists.
  // `target` is the phone, or the group for a group contact (Task 9) — every
  // part below goes to it.
  if (!target) {
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
  // A group part weighs `GROUP_SEND_CAP_UNITS`, as the bridge counts it (Task 9).
  const unitsPerPart = "groupJid" in target ? GROUP_SEND_CAP_UNITS : 1;
  const totalUnits = ((hasTextPart ? 1 : 0) + attachmentUrls.length) * unitsPerPart;
  const budgetOk = await hasSufficientOutboundBudget(deps, row.tenantId, totalUnits);
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

  // Ordering: older messages for this number still waiting (held) go first.
  // The whole message waits (parent held, parts pending_send) for the release pass.
  // Per number: `row.tenantId`, never the location's default (merge ruling).
  if (await holdBehindHeldRows(repo, row.tenantId, row)) return { kind: "held" };

  const partOutcomes: PartOutcome[] = [];
  let anyTransientRetry = false;
  // The parent row's own state describes the TEXT part. Its "accepted" (or the
  // vacuous no-text marker) is written only once no later part has put the
  // whole message on hold, because holding keeps `pending_text` and a later
  // release must be able to resume from the parent row.
  let deferredTextWrite: (() => Promise<void>) | null = null;
  // Once the text part is terminally refused the parent can no longer be held.
  let textTerminal = false;

  if (hasTextPart && textResult.ok) {
    const sendResult = await deps.sendWhatsapp({ coachId: row.tenantId, ...target, text: textResult.text, idempotencyKey: row.idempotencyKey });
    if (sendResult.ok) {
      deferredTextWrite = () => repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" }).then(() => undefined);
      partOutcomes.push({ resolved: false });
    } else if (sendResult.code === "session_not_connected") {
      const decision = await resolveNotConnected(repo, row, row, sendingNumber.isDefault);
      if (decision.kind === "hold") return { kind: "held" };
      textTerminal = true;
      await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: decision.reason });
      partOutcomes.push({ resolved: true, sent: false, reason: decision.reason });
    } else if (isTransientBridgeFailure(sendResult.code)) {
      // Row stays 'pending_send' (the DB default — nothing to write); the
      // drain retries it (`resolveTextPartOutcome`/`retryTextPart`).
      anyTransientRetry = true;
      partOutcomes.push({ resolved: false });
    } else {
      const reason = mapSendFailureReason(sendResult.code, sendingNumber.isDefault);
      textTerminal = true;
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
    deferredTextWrite = () => repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: TEXT_PART_NOT_APPLICABLE }).then(() => undefined);
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
      coachId: row.tenantId,
      ...target,
      attachment: { url: url ?? "", fileName: part.fileName ?? undefined },
      idempotencyKey: part.idempotencyKey,
    });
    if (sendResult.ok) {
      await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "accepted" });
      partOutcomes.push({ resolved: false });
    } else if (sendResult.code === "session_not_connected") {
      // The phone dropped part-way through. Hold the whole message (parent
      // held, this and every later part left pending_send) unless the text
      // part already ended the parent's life or the number is banned/unlinked.
      const notConnected = mapSendFailureReason("session_not_connected", sendingNumber.isDefault);
      const decision = textTerminal
        ? decideNotConnected(await repo.getWhatsappSessionSummary(row.tenantId), notConnected)
        : await resolveNotConnected(repo, row, row, sendingNumber.isDefault);
      if (decision.kind === "hold" && !textTerminal) return { kind: "held" };
      const partReason = decision.kind === "refuse" ? decision.reason : notConnected;
      await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: partReason });
      partOutcomes.push({ resolved: true, sent: false, reason: partReason });
    } else if (isTransientBridgeFailure(sendResult.code)) {
      anyTransientRetry = true;
      partOutcomes.push({ resolved: false });
    } else {
      const reason = mapSendFailureReason(sendResult.code, sendingNumber.isDefault);
      await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: reason });
      if (sendResult.code === "media_outbound_disabled" && url) mediaDisabledUrls.push(url);
      partOutcomes.push({ resolved: true, sent: false, reason });
    }
  }

  // No part put the message on hold: settle the parent's own (text-part) state.
  if (deferredTextWrite) await deferredTextWrite();

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
        coachId: row.tenantId,
        ...target,
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

/**
 * The bridge said `session_not_connected`. Decide from the number's session
 * summary: a number that was linked once and is offline is HELD (the row's
 * `send_state` becomes `held`, `pending_text` kept, nothing reported to
 * GoHighLevel); banned or never-linked is refused with a fixed reason.
 * A multipart (picture/file) message is held as a whole: the PARENT row is
 * `held` and its attachment rows stay `pending_send` (no `held` state on
 * `ghl_outbound_attachments` — the drain never sees a held parent, so the
 * parts are never retried behind its back, and the release pass resumes them
 * in order using the bridge ledger). Exported for the release pass.
 */
export async function resolveNotConnected(
  repo: GhlProviderRepo,
  account: Pick<GhlAccount, "tenantId">,
  row: GhlOutboundMessage,
  isDefaultNumber: boolean = true
): Promise<NotConnectedDecision> {
  // Multiple numbers (merge ruling): pass the ROW as `account` — the hold is
  // per number (the sticky/default/group number the row was routed to) and
  // never falls back to another number. A refusal (never linked) keeps the
  // default number's string for the default and the sticky-number string for
  // any other number (`mapSendFailureReason`).
  const summary = await repo.getWhatsappSessionSummary(account.tenantId);
  const decision = decideNotConnected(summary, mapSendFailureReason("session_not_connected", isDefaultNumber));
  if (decision.kind === "hold") await repo.updateGhlOutboundSendState(row.id, { sendState: "held" });
  return decision;
}

/**
 * Ordering rule: if the tenant already has held rows, a newer message waits
 * behind them (row becomes `held`, nothing sent) and the release pass sends
 * oldest first. Returns true when the row was held.
 */
async function holdBehindHeldRows(repo: GhlProviderRepo, tenantId: string, row: GhlOutboundMessage): Promise<boolean> {
  const held = await repo.listHeldGhlOutboundMessages(tenantId, 1);
  if (held.length === 0) return false;
  await repo.updateGhlOutboundSendState(row.id, { sendState: "held" });
  return true;
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
  /** `pending_send` rows moved to `held` this pass (the number is offline; they send on reconnect). */
  held: number;
  /** `accepted` rows whose bridge-side outcome hasn't resolved yet — left for the next pass. */
  unresolved: number;
  /** Rows where the PUT to GHL itself failed — left unreported, `report_error` stamped, retried next pass. */
  reportFailed: number;
  /** Finding 5 — `true` iff this pass stopped early after `DRAIN_TIME_BUDGET_MS` because it ran long; any rows past that point were never started and remain valid candidates for the next pass. `false` on every normal pass. */
  timeBudgetExceeded: boolean;
  /** Workflow-trigger fires not started this pass because an earlier fire in it failed. */
  triggersSkipped: number;
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
    held: 0,
    unresolved: 0,
    reportFailed: 0,
    timeBudgetExceeded: false,
    triggersSkipped: 0,
  };
  const pass = newTriggerPass(() => result.triggersSkipped++);
  passByResult.set(result, pass);
  try {
    return await drainGhlOutboundStatusesPass(repo, deps, result);
  } finally {
    // Started trigger fires get a bounded wait; the rows are already resolved.
    await settleTriggers(pass);
  }
}

async function drainGhlOutboundStatusesPass(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  result: DrainGhlOutboundStatusesResult
): Promise<DrainGhlOutboundStatusesResult> {
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
        if (isReportedOutcome(outcome)) result.failed++;
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
  // Read up front (it used to be read only once every part had resolved) —
  // a part retry below needs it to pick the refusal string (multiple
  // numbers, Task 3 — `isDefaultNumberForRow`). Reused for the report.
  const account = await repo.getGhlAccountByLocationId(row.locationId);
  const isDefaultNumber = isDefaultNumberForRow(row, account);
  const hold = { held: false };
  const textOutcome = await resolveTextPartOutcome(repo, deps, row, bridgeStatusByKey, result, isDefaultNumber, hold);
  const attachmentOutcomes: PartOutcome[] = [];
  for (const part of parts) {
    if (hold.held) break;
    attachmentOutcomes.push(await resolveAttachmentPartOutcome(repo, deps, row, part, bridgeStatusByKey, result, isDefaultNumber, hold));
  }
  if (hold.held) {
    // The phone is offline: the parent is now `held` and leaves the drain until the release pass finishes it.
    result.held++;
    return;
  }

  const aggregate = aggregatePartOutcomes([textOutcome, ...attachmentOutcomes]);
  if (!aggregate.done) {
    result.unresolved++;
    return;
  }
  await noteGroupLeft(
    repo,
    row,
    [textOutcome, ...attachmentOutcomes].map((o) => (o.resolved && !o.sent ? o.reason : null))
  );

  const status = aggregate.status === "delivered" ? "delivered" : "failed";
  const unsentText = row.pendingText;
  const notOnWhatsapp = aggregate.status === "failed" && aggregate.reason === REASON_NOT_ON_WHATSAPP;
  // SMS fallback B: the text part's text (never the attachments), before the report.
  const sms: SmsFallbackOutcome | null = notOnWhatsapp ? await runSmsFallback(repo, deps, { account, row, text: unsentText }) : null;
  if (sms === "busy") {
    result.unresolved++;
    return;
  }
  const reason = aggregate.status === "failed" ? (sms ? notOnWhatsappReason(sms) : aggregate.reason) : null;
  const outcome = await reportGhlOutcome(repo, deps, account, row, status, reason);
  if (isReportedOutcome(outcome)) {
    if (aggregate.status === "delivered") result.delivered++;
    else {
      result.failed++;
      // Only the pass that stored the status remembers and fires.
      if (sms && outcome === "reported") {
        await rememberNotOnWhatsappBestEffort(repo, row);
        if (shouldFireNotOnWhatsapp(sms)) fireNotOnWhatsapp(repo, deps, result, row, unsentText);
      }
    }
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
  result: DrainGhlOutboundStatusesResult,
  isDefaultNumber: boolean,
  hold: { held: boolean }
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
  return retryTextPart(repo, deps, row, result, isDefaultNumber, hold);
}

/**
 * Multiple numbers × STOP (merge ruling) — the opt-out refusal for `phone`,
 * or `null`. Opt-outs are STORED per number (`whatsapp_opt_outs` is keyed
 * `(tenant_id, phone)`, W10), but a STOP is the contact's choice about the
 * business, so it is CHECKED across every number of the location
 * (`listLocationNumbers`), plus the sending number itself (a row whose
 * number was since removed from the location). The sending number's own
 * opt-out reports the original W10 string; one recorded on another number
 * reports `REASON_OPTED_OUT_OTHER_NUMBER`. At most 4 point reads (3 numbers).
 */
export async function optedOutReason(repo: Pick<GhlRepository, "isOptedOut" | "listLocationNumbers">, locationId: string, sendingTenantId: string, phone: string): Promise<string | null> {
  if (await repo.isOptedOut(sendingTenantId, phone)) return REASON_OPTED_OUT;
  const numbers = await repo.listLocationNumbers(locationId);
  for (const n of numbers) {
    if (n.tenantId === sendingTenantId) continue;
    if (await repo.isOptedOut(n.tenantId, phone)) return REASON_OPTED_OUT_OTHER_NUMBER;
  }
  return null;
}

/**
 * Re-runs the accounts sending gate for a retry. Billing or activation can
 * change between intake and a drain pass, so a queued `pending_send` row must
 * be re-checked before the bridge is called again. `null` means "may send".
 * `row` is the outbound row being retried: its own number (`tenantId`) and
 * phone (`toPhone`, null for a group row — a member's STOP never blocks a
 * group send) drive the location-wide opt-out check (`optedOutReason`).
 */
export async function outboundRefusalReason(
  repo: GhlProviderRepo,
  account: GhlAccount | null,
  row: Pick<GhlOutboundMessage, "tenantId" | "toPhone">
): Promise<string | null> {
  if (!account) return sendingGate({ accountId: null, activatedAt: null }, null, brandConfig().name);
  const owner = account.accountId ? await repo.getAccountById(account.accountId) : null;
  const gate = sendingGate(account, owner?.billingStatus ?? null, brandConfig().name);
  if (gate) return gate;
  if (row.toPhone) return optedOutReason(repo, account.locationId, row.tenantId, row.toPhone);
  return null;
}

async function retryTextPart(
  repo: GhlProviderRepo,
  deps: GhlProviderDeps,
  row: GhlOutboundMessage,
  result: DrainGhlOutboundStatusesResult,
  isDefaultNumber: boolean,
  hold: { held: boolean }
): Promise<PartOutcome> {
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
  const target = row.pendingText === null ? null : await resolveDrainTarget(repo, row);
  if (target === null || row.pendingText === null) {
    // Structurally shouldn't happen — see `drainPendingSend`'s identical
    // defensive branch.
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    return { resolved: true, sent: false, reason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED };
  }
  const gateReason = await outboundRefusalReason(repo, await repo.getGhlAccountByLocationId(row.locationId), row);
  if (gateReason) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: gateReason });
    return { resolved: true, sent: false, reason: gateReason };
  }
  result.retried++;
  const sendResult = await deps.sendWhatsapp({ coachId: row.tenantId, ...target, text: row.pendingText, idempotencyKey: row.idempotencyKey });
  if (sendResult.ok) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
    return { resolved: false };
  }
  if (sendResult.code === "session_not_connected") {
    const decision = await resolveNotConnected(repo, row, row, isDefaultNumber);
    if (decision.kind === "hold") {
      hold.held = true;
      return { resolved: false };
    }
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: decision.reason });
    return { resolved: true, sent: false, reason: decision.reason };
  }
  if (isTransientBridgeFailure(sendResult.code)) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "pending_send", sendAttempts: row.sendAttempts + 1 });
    result.stillPending++;
    return { resolved: false };
  }
  const reason = mapSendFailureReason(sendResult.code, isDefaultNumber);
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
  result: DrainGhlOutboundStatusesResult,
  isDefaultNumber: boolean,
  hold: { held: boolean }
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
  const target = part.pendingUrl === null ? null : await resolveDrainTarget(repo, row);
  if (target === null || part.pendingUrl === null) {
    // Structurally shouldn't happen — see `drainPendingSend`'s identical defensive branch.
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED });
    return { resolved: true, sent: false, reason: REASON_BRIDGE_UNREACHABLE_EXHAUSTED };
  }
  // Billing/activation may have changed since intake — same gate as the text part.
  const gateReason = await outboundRefusalReason(repo, await repo.getGhlAccountByLocationId(row.locationId), row);
  if (gateReason) {
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: gateReason });
    return { resolved: true, sent: false, reason: gateReason };
  }
  result.retried++;
  const sendResult = await deps.sendAttachment({
    coachId: row.tenantId,
    ...target,
    attachment: { url: part.pendingUrl, fileName: part.fileName ?? undefined },
    idempotencyKey: part.idempotencyKey,
  });
  if (sendResult.ok) {
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "accepted" });
    return { resolved: false };
  }
  if (sendResult.code === "session_not_connected") {
    // A parent whose text part already failed cannot be held; refuse just this part.
    const decision = row.sendState === "refused"
        ? ({ kind: "refuse", reason: mapSendFailureReason("session_not_connected", isDefaultNumber) } as const)
        : await resolveNotConnected(repo, row, row, isDefaultNumber);
    if (decision.kind === "hold") {
      hold.held = true;
      return { resolved: false };
    }
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: decision.reason });
    return { resolved: true, sent: false, reason: decision.reason };
  }
  if (isTransientBridgeFailure(sendResult.code)) {
    await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "pending_send", sendAttempts: part.sendAttempts + 1 });
    result.stillPending++;
    return { resolved: false };
  }
  const reason = mapSendFailureReason(sendResult.code, isDefaultNumber);
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
    if (isReportedOutcome(outcome)) result.failed++;
    else result.reportFailed++;
    return;
  }

  const account = await repo.getGhlAccountByLocationId(row.locationId);
  // A phone row's phone, or a group row's group (Task 9 — `resolveDrainTarget`).
  const target = account && row.pendingText !== null ? await resolveDrainTarget(repo, row) : null;
  if (!account || !target || row.pendingText === null) {
    // Structurally shouldn't happen — a 'pending_send' row is only ever
    // created with both set (see handleProviderOutboundMessage) — EXCEPT for
    // the overlapping-drains race: a faster concurrent pass can move this row
    // to 'accepted' between when THIS pass read the row and when it gets here
    // (an accepted row now keeps its text until reported, 0013, but this pass's
    // copy may predate that), and a slower pass's transient retry write is
    // conditional on 'pending_send' so it cannot demote the row back. Same
    // check as the exhaustion branch above: before reporting the fixed refusal,
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
    if (isReportedOutcome(outcome)) result.failed++;
    else result.reportFailed++;
    return;
  }

  const gateReason = await outboundRefusalReason(repo, account, row);
  if (gateReason) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: gateReason });
    const gated = await reportGhlOutcome(repo, deps, account, row, "failed", gateReason);
    if (isReportedOutcome(gated)) result.failed++;
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
  if (await holdBehindHeldRows(repo, row.tenantId, row)) {
    result.held++;
    return;
  }
  const sendResult = await deps.sendWhatsapp({ coachId: row.tenantId, ...target, text: row.pendingText, idempotencyKey: row.idempotencyKey });

  if (sendResult.ok) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
    return;
  }
  if (isTransientBridgeFailure(sendResult.code)) {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "pending_send", sendAttempts: row.sendAttempts + 1 });
    result.stillPending++;
    return;
  }

  const isDefaultNumber = isDefaultNumberForRow(row, account);
  if (sendResult.code === "session_not_connected") {
    const decision = await resolveNotConnected(repo, row, row, isDefaultNumber);
    if (decision.kind === "hold") {
      result.held++;
      return;
    }
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: decision.reason });
    const refused = await reportGhlOutcome(repo, deps, account, row, "failed", decision.reason);
    if (isReportedOutcome(refused)) result.failed++;
    else result.reportFailed++;
    return;
  }

  const reason = mapSendFailureReason(sendResult.code, isDefaultNumber);
  await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason });
  const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", reason);
  if (isReportedOutcome(outcome)) result.failed++;
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
    if (isReportedOutcome(outcome)) result.delivered++;
    else result.reportFailed++;
    return;
  }
  if (bridgeMessage.status === "not_on_whatsapp") {
    const unsentText = row.pendingText;
    // SMS fallback B: before the report, so the reason can say it went as SMS.
    // A row with attachments here was sent as one text with the links folded
    // in (media split off): no SMS, so no links go by SMS.
    const sms = await runSmsFallback(repo, deps, { account, row, text: row.hadAttachments ? null : unsentText });
    if (sms === "busy") {
      // Another pass holds this row's SMS; it reports the row.
      result.unresolved++;
      return;
    }
    const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", notOnWhatsappReason(sms));
    if (outcome === "reported") {
      result.failed++;
      await rememberNotOnWhatsappBestEffort(repo, row);
      if (shouldFireNotOnWhatsapp(sms)) fireNotOnWhatsapp(repo, deps, result, row, unsentText);
    } else if (outcome === "already_reported") {
      // An overlapping pass stored it first; that pass remembers and fires.
      result.failed++;
    } else result.reportFailed++;
    return;
  }
  // 'failed' — forward the bridge ledger's own fixed reason (guaranteed a
  // fixed string by the bridge's own hard rule 1; never a raw upstream body).
  await noteGroupLeft(repo, row, [bridgeMessage.error]);
  const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", bridgeMessage.error ?? REASON_SENT_FAILED);
  if (isReportedOutcome(outcome)) result.failed++;
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
  stickyNumberDisconnected: REASON_STICKY_NUMBER_DISCONNECTED,
  capReached: REASON_CAP_REACHED,
  optedOut: REASON_OPTED_OUT,
  optedOutOtherNumber: REASON_OPTED_OUT_OTHER_NUMBER,
  numberBanned: REASON_NUMBER_BANNED,
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
  // Opt-in groups (Task 9).
  groupSyncOff: REASON_GROUP_SYNC_OFF,
  groupLeft: REASON_GROUP_LEFT,
} as const;

// ---------------------------------------------------------------------------
// Read receipts (migration 0010) — reported to GHL after `delivered`.
// ---------------------------------------------------------------------------

/** Only rows this young are considered for a `read` report. */
const READ_RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Fixed `read_report_error` for a final 4xx refusal of the `read` status. */
const REASON_GHL_REFUSED_READ = "GHL refused read status";

export type GhlReadReceiptsRepo = GhlTokenRefreshRepo &
  Pick<
    GhlRepository,
    | "listGhlOutboundAwaitingRead"
    | "markGhlOutboundReadReported"
    // Workflow triggers — `whatsapp_message_read` needs the number and who subscribed.
    | "getTenantPhone"
    | "listLocationNumbers"
    | "listTriggerSubscriptions"
  >;

export interface DrainGhlReadReceiptsResult {
  examined: number;
  reported: number;
  failed: number;
  /** `true` iff this pass stopped early after `DRAIN_TIME_BUDGET_MS`; the rows not reached are left for the next pass. */
  timeBudgetExceeded: boolean;
  /** Workflow-trigger fires not started this pass because an earlier fire in it failed. */
  triggersSkipped: number;
}

/**
 * Reports `read` to GHL for delivered rows whose bridge ledger row has a
 * `read_at`. Never touches `reported_status`. App-originated rows are marked
 * locally without a PUT; a 4xx other than 401 is final (fixed error, never retried); a 5xx,
 * network error or token failure leaves the row for the next pass.
 *
 * The account and token are resolved once per location per pass. A missing
 * token, a 401 or a 5xx skips that location for the rest of the pass: its
 * remaining rows count as failed and get no PUT, and other locations carry
 * on. The same wall-clock budget as `drainGhlOutboundStatuses` applies.
 * Never throws; logs fixed strings only.
 */
/** Starts `whatsapp_message_read` after a successful read PUT this pass stamped. Never throws or awaits. */
function fireMessageRead(repo: GhlReadReceiptsRepo, deps: GhlProviderDeps, pass: TriggerPass, row: GhlOutboundMessage): void {
  startTrigger(pass, async () => {
    const target = await resolvePassTarget(repo, pass, row.locationId, row.tenantId);
    if (!target) return true;
    return fireTriggerBestEffort(repo, deps, row.locationId, "whatsapp_message_read", {
      ...target,
      contactId: row.ghlContactId,
      messageId: row.ghlMessageId,
    });
  });
}

export async function drainGhlReadReceipts(
  repo: GhlReadReceiptsRepo,
  deps: GhlProviderDeps = defaultGhlProviderDeps
): Promise<DrainGhlReadReceiptsResult> {
  const result: DrainGhlReadReceiptsResult = { examined: 0, reported: 0, failed: 0, timeBudgetExceeded: false, triggersSkipped: 0 };
  const startedAtMs = Date.now();

  let rows: GhlOutboundMessage[];
  try {
    rows = (await repo.listGhlOutboundAwaitingRead(DRAIN_BATCH_CAP, new Date(Date.now() - READ_RECEIPT_WINDOW_MS).toISOString())).map((r) => r.message);
    result.examined = rows.length;
  } catch (err) {
    console.error("[ghl-provider.drainGhlReadReceipts] failed to load rows (non-fatal):", err instanceof Error ? err.name : "error");
    return result;
  }

  // Per-location token for this pass (null = no usable token).
  const tokenByLocation = new Map<string, string | null>();
  // Locations skipped for the rest of this pass.
  const skippedLocations = new Set<string>();
  // Workflow triggers: fires start in the background and are awaited once, at the end.
  const pass = newTriggerPass(() => result.triggersSkipped++);

  for (const row of rows) {
    if (Date.now() - startedAtMs >= DRAIN_TIME_BUDGET_MS) {
      result.timeBudgetExceeded = true;
      console.error("[ghl-provider.drainGhlReadReceipts] time budget exceeded; remaining rows left for the next pass.");
      break;
    }
    try {
      if (isAppOriginatedMessageId(row.ghlMessageId)) {
        await repo.markGhlOutboundReadReported(row.id, { readReportError: null });
        continue;
      }
      if (skippedLocations.has(row.locationId)) {
        result.failed++;
        continue;
      }
      let accessToken: string | null;
      if (tokenByLocation.has(row.locationId)) {
        accessToken = tokenByLocation.get(row.locationId) ?? null;
      } else {
        try {
          const account = await repo.getGhlAccountByLocationId(row.locationId);
          accessToken = account ? await resolveGhlAccessToken(repo, deps, account) : null;
        } catch (err) {
          accessToken = null;
          console.error("[ghl-provider.drainGhlReadReceipts] token lookup failed (non-fatal):", err instanceof Error ? err.name : "error");
        }
        tokenByLocation.set(row.locationId, accessToken);
      }
      if (!accessToken) {
        skippedLocations.add(row.locationId);
        result.failed++;
        continue;
      }
      const put = await deps.updateStatus(accessToken, row.ghlMessageId, "read");
      if (put.ok) {
        // Only the pass that stamps the row fires; an overlapping pass that
        // lost the stamp still counts it (GHL has the read either way).
        const won = await repo.markGhlOutboundReadReported(row.id, { readReportError: null });
        result.reported++;
        if (won) fireMessageRead(repo, deps, pass, row);
      } else if (put.status === 401 || (put.status !== undefined && put.status >= 500)) {
        // A token problem or a GHL outage: retry next pass, and spare the
        // rest of this location's rows a PUT that would fail the same way.
        skippedLocations.add(row.locationId);
        result.failed++;
      } else if (put.status !== undefined && put.status >= 400 && put.status < 500) {
        await repo.markGhlOutboundReadReported(row.id, { readReportError: REASON_GHL_REFUSED_READ });
        result.failed++;
      } else {
        result.failed++;
      }
    } catch (err) {
      result.failed++;
      console.error("[ghl-provider.drainGhlReadReceipts] row failed (non-fatal):", err instanceof Error ? err.name : "error");
    }
  }
  await settleTriggers(pass);
  return result;
}
