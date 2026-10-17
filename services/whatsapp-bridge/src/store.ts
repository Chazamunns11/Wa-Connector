/**
 * Supabase persistence for the bridge — sessions, Signal keys, the outbound
 * message idempotency ledger, and (0048) the inbound reply table
 * (supabase/migrations/0046_whatsapp_sessions.sql and
 * 0048_whatsapp_inbound.sql in the portal repo document each table's
 * contract; this module is the only code that touches them from the bridge
 * side).
 *
 * Service-role client, deliberately: every one of these tables has RLS
 * enabled with NO policies (0046's and 0048's file headers), so nothing
 * short of the service key can read them — the same posture as the portal's
 * own `getServiceClient()` (src/lib/data/supabase.ts) but from a different
 * trust domain (Railway, not Vercel). This is also the load-bearing fact
 * behind 0048's anti-forgery argument: the bridge is the ONLY writer of
 * inbound reply rows, so a forged reply is structurally impossible — there
 * is no portal HTTP endpoint that accepts reply data at all (see
 * src/poke.ts).
 *
 * ENCRYPTION BOUNDARY: this module receives/returns PLAINTEXT credential
 * JSON and encrypts/decrypts at the storage edge via the injected
 * `CredsCipher` (src/crypto.ts) — so no caller above this layer can
 * accidentally persist plaintext, and no code below it ever sees plaintext.
 * Nothing in this module logs a value column, in either form.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BridgeConfig } from "./config.js";
import { createCredsCipher, whatsappCredsAad, whatsappKeyAad, type CredsCipher } from "./crypto.js";
import { isValidWaMessageId } from "./media.js";
import { GROUP_SEND_CAP_UNITS, isGroupJid } from "./groups.js";

/** Mirrors the portal's `WhatsappSessionStatus` (src/lib/types.ts) and the 0046 CHECK constraint — keep all three in lockstep. */
export type SessionStatus = "disconnected" | "waiting_qr" | "connected" | "logged_out" | "banned";

export type MessageStatus = "accepted" | "sending" | "sent" | "failed" | "not_on_whatsapp";

export interface MessageRecord {
  id: string;
  coachId: string;
  idempotencyKey: string;
  /** The 1:1 recipient (strict E.164), or null for a group send. Exactly one of `toPhone` / `groupJid` is set (0008's `whatsapp_messages_one_target`). */
  toPhone: string | null;
  /** The opted-in WhatsApp group this row was sent to (src/groups.ts), or null for a 1:1 send. Null too on a row read before migration 0008 (PostgREST omits the unknown column). */
  groupJid: string | null;
  status: MessageStatus;
  waMessageId: string | null;
  error: string | null;
  /**
   * True iff the bridge actually invoked Baileys' send API for this attempt
   * (as opposed to failing before ever touching the wire). Distinguishes,
   * within `status === 'failed'`, "definitely never dispatched — safe to
   * reissue under a new idempotency key" (false) from "dispatch was
   * attempted and the outcome is UNCERTAIN — may have already reached the
   * recipient" (true). Without this split, every 'failed' row looked
   * equally safe to retry, which is exactly how a future caller's retry
   * policy could double-message a human (hard rule 3).
   */
  dispatchAttempted: boolean;
  createdAt: string;
  sentAt: string | null;
  /** Media plan (docs/MEDIA-PLAN.md §7c) — `'text'` for every row this bridge has ever written before the media plan, and for every row today (WA_MEDIA_OUTBOUND_ENABLED defaults false). Defaults to `'text'` when the migration 0073 column isn't present in the read row at all (pre-migration deploys), never guessed the other way. */
  kind: "text" | "media";
}

interface MessageRow {
  id: string;
  coach_id: string;
  idempotency_key: string;
  to_phone: string | null;
  /** Absent entirely on a row read before migration 0008 is applied. */
  group_jid?: string | null;
  status: MessageStatus;
  wa_message_id: string | null;
  error: string | null;
  dispatch_attempted: boolean;
  created_at: string;
  sent_at: string | null;
  /** Absent entirely (not merely null) on a Supabase row read before migration 0073 is applied — PostgREST simply omits unknown columns. */
  kind?: "text" | "media";
}

/** Who a send goes to: one phone number, or one opted-in group. Never both — the ledger's CHECK (0008) refuses a row naming both, and so does this type. */
export type MessageTarget = { toPhone: string } | { groupJid: string };

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    coachId: row.coach_id,
    idempotencyKey: row.idempotency_key,
    toPhone: row.to_phone,
    groupJid: row.group_jid ?? null,
    status: row.status,
    waMessageId: row.wa_message_id,
    error: row.error,
    dispatchAttempted: row.dispatch_attempted,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    kind: row.kind ?? "text",
  };
}

export class BridgeStore {
  private readonly supabase: SupabaseClient;
  private readonly cipher: CredsCipher;

  constructor(config: BridgeConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.cipher = createCredsCipher(config.credsKey, config.credsKeyPrevious);
  }

  // -------------------------------------------------------------------------
  // whatsapp_sessions — status + creds blob
  // -------------------------------------------------------------------------

  /** Every coach id that has a session row with linked creds — the boot-time resume list. */
  async listResumableCoachIds(): Promise<string[]> {
    const { data, error } = await this.supabase
      .from("whatsapp_sessions")
      .select("coach_id")
      .not("creds_enc", "is", null);
    if (error) throw error;
    return ((data ?? []) as { coach_id: string }[]).map((r) => r.coach_id);
  }

  /** Ensures the session row exists (first /connect for a coach) without touching an existing row's creds/status. */
  async ensureSessionRow(coachId: string): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_sessions")
      .upsert({ coach_id: coachId }, { onConflict: "coach_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  /**
   * Decrypted Baileys creds JSON for a coach, or null when no device is
   * linked. A DECRYPT FAILURE (tampered row, wrong key) throws — callers
   * must treat that as "unusable, re-link required", NEVER as "no creds"
   * (silently re-registering a fresh device over a tamper signal would hide
   * the one symptom a compromise has).
   */
  async loadCreds(coachId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("whatsapp_sessions")
      .select("creds_enc")
      .eq("coach_id", coachId)
      .maybeSingle();
    if (error) throw error;
    const enc = (data as { creds_enc: string | null } | null)?.creds_enc ?? null;
    if (!enc) return null;
    return this.cipher.decrypt(enc, whatsappCredsAad(coachId));
  }

  async saveCreds(coachId: string, credsJson: string): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_sessions")
      .update({ creds_enc: this.cipher.encrypt(credsJson, whatsappCredsAad(coachId)) })
      .eq("coach_id", coachId);
    if (error) throw error;
  }

  /**
   * Status transition, written whenever the session lifecycle moves — this
   * is the ONLY signal the portal reads (via
   * `Repository.getWhatsappSessionSummaries`), so it must always reflect
   * reality even when nobody is watching. `phoneNumber` is set on 'connected'
   * (the linked number, for the UI card) and left untouched otherwise unless
   * explicitly cleared.
   */
  async setSessionStatus(
    coachId: string,
    status: SessionStatus,
    opts?: { phoneNumber?: string | null; disconnectReason?: string | null; touchLastConnected?: boolean }
  ): Promise<void> {
    const patch: Record<string, unknown> = { status };
    if (opts && "phoneNumber" in opts) patch.phone_number = opts.phoneNumber;
    if (opts?.disconnectReason !== undefined) patch.last_disconnect_reason = opts.disconnectReason;
    if (opts?.touchLastConnected) patch.last_connected_at = new Date().toISOString();
    const { error } = await this.supabase.from("whatsapp_sessions").update(patch).eq("coach_id", coachId);
    if (error) throw error;
  }

  /**
   * Warm-up (src/pacing.ts `WARMUP_SCHEDULE`): returns when `phoneNumber`
   * was first linked on this tenant, in ms. Keeps the stored
   * `phone_linked_at` when the row already holds this same number; stamps
   * now() when the number is new or the date is missing. Must run BEFORE the
   * 'connected' status write replaces `phone_number`, since it compares
   * against the stored number. `wipeCreds` clears the date, so a number
   * linked after a logout or ban always starts its warm-up again.
   */
  async markPhoneLinked(coachId: string, phoneNumber: string): Promise<number> {
    const { data, error } = await this.supabase
      .from("whatsapp_sessions")
      .select("phone_number, phone_linked_at")
      .eq("coach_id", coachId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { phone_number: string | null; phone_linked_at: string | null } | null;
    if (row?.phone_number === phoneNumber && row.phone_linked_at) return Date.parse(row.phone_linked_at);
    const now = new Date();
    const { error: updateError } = await this.supabase.from("whatsapp_sessions").update({ phone_linked_at: now.toISOString() }).eq("coach_id", coachId);
    if (updateError) throw updateError;
    return now.getTime();
  }

  /**
   * Full credential wipe — logout, ban, or an explicit unlink. Removes the
   * creds blob AND every Signal key row: a logged-out device's key material
   * is dead weight that still reads as a credential, so it must not linger.
   */
  async wipeCreds(coachId: string, finalStatus: "logged_out" | "banned" | "disconnected", reason: string): Promise<void> {
    const { error: keysError } = await this.supabase.from("whatsapp_session_keys").delete().eq("coach_id", coachId);
    if (keysError) throw keysError;
    const { error } = await this.supabase
      .from("whatsapp_sessions")
      .update({ creds_enc: null, phone_number: null, phone_linked_at: null, status: finalStatus, last_disconnect_reason: reason })
      .eq("coach_id", coachId);
    if (error) throw error;
  }

  // -------------------------------------------------------------------------
  // whatsapp_session_keys — the SignalKeyStore backing rows
  // -------------------------------------------------------------------------

  /** Batch get for Baileys `keys.get(type, ids)` — returns decrypted JSON per key id (missing ids simply absent). */
  async getKeys(coachId: string, category: string, ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const { data, error } = await this.supabase
      .from("whatsapp_session_keys")
      .select("key_id, value_enc")
      .eq("coach_id", coachId)
      .eq("category", category)
      .in("key_id", ids);
    if (error) throw error;
    const out: Record<string, string> = {};
    for (const row of (data ?? []) as { key_id: string; value_enc: string }[]) {
      out[row.key_id] = this.cipher.decrypt(row.value_enc, whatsappKeyAad(coachId, category, row.key_id));
    }
    return out;
  }

  /** Batch set/delete for Baileys `keys.set(data)` — value null means delete (mirrors useMultiFileAuthState's file-unlink branch). */
  async setKeys(coachId: string, writes: { category: string; keyId: string; valueJson: string | null }[]): Promise<void> {
    const upserts = writes
      .filter((w): w is { category: string; keyId: string; valueJson: string } => w.valueJson !== null)
      .map((w) => ({
        coach_id: coachId,
        category: w.category,
        key_id: w.keyId,
        value_enc: this.cipher.encrypt(w.valueJson, whatsappKeyAad(coachId, w.category, w.keyId)),
        updated_at: new Date().toISOString(),
      }));
    if (upserts.length > 0) {
      const { error } = await this.supabase
        .from("whatsapp_session_keys")
        .upsert(upserts, { onConflict: "coach_id,category,key_id" });
      if (error) throw error;
    }
    const deletes = writes.filter((w) => w.valueJson === null);
    for (const del of deletes) {
      const { error } = await this.supabase
        .from("whatsapp_session_keys")
        .delete()
        .eq("coach_id", coachId)
        .eq("category", del.category)
        .eq("key_id", del.keyId);
      if (error) throw error;
    }
  }

  // -------------------------------------------------------------------------
  // whatsapp_sessions.lock_* — the single-writer lease (src/lock.ts drives this)
  // -------------------------------------------------------------------------

  /**
   * Atomic lease claim: succeeds iff the lease is free, already ours, or
   * stale (heartbeat older than ttlMs). One UPDATE with the guard in the
   * WHERE clause — same "row count tells you who won" pattern as the
   * portal's `claimAutomationSequenceRun` (src/lib/data/supabase.ts).
   */
  async claimSessionLock(coachId: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const staleBefore = new Date(Date.now() - ttlMs).toISOString();
    const { data, error } = await this.supabase
      .from("whatsapp_sessions")
      .update({ lock_instance_id: instanceId, lock_heartbeat_at: new Date().toISOString() })
      .eq("coach_id", coachId)
      .or(`lock_instance_id.is.null,lock_instance_id.eq.${instanceId},lock_heartbeat_at.lt.${staleBefore}`)
      .select("coach_id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  /** Heartbeat renew — succeeds only while we still hold the lease; a false return means a rival stole it (we were presumed dead) and the caller must kill its socket. */
  async renewSessionLock(coachId: string, instanceId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("whatsapp_sessions")
      .update({ lock_heartbeat_at: new Date().toISOString() })
      .eq("coach_id", coachId)
      .eq("lock_instance_id", instanceId)
      .select("coach_id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  /** Graceful release (SIGTERM path) — only clears the lease if it is still ours, so a slow shutdown can't release a rival's fresh claim. */
  async releaseSessionLock(coachId: string, instanceId: string): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_sessions")
      .update({ lock_instance_id: null, lock_heartbeat_at: null })
      .eq("coach_id", coachId)
      .eq("lock_instance_id", instanceId);
    if (error) throw error;
  }

  // -------------------------------------------------------------------------
  // whatsapp_messages — idempotency ledger (hard rule 3)
  // -------------------------------------------------------------------------

  /**
   * Insert-or-replay: inserts the 'accepted' row, and if (coach_id,
   * idempotency_key) already exists returns the EXISTING record with
   * `fresh: false` instead — the caller then reports that row's status and
   * dispatches nothing. The unique constraint (0046) is the dedupe; this
   * method just surfaces which side of it we landed on.
   *
   * A group target is re-checked against `isGroupJid` here, before the
   * insert (src/groups.ts — validate before ANY store write), and only the
   * target's own column is named: a 1:1 insert never mentions `group_jid`,
   * so it is byte-identical to the pre-0008 insert.
   */
  async acceptMessage(
    coachId: string,
    idempotencyKey: string,
    target: MessageTarget,
    /** Media plan (docs/MEDIA-PLAN.md §7c) — omitted (or `'text'`) writes NOTHING new to the insert, so a pre-migration-0073 database is untouched: the column's own `default 'text'` covers it. Only ever `'media'` from the (WA_MEDIA_OUTBOUND_ENABLED-gated) attachment send path. */
    kind: "text" | "media" = "text"
  ): Promise<{ record: MessageRecord; fresh: boolean }> {
    const row: Record<string, unknown> = { coach_id: coachId, idempotency_key: idempotencyKey };
    if ("groupJid" in target) {
      if (!isGroupJid(target.groupJid)) throw new Error("[store] acceptMessage: refused a malformed group jid");
      row.group_jid = target.groupJid;
    } else {
      row.to_phone = target.toPhone;
    }
    if (kind === "media") row.kind = kind;
    const { data, error } = await this.supabase.from("whatsapp_messages").insert(row).select("*").maybeSingle();
    if (!error && data) return { record: mapMessage(data as MessageRow), fresh: true };
    // 23505 = unique_violation — the replay path, not a failure.
    if (error && error.code !== "23505") throw error;
    const existing = await this.getMessage(coachId, idempotencyKey);
    if (!existing) throw new Error("[store] idempotency conflict but existing row not found — should be impossible");
    return { record: existing, fresh: false };
  }

  async getMessage(coachId: string, idempotencyKey: string): Promise<MessageRecord | null> {
    const { data, error } = await this.supabase
      .from("whatsapp_messages")
      .select("*")
      .eq("coach_id", coachId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    return data ? mapMessage(data as MessageRow) : null;
  }

  /**
   * The send claim ('accepted' -> 'sending') — the ONLY gate to an actual
   * Baileys send, so a duplicate dispatch is structurally impossible even if
   * two workers somehow hold the same queued message (same claim-then-send
   * shape as the portal's sequence engine, src/lib/sequences.ts).
   */
  async claimMessage(messageId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("whatsapp_messages")
      .update({ status: "sending" })
      .eq("id", messageId)
      .eq("status", "accepted")
      .select("id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async markMessageSent(messageId: string, waMessageId: string | null): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_messages")
      .update({ status: "sent", wa_message_id: waMessageId, sent_at: new Date().toISOString() })
      .eq("id", messageId)
      .eq("status", "sending");
    if (error) throw error;
  }

  /**
   * @param dispatchAttempted see `MessageRecord.dispatchAttempted` — the
   *   caller (src/sessions.ts) is the only place that knows whether Baileys'
   *   send API was actually invoked for this attempt, so it MUST pass this
   *   explicitly rather than the store guessing from the error text.
   * @param errorMessage a FIXED reason string only (see
   *   src/sessions.ts's `mapSendErrorReason` / `disconnectReasonLabel`) —
   *   never the raw upstream error message. This column is returned
   *   verbatim by two authenticated API routes (server.ts), so anything
   *   written here is effectively public to the portal.
   */
  async markMessageFailed(messageId: string, errorMessage: string, dispatchAttempted: boolean): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_messages")
      .update({ status: "failed", error: errorMessage, dispatch_attempted: dispatchAttempted })
      .eq("id", messageId)
      .in("status", ["accepted", "sending"]);
    if (error) throw error;
  }

  /** Recipient has no WhatsApp account (the onWhatsApp pre-check said no) — terminal, distinct from 'failed' so the portal can show "not on WhatsApp" rather than a scary error. */
  async markMessageNotOnWhatsapp(messageId: string): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_messages")
      .update({ status: "not_on_whatsapp" })
      .eq("id", messageId)
      .in("status", ["accepted", "sending"]);
    if (error) throw error;
  }

  /**
   * This coach's dispatch activity for the current UTC day — seeds BOTH
   * in-memory pacer clocks (src/pacing.ts) at session start so a restart
   * cannot reset a spent budget or shrink the min-gap below what it should
   * be:
   *   - `attemptCount`: every row that actually reached the wire today —
   *     `status = 'sent'` OR (`status = 'failed'` AND `dispatch_attempted`).
   *     Counting only `'sent'` (the previous behaviour) UNDERCOUNTS: an
   *     attempt that hit WhatsApp's servers and then failed still used up
   *     the day's send budget (pacing.ts's `recordSend` JSDoc says exactly
   *     this), so a restart after a run of dispatched-but-failed sends used
   *     to hand the coach extra budget for the rest of the day.
   *   - `lastAttemptAt`: the most recent dispatch (sent_at for a 'sent' row,
   *     created_at as the closest available proxy for a dispatched-but-
   *     'failed' row) — seeds the pacer's min-gap clock so a restart landing
   *     seconds after the previous instance's last send doesn't reset to
   *     "no wait needed".
   *
   * `attemptCount` is in daily-cap UNITS, not rows: a dispatched group row
   * (`group_jid` set) counts `GROUP_SEND_CAP_UNITS` (5), the same as the
   * pacer recorded when it sent it — otherwise a restart would hand back 4
   * units per group send. `select("*")` rather than naming `group_jid`, so
   * this read still works on a database without migration 0008 (the column
   * is then simply absent and every row counts 1, which is right: no group
   * row can exist there).
   */
  async getDailyActivity(coachId: string): Promise<{ attemptCount: number; lastAttemptAt: string | null }> {
    const midnightUtc = new Date();
    midnightUtc.setUTCHours(0, 0, 0, 0);
    const { data, error } = await this.supabase
      .from("whatsapp_messages")
      .select("*")
      .eq("coach_id", coachId)
      .gte("created_at", midnightUtc.toISOString());
    if (error) throw error;
    const rows = (data ?? []) as { status: MessageStatus; dispatch_attempted: boolean; sent_at: string | null; created_at: string; group_jid?: string | null }[];
    let attemptCount = 0;
    let lastAttemptAt: string | null = null;
    for (const row of rows) {
      const dispatched = row.status === "sent" || (row.status === "failed" && row.dispatch_attempted);
      if (!dispatched) continue;
      attemptCount += row.group_jid ? GROUP_SEND_CAP_UNITS : 1;
      const at = row.sent_at ?? row.created_at;
      if (!lastAttemptAt || at > lastAttemptAt) lastAttemptAt = at;
    }
    return { attemptCount, lastAttemptAt };
  }

  /**
   * Boot-time sweep (per coach, run when its session starts):
   *   - 'sending' rows are UNCERTAIN (an instance died between claim and
   *     mark — the message may or may not have reached WhatsApp) — marked
   *     'failed' with `dispatch_attempted = true` (it DID reach the send
   *     API), NEVER auto-retried: at-most-once beats at-least-once when the
   *     recipient is a human (hard rule 3).
   *   - 'accepted' rows never got dispatched — `dispatch_attempted` is
   *     always false for these. ALL of them end up 'failed'; a body-less
   *     'accepted' row cannot be resent because message bodies are
   *     deliberately never stored (0046's file header — privacy), so
   *     "re-enqueue" is not actually possible for either age bucket. The
   *     bucket only changes WHICH layer writes the row and which reason
   *     string lands in it: rows older than `maxAgeMs` are failed HERE
   *     ("expired in queue"); more recent ones are returned to the caller
   *     (src/sessions.ts's boot sweep) so it can fail them with a distinct
   *     "bridge restarted before dispatch" reason. Either way the ledger
   *     entry survives with `dispatch_attempted = false`, so a future
   *     retry policy reading this row correctly sees "safe to reissue under
   *     a new idempotency key".
   */
  async sweepInterruptedMessages(coachId: string, maxAgeMs: number): Promise<MessageRecord[]> {
    const { error: sendingError } = await this.supabase
      .from("whatsapp_messages")
      .update({ status: "failed", error: "interrupted mid-send (bridge restarted between claim and mark) — never auto-retried", dispatch_attempted: true })
      .eq("coach_id", coachId)
      .eq("status", "sending");
    if (sendingError) throw sendingError;

    const tooOldBefore = new Date(Date.now() - maxAgeMs).toISOString();
    const { error: staleError } = await this.supabase
      .from("whatsapp_messages")
      .update({ status: "failed", error: "expired in queue (bridge was down past the re-enqueue window)", dispatch_attempted: false })
      .eq("coach_id", coachId)
      .eq("status", "accepted")
      .lt("created_at", tooOldBefore);
    if (staleError) throw staleError;

    const { data, error } = await this.supabase
      .from("whatsapp_messages")
      .select("*")
      .eq("coach_id", coachId)
      .eq("status", "accepted")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as MessageRow[]).map(mapMessage);
  }

  // -------------------------------------------------------------------------
  // whatsapp_inbound_messages (0048) — inbound replies. See
  // src/inbound.ts's file header for the filter chain; this section is just
  // the Supabase call it needs. (PortalHub's coach-only ledger-gate read,
  // `wasProspectSent`, was removed with the coach path.)
  // -------------------------------------------------------------------------

  /**
   * Insert-or-ignore against 0048's unique `(coach_id, wa_message_id)`
   * constraint — the SAME "let the DB constraint be the real dedupe, this
   * method just reports which side we landed on" shape as `acceptMessage`
   * above. `fresh: false` means this exact WhatsApp message id was already
   * recorded for this coach (a Baileys redelivery on reconnect/offline
   * resync) — the caller (src/inbound.ts's `processInboundBatch`) uses this
   * to skip poking the portal a second time for a message it already knows
   * about.
   *
   * Group rows (0007): `groupJid` is re-checked against `isGroupJid` BEFORE
   * the insert — this column has no CHECK of its own, so this is the gate
   * (src/groups.ts). A 1:1 row names neither `group_jid` nor `sender_name`,
   * so its insert is byte-identical to the pre-0007 one.
   */
  async recordInboundMessage(input: {
    coachId: string;
    fromPhone: string;
    waMessageId: string;
    body: string | null;
    messageType: string;
    receivedAt: string;
    /** Media plan (docs/MEDIA-PLAN.md §6.1/§7a) — see `RecordInboundInput.captureMedia`'s own JSDoc (src/inbound.ts). Omitted/false -> `media_status` is never named in the insert, so it stays the column's default (NULL) — byte-identical to pre-media-plan rows. */
    captureMedia?: boolean;
    /** The opted-in group this message came from, or null/omitted for a 1:1 reply. */
    groupJid?: string | null;
    /** The group member's push name (<=60 chars, src/inbound.ts), or null. Only written on a group row. */
    senderName?: string | null;
  }): Promise<{ fresh: boolean }> {
    if (input.groupJid != null && !isGroupJid(input.groupJid)) {
      throw new Error("[store] recordInboundMessage: refused a malformed group jid");
    }
    const row: Record<string, unknown> = {
      coach_id: input.coachId,
      from_phone: input.fromPhone,
      wa_message_id: input.waMessageId,
      body: input.body,
      message_type: input.messageType,
      received_at: input.receivedAt,
    };
    if (input.captureMedia) row.media_status = "pending";
    if (input.groupJid != null) {
      row.group_jid = input.groupJid;
      row.sender_name = input.senderName ?? null;
    }
    const { data, error } = await this.supabase.from("whatsapp_inbound_messages").insert(row).select("id").maybeSingle();
    if (!error && data) return { fresh: true };
    // 23505 = unique_violation on (coach_id, wa_message_id) — a redelivery, not a failure.
    if (error && error.code !== "23505") throw error;
    return { fresh: false };
  }

  // -------------------------------------------------------------------------
  // whatsapp_groups (0007) — the opt-in switch per (number, group). Read-only
  // here: the app writes it when the owner enables a group.
  // -------------------------------------------------------------------------

  /**
   * The group JIDs this tenant's owner has enabled and the number has not
   * left — the source of `Session.enabledGroups` (src/sessions.ts). Rows are
   * filtered through `isGroupJid` once more on the way out (0007's CHECK
   * already holds them to it), so the in-memory set can only ever hold
   * well-formed JIDs. Note the column is `tenant_id` here, not the
   * historical `coach_id` the whatsapp_* tables use.
   */
  async listEnabledGroupJids(tenantId: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from("whatsapp_groups")
      .select("group_jid")
      .eq("tenant_id", tenantId)
      .eq("enabled", true)
      .is("left_at", null);
    if (error) throw error;
    return ((data ?? []) as { group_jid: string }[]).map((r) => r.group_jid).filter(isGroupJid);
  }

  // -------------------------------------------------------------------------
  // Media plan (docs/MEDIA-PLAN.md §6) — inbound media capture bookkeeping.
  // Every method here is a no-op-safe pure Supabase call; the STATE MACHINE
  // (pending -> stored/too_large/rate_limited/failed) and the abuse-gate
  // decision live in src/media-capture.ts / src/media-abuse-gate.ts, both
  // deps-injected against these methods so they're unit-testable with fakes.
  // -------------------------------------------------------------------------

  /**
   * Terminal (or, in principle, intermediate) media-capture state for one
   * row, keyed by the SAME natural key `recordInboundMessage` dedupes on
   * (`coach_id, wa_message_id`) — avoids threading the row's numeric `id`
   * back through `recordInboundMessage`'s return value just for this.
   */
  async updateInboundMediaStatus(
    coachId: string,
    waMessageId: string,
    patch:
      | { status: "stored"; path: string; mime: string; sizeBytes: number }
      | { status: "too_large" | "rate_limited" | "failed" }
  ): Promise<void> {
    const update: Record<string, unknown> =
      patch.status === "stored"
        ? { media_status: "stored", media_path: patch.path, media_mime: patch.mime, media_size_bytes: patch.sizeBytes }
        : { media_status: patch.status };
    const { error } = await this.supabase
      .from("whatsapp_inbound_messages")
      .update(update)
      .eq("coach_id", coachId)
      .eq("wa_message_id", waMessageId);
    if (error) throw error;
  }

  /** Abuse gate (plan §9) — count of THIS sender's media-capture ATTEMPTS (any non-null `media_status` — pending/stored/too_large/rate_limited/failed all count; the cap protects against attempted bandwidth/CPU spend, not only successful stores) for this tenant, since UTC midnight. Callers front this with `MediaAbuseGate`'s per-process cache rather than calling once per file. */
  async countInboundMediaAttemptsForSenderToday(coachId: string, fromPhone: string): Promise<number> {
    const midnightUtc = new Date();
    midnightUtc.setUTCHours(0, 0, 0, 0);
    const { count, error } = await this.supabase
      .from("whatsapp_inbound_messages")
      .select("id", { count: "exact", head: true })
      .eq("coach_id", coachId)
      .eq("from_phone", fromPhone)
      .not("media_status", "is", null)
      .gte("created_at", midnightUtc.toISOString());
    if (error) throw error;
    return count ?? 0;
  }

  /** Abuse gate (plan §9) — same as above, scoped to the whole tenant rather than one sender. */
  async countInboundMediaAttemptsForTenantToday(coachId: string): Promise<number> {
    const midnightUtc = new Date();
    midnightUtc.setUTCHours(0, 0, 0, 0);
    const { count, error } = await this.supabase
      .from("whatsapp_inbound_messages")
      .select("id", { count: "exact", head: true })
      .eq("coach_id", coachId)
      .not("media_status", "is", null)
      .gte("created_at", midnightUtc.toISOString());
    if (error) throw error;
    return count ?? 0;
  }

  /**
   * Uploads bytes ALREADY sniffed/allowlisted/size-capped (src/media-capture.ts
   * has done all three before this is ever called) to the private media
   * bucket (plan §6.2 decision I3 — no policies on `storage.objects` for this
   * bucket; signed URLs, minted by the PORTAL's drain, are the sole read
   * path — this bridge never mints one). `upsert: false` — a path collision
   * (same coachId + waMessageId + extension) should never happen given the
   * dedupe upstream, so a collision is treated as a genuine error rather than
   * silently overwritten.
   */
  async uploadMediaObject(bucket: string, path: string, bytes: Buffer, contentType: string): Promise<void> {
    // QA Major 4 fix, defence in depth — `media-capture.ts` already
    // validates the sender-controlled `waMessageId` before it ever builds
    // this path, but that check lives one hop away from the actual network
    // call. Re-derive the waMessageId segment from the exact path shape
    // that caller builds (`{coachId}/{waMessageId}.{ext}`, plan §6.1) and
    // re-validate it here too, so a future caller can't reintroduce the
    // traversal bug by skipping the upstream check.
    const match = /^[^/]+\/([^/]+)\.[^./]+$/.exec(path);
    const waMessageIdSegment = match?.[1];
    if (!waMessageIdSegment || !isValidWaMessageId(waMessageIdSegment)) {
      throw new Error("uploadMediaObject: refused an unsafe storage path");
    }
    const { error } = await this.supabase.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
    if (error) throw error;
  }

  // -------------------------------------------------------------------------
  // Sanity read used by the send route (hard rule 2's belt-and-braces)
  // -------------------------------------------------------------------------

  /**
   * True iff this tenant id exists at all — lets routes 404 an unknown/
   * mistyped id instead of creating orphan state for it. RENAMED from
   * `coachExists` (portal migration 0069_ghl_provider.sql, GHL custom
   * conversation provider Phase 1): the bridge's session key is no longer
   * always a coach — 0069 generalises it to `whatsapp_tenants`. Here every
   * row is a fresh id backing a GHL location (kind `'ghl_location'`, the
   * only kind 0001_init.sql allows). Every OTHER piece of
   * bridge code already treated this id as opaque (sessions map, AAD
   * binding, lease, pacer, ledger — see 0069's file header) — this was the
   * only query that assumed "coach". Same shape, same query cost, just a
   * different table.
   */
  async tenantExists(tenantId: string): Promise<boolean> {
    const { data, error } = await this.supabase.from("whatsapp_tenants").select("id").eq("id", tenantId).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
}
