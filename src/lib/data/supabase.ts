/**
 * Service-role Supabase implementation of `GhlRepository`.
 *
 * Copied from PortalHub `src/lib/data/supabase.ts`: the 27 provider-slice
 * methods plus the row shapes/mappers they use. Adaptations: the object
 * literal becomes the `SupabaseGhlRepository` class, `call_id` is gone from
 * the inbound row (the schema dropped it), and the Supabase client is created
 * lazily (importing this module needs no env; the first query does).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  GhlAccount,
  GhlAccountBrandingPatch,
  GhlAccountDraft,
  GhlAccountStatus,
  GhlAccountSummary,
  GhlOutboundAttachment,
  GhlOutboundAttachmentDraft,
  GhlOutboundAttachmentSendState,
  GhlOutboundMessage,
  GhlOutboundMessageDraft,
  GhlOutboundReportedStatus,
  GhlOutboundSendState,
  LocationNumber,
  Scope,
  WhatsappInboundMessage,
  WhatsappSessionStatus,
  WhatsappSessionSummary,
} from "@/lib/types";
import { LOGO_BUCKET, LOGO_EXTENSION, normaliseHex, type SafeLogoType } from "@/lib/brand";
import { ghlTenantKeyQueryFilters } from "@/lib/ghl";
import {
  buildGhlHealthSnapshot,
  GHL_HEALTH_INBOUND_ROW_CAP,
  GHL_HEALTH_INBOUND_WINDOW_DAYS,
  GHL_HEALTH_OUTBOUND_BACKLOG_CAP,
  type GhlHealthLocation,
  type GhlInboundHealthRow,
  type GhlOutboundHealthRow,
  type GhlWaitingHealthRow,
} from "@/lib/ghl-health";
import { nextFreeSlot, promoteAfterRemoval, shouldReplaceSticky } from "@/lib/location-numbers";
import type { GhlRepository } from "./repository";

/**
 * Server-only service-role client. Every method in this file is service-role:
 * the tables are RLS-enabled with NO policies, so there is no user-session
 * path to them. Created lazily so merely importing this module never throws
 * when the env is absent (build, tests); the first query does.
 */
function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required " +
        "(the service-role client bypasses RLS)."
    );
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// WhatsApp bridge foundation — summary row shape + mapper
// (supabase/migrations/0046_whatsapp_sessions.sql). The column list is THE
// security boundary for portal reads: `creds_enc`/`lock_*` are deliberately
// absent, so no caller of getWhatsappSessionSummaries/getWhatsappSessionSummary
// can ever receive credential-adjacent data, whatever it does with the result.
// ---------------------------------------------------------------------------

const WHATSAPP_SESSION_SUMMARY_COLUMNS =
  "coach_id, status, phone_number, last_connected_at, last_disconnect_reason";

interface WhatsappSessionSummaryRow {
  coach_id: string;
  status: WhatsappSessionStatus;
  phone_number: string | null;
  last_connected_at: string | null;
  last_disconnect_reason: string | null;
}

function mapWhatsappSessionSummary(row: WhatsappSessionSummaryRow, sentToday: number): WhatsappSessionSummary {
  return {
    coachId: row.coach_id,
    status: row.status,
    phoneNumber: row.phone_number,
    lastConnectedAt: row.last_connected_at,
    lastDisconnectReason: row.last_disconnect_reason,
    sentToday,
  };
}

// ---------------------------------------------------------------------------
// BATCH 4 (29 Jul 2026) — inbound WhatsApp reply row shape + mapper
// (supabase/migrations/0048_whatsapp_inbound.sql). The column list is
// explicit (mirrors `WHATSAPP_SESSION_SUMMARY_COLUMNS`'s convention) even
// though 0048 has no credential-adjacent column to exclude — kept explicit
// anyway so a future column added to this table doesn't silently start
// riding along into a page prop without a deliberate decision to select it.
// ---------------------------------------------------------------------------

interface WhatsappInboundMessageRow {
  id: string;
  coach_id: string;
  from_phone: string;
  body: string | null;
  message_type: string;
  received_at: string;
  processed_at: string | null;
  resolution: string | null;
  /** GHL provider Phase 3 (0072) — see `WhatsappInboundMessage.pushAttempts`'s JSDoc. Always 0 for a coach-tenant row. */
  push_attempts: number;
  /** GHL provider Phase 3 (0072) — see `WhatsappInboundMessage.pushError`'s JSDoc. Always null for a coach-tenant row. */
  push_error: string | null;
  created_at: string;
  /** Media plan (0073) — absent entirely (not merely null) on a row read before migration 0073 is applied; PostgREST simply omits unknown columns. See `WhatsappInboundMessage.mediaStatus`'s JSDoc. */
  media_status?: "pending" | "stored" | "too_large" | "rate_limited" | "failed" | null;
  media_path?: string | null;
  media_mime?: string | null;
  media_size_bytes?: number | null;
}

function mapWhatsappInboundMessage(row: WhatsappInboundMessageRow): WhatsappInboundMessage {
  return {
    id: row.id,
    coachId: row.coach_id,
    fromPhone: row.from_phone,
    body: row.body,
    messageType: row.message_type,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    resolution: row.resolution,
    pushAttempts: row.push_attempts,
    pushError: row.push_error,
    createdAt: row.created_at,
    mediaStatus: row.media_status ?? null,
    mediaPath: row.media_path ?? null,
    mediaMime: row.media_mime ?? null,
    mediaSizeBytes: row.media_size_bytes ?? null,
  };
}

/** Media plan (docs/MEDIA-PLAN.md §6.1) — "the drain's list query treats `pending` older than 10 minutes as failed" — a row this fresh simply isn't ready to be judged yet (the bridge may still be mid-download/mid-upload), so it is excluded from the candidate set entirely rather than processed with an incomplete media_status. A `pending` row older than this IS still returned (the bridge almost certainly died mid-capture) — `processGhlInboundRow`'s own media branch treats a `'pending'` row that reaches it as equivalent to `'failed'` for placeholder purposes, since by construction it can only be here because it's stale. */
const PENDING_MEDIA_FRESH_WINDOW_MS = 10 * 60_000;

function isFreshPendingMedia(row: WhatsappInboundMessageRow): boolean {
  if (row.media_status !== "pending") return false;
  return Date.now() - Date.parse(row.created_at) < PENDING_MEDIA_FRESH_WINDOW_MS;
}

/** Media plan (docs/MEDIA-PLAN.md §7d/§8) — same bucket name the bridge's own `WA_MEDIA_BUCKET` config defaults to (`services/whatsapp-bridge/src/config.ts`); read from the SAME env var name here so the two never silently drift onto different buckets. */
const MEDIA_BUCKET = process.env.WA_MEDIA_BUCKET?.trim() || "wa-media";

const WHATSAPP_INBOUND_BASE_COLUMNS =
  "id, coach_id, from_phone, body, message_type, received_at, processed_at, resolution, push_attempts, push_error, created_at";
const WHATSAPP_INBOUND_MEDIA_COLUMNS = "media_status, media_path, media_mime, media_size_bytes";

/**
 * Media plan (docs/MEDIA-PLAN.md §7) — migration 0073 is FILE-ONLY until an
 * operator applies it (same posture as 0011-0072); this portal code must
 * therefore tolerate running against a database where the four media
 * columns simply don't exist yet, WITHOUT breaking the inbound drain that
 * already runs in production today. Selecting a column Postgres doesn't
 * have fails the whole query (`42703 undefined_column`) — unlike an INSERT
 * that simply omits a column, a SELECT naming one can't degrade quietly on
 * its own. This tries the WIDE column list first and falls back to the base
 * list (pre-0073 shape) on exactly that one error code, mapping every media
 * field to `undefined` via `mapWhatsappInboundMessage`'s own `?? null`
 * defaults — never a different behaviour for any OTHER kind of query error,
 * which still throws as before.
 */
async function selectWhatsappInboundRows(
  build: (columns: string) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>
): Promise<WhatsappInboundMessageRow[]> {
  const wide = await build(`${WHATSAPP_INBOUND_BASE_COLUMNS}, ${WHATSAPP_INBOUND_MEDIA_COLUMNS}`);
  if (!wide.error) return (wide.data ?? []) as WhatsappInboundMessageRow[];
  if (wide.error.code !== "42703") throw wide.error;
  const narrow = await build(WHATSAPP_INBOUND_BASE_COLUMNS);
  if (narrow.error) throw narrow.error;
  return (narrow.data ?? []) as WhatsappInboundMessageRow[];
}

// ---------------------------------------------------------------------------
// GHL custom conversation provider, Phase 1 — row shapes + mappers
// (supabase/migrations/0069_ghl_provider.sql). The `ghl_accounts` column
// list is THE security boundary for the summary read, same convention as
// `WHATSAPP_SESSION_SUMMARY_COLUMNS`/`CalendarConnectionSummary`'s explicit
// select: `access_token`/`refresh_token` are deliberately absent, so no
// caller of `getGhlAccounts` can ever receive a token, whatever it does with
// the result.
// ---------------------------------------------------------------------------

interface GhlAccountRow {
  location_id: string;
  tenant_id: string;
  label: string;
  company_id: string | null;
  conversation_provider_id: string | null;
  access_token: string | null;
  access_token_expires_at: string | null;
  refresh_token: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Migration 0075 — genuinely OPTIONAL on this interface (not `number`)
   * because this row comes from `select("*")`, and a pre-0075 database simply
   * never returns this key at all (`undefined`, not `null` or `0`). See
   * `mapGhlAccount` below for where that gets folded into
   * `GhlAccount.connectLinkVersion`'s `number | null`.
   */
  connect_link_version?: number | null;
  /**
   * Migration 0076 — genuinely OPTIONAL on this interface for the same
   * `select("*")`-on-a-pre-migration-row reason as `connect_link_version`
   * above, but folded to `null` (not distinguished from a genuinely-unset
   * value) rather than gated — see `GhlAccount.brandLogoPath`'s own JSDoc
   * (src/lib/types.ts) for why branding has no fail-closed distinction to
   * preserve.
   */
  brand_logo_path?: string | null;
  brand_accent_color?: string | null;
}

function mapGhlAccount(row: GhlAccountRow): GhlAccount {
  return {
    locationId: row.location_id,
    tenantId: row.tenant_id,
    label: row.label,
    companyId: row.company_id,
    conversationProviderId: row.conversation_provider_id,
    accessToken: row.access_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshToken: row.refresh_token,
    // CHECK-constrained in 0069, so this cast describes a guarantee the
    // database already enforces rather than hoping for one.
    status: row.status as GhlAccountStatus,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Migration 0075 — see `GhlAccount.connectLinkVersion`'s own JSDoc
    // (src/lib/types.ts) for why `undefined`/non-number folds to `null`
    // here rather than `0`: a pre-migration database and a genuinely
    // malformed read must both read as "feature unavailable, fail closed",
    // never as "generation zero", which is a value 0075's own default makes
    // legitimately reachable on a REAL migrated row.
    connectLinkVersion: typeof row.connect_link_version === "number" ? row.connect_link_version : null,
    // Migration 0076 — `undefined`/anything non-string folds to `null`, same
    // "column absent reads exactly like unset" posture the column comment
    // documents; unlike `connectLinkVersion` there is no `0`-shaped value
    // that would make that ambiguous.
    brandLogoPath: typeof row.brand_logo_path === "string" ? row.brand_logo_path : null,
    brandAccentColor: typeof row.brand_accent_color === "string" ? row.brand_accent_color : null,
  };
}

// Migration 0076 fields are INCLUDED here (unlike tokens/provider ids) —
// `GhlAccountsPanel.tsx`'s branding editor renders directly off
// `GhlAccountSummary`, so the redacted projection needs to carry them; see
// that interface's own JSDoc (src/lib/types.ts).
const GHL_ACCOUNT_SUMMARY_COLUMNS =
  "location_id, tenant_id, label, company_id, status, last_error, created_at, brand_logo_path, brand_accent_color";

interface GhlAccountSummaryRow {
  location_id: string;
  tenant_id: string;
  label: string;
  company_id: string | null;
  status: string;
  last_error: string | null;
  created_at: string;
  brand_logo_path?: string | null;
  brand_accent_color?: string | null;
}

/** Built field-by-field, deliberately, never a spread of `GhlAccountRow` — see `mapCalendarConnectionSummary`'s identical rationale (a future column added to `ghl_accounts` can never ride along into a page prop by accident). */
function mapGhlAccountSummary(row: GhlAccountSummaryRow): GhlAccountSummary {
  return {
    locationId: row.location_id,
    tenantId: row.tenant_id,
    label: row.label,
    companyId: row.company_id,
    brandLogoPath: typeof row.brand_logo_path === "string" ? row.brand_logo_path : null,
    brandAccentColor: typeof row.brand_accent_color === "string" ? row.brand_accent_color : null,
    status: row.status as GhlAccountStatus,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

interface GhlOutboundMessageRow {
  id: string;
  location_id: string;
  tenant_id: string;
  ghl_message_id: string;
  ghl_contact_id: string;
  idempotency_key: string;
  to_phone: string | null;
  had_attachments: boolean;
  send_state: string;
  send_attempts: number;
  /** 0070_ghl_outbound_pending_text.sql — see that migration's header and `GhlOutboundMessage.pendingText`'s JSDoc. */
  pending_text: string | null;
  /** 0071_ghl_outbound_refusal_reason.sql — see that migration's header and `GhlOutboundMessage.refusalReason`'s JSDoc. */
  refusal_reason: string | null;
  reported_status: string | null;
  reported_at: string | null;
  report_error: string | null;
  created_at: string;
}

function mapGhlOutboundMessage(row: GhlOutboundMessageRow): GhlOutboundMessage {
  return {
    id: row.id,
    locationId: row.location_id,
    tenantId: row.tenant_id,
    ghlMessageId: row.ghl_message_id,
    ghlContactId: row.ghl_contact_id,
    idempotencyKey: row.idempotency_key,
    toPhone: row.to_phone,
    hadAttachments: row.had_attachments,
    sendState: row.send_state as GhlOutboundSendState,
    sendAttempts: row.send_attempts,
    pendingText: row.pending_text,
    refusalReason: row.refusal_reason,
    reportedStatus: row.reported_status as GhlOutboundMessage["reportedStatus"],
    reportedAt: row.reported_at,
    reportError: row.report_error,
    createdAt: row.created_at,
  };
}

/** Media plan (docs/MEDIA-PLAN.md §7b) — mirrors `ghl_outbound_attachments` (0073 + 0074's `send_attempts`, QA Major 5). */
interface GhlOutboundAttachmentRow {
  id: string;
  outbound_message_id: string;
  seq: number;
  idempotency_key: string;
  pending_url: string | null;
  file_name: string | null;
  send_state: string;
  refusal_reason: string | null;
  send_attempts: number;
  created_at: string;
}

function mapGhlOutboundAttachment(row: GhlOutboundAttachmentRow): GhlOutboundAttachment {
  return {
    id: row.id,
    outboundMessageId: row.outbound_message_id,
    seq: row.seq,
    idempotencyKey: row.idempotency_key,
    pendingUrl: row.pending_url,
    fileName: row.file_name,
    sendState: row.send_state as GhlOutboundAttachmentSendState,
    refusalReason: row.refusal_reason,
    sendAttempts: row.send_attempts,
    createdAt: row.created_at,
  };
}

/**
 * `WhatsappSessionSummary.sentToday` source — grouped count of `sent` rows in
 * `whatsapp_messages` (0046) whose `sent_at` falls on today's UTC calendar
 * day, for the given coach ids. Deliberately the SAME table + status +
 * calendar-day definition the bridge's own pacer counts against
 * (services/whatsapp-bridge/src/pacing.ts, per this method's JSDoc), so the
 * portal's "Sends today" figure and the bridge's own daily-cap enforcement
 * can never quietly disagree. Client-side grouping (not a Postgres
 * `group by`) is deliberate — it's the *coach* roster this groups down to
 * that's small and bounded (one entry per coach), NOT the underlying
 * message-row count.
 *
 * Adversarial-review fix (lens 3, finding 3) — this used to select every
 * matching MESSAGE row in one unpaginated query and claimed "no pagination
 * concern at this scale" in this same comment, which was simply wrong: the
 * 1000-row figure it needs to worry about is `sent` MESSAGE rows today
 * across the whole roster, not coach rows. Once total daily sends (summed
 * across every coach, e.g. 7+ coaches near the 150/day default
 * `WA_DAILY_CAP`) pass 1000, PostgREST's default row cap silently truncated
 * the result and this method under-reported "Sends today" for whichever
 * coaches' rows fell outside that arbitrary window — the exact same
 * 1000-row-cap bug class this file has already been bitten by for
 * genuinely large tables elsewhere, just not previously recognised here.
 * Fixed by paginating with `.range()` until a page comes back short of
 * `PAGE_SIZE`, so this counts EVERY matching row regardless of volume.
 */
async function getWhatsappSentTodayByCoach(supabase: SupabaseClient, coachIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (coachIds.length === 0) return counts;
  const todayStartIso = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("whatsapp_messages")
      .select("coach_id")
      .in("coach_id", coachIds)
      .eq("status", "sent")
      .gte("sent_at", todayStartIso)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as { coach_id: string }[];
    for (const row of page) {
      counts.set(row.coach_id, (counts.get(row.coach_id) ?? 0) + 1);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return counts;
}

interface LocationNumberRow {
  tenant_id: string;
  slot: number;
  is_default: boolean;
  label: string | null;
}

const LOCATION_NUMBER_COLUMNS = "tenant_id, slot, is_default, label";

function mapLocationNumber(row: LocationNumberRow): LocationNumber {
  return { tenantId: row.tenant_id, slot: row.slot as LocationNumber["slot"], isDefault: row.is_default, label: row.label };
}

/** Postgres unique_violation. */
function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}
/**
 * Insert the account's own tenant as slot 1 / default unless the location
 * already has a row for it or a slot-1/default row. Conflicts on the tenant
 * primary key or the slot/default unique indexes mean "already set up" and are
 * ignored; an existing row is never overwritten.
 */
async function ensureDefaultNumberRow(locationId: string, tenantId: string) {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from("ghl_location_numbers")
    .insert({ tenant_id: tenantId, location_id: locationId, slot: 1, is_default: true });
  if (error && !isUniqueViolation(error)) throw error;
}

/** Make `number` the location's one default, and mirror its tenant to `ghl_accounts.tenant_id`. */
async function markDefault(locationId: string, number: LocationNumber) {
  const supabase = getServiceClient();
  // The partial unique index allows one default per location: clear, then set.
  const { error: clearError } = await supabase
    .from("ghl_location_numbers")
    .update({ is_default: false })
    .eq("location_id", locationId)
    .eq("is_default", true);
  if (clearError) throw clearError;
  const { error: setError } = await supabase
    .from("ghl_location_numbers")
    .update({ is_default: true })
    .eq("location_id", locationId)
    .eq("slot", number.slot);
  if (setError) throw setError;
  const { error: mirrorError } = await supabase
    .from("ghl_accounts")
    .update({ tenant_id: number.tenantId })
    .eq("location_id", locationId);
  if (mirrorError) throw mirrorError;
}

export class SupabaseGhlRepository implements GhlRepository {
  async getGhlAccountByLocationId(locationId: string) {
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("ghl_accounts").select("*").eq("location_id", locationId).maybeSingle();
    if (error) throw error;
    return data ? mapGhlAccount(data as GhlAccountRow) : null;
  }

  async getGhlAccountByTenantId(tenantId: string) {
    const supabase = getServiceClient();
    const { data: numberRow, error: numberError } = await supabase
      .from("ghl_location_numbers")
      .select("location_id")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (numberError) throw numberError;
    if (numberRow) return this.getGhlAccountByLocationId((numberRow as { location_id: string }).location_id);
    // A location installed before it has any ghl_location_numbers row (its
    // tenant is still only on ghl_accounts) keeps resolving by the default tenant.
    const { data, error } = await supabase.from("ghl_accounts").select("*").eq("tenant_id", tenantId).maybeSingle();
    if (error) throw error;
    return data ? mapGhlAccount(data as GhlAccountRow) : null;
  }

  async listLocationNumbers(locationId: string) {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_location_numbers")
      .select(LOCATION_NUMBER_COLUMNS)
      .eq("location_id", locationId)
      .order("slot", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as LocationNumberRow[]).map(mapLocationNumber);
  }

  async getLocationNumberBySlot(locationId: string, slot: number) {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_location_numbers")
      .select(LOCATION_NUMBER_COLUMNS)
      .eq("location_id", locationId)
      .eq("slot", slot)
      .maybeSingle();
    if (error) throw error;
    return data ? mapLocationNumber(data as LocationNumberRow) : null;
  }

  async addLocationNumber(locationId: string, label: string | null) {
    const supabase = getServiceClient();
    let tenantId: string | null = null;
    const releaseTenant = async () => {
      // Nothing references the tenant yet, so an unused one can go.
      if (!tenantId) return;
      const { error } = await supabase.from("whatsapp_tenants").delete().eq("id", tenantId);
      // Log only: this runs on the way out of another failure, which must not be masked.
      if (error) console.error("[supabase] addLocationNumber: could not remove the unused tenant row");
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      let existing = await this.listLocationNumbers(locationId);
      if (existing.length === 0) {
        // A location with no number rows still has its account tenant: adopt it
        // as slot 1 / default rather than minting a second tenant for slot 1.
        const { data: account, error: accountError } = await supabase
          .from("ghl_accounts")
          .select("tenant_id")
          .eq("location_id", locationId)
          .maybeSingle();
        if (accountError) throw accountError;
        if (account) {
          await ensureDefaultNumberRow(locationId, (account as { tenant_id: string }).tenant_id);
          existing = await this.listLocationNumbers(locationId);
        }
      }
      const slot = nextFreeSlot(existing.map((n) => n.slot));
      if (slot === null) {
        await releaseTenant();
        return { ok: false as const, reason: "limit" as const };
      }
      tenantId ??= await this.createGhlTenant();
      const row = { tenant_id: tenantId, location_id: locationId, slot, is_default: existing.length === 0, label };
      const { error } = await supabase.from("ghl_location_numbers").insert(row);
      if (!error) {
        return { ok: true as const, number: { tenantId, slot, isDefault: row.is_default, label } };
      }
      if (!isUniqueViolation(error)) {
        await releaseTenant();
        throw error;
      }
      // Lost a race for the slot (or for the first/default row): re-read and retry once.
    }
    await releaseTenant();
    return { ok: false as const, reason: "limit" as const };
  }

  async removeLocationNumber(locationId: string, slot: number) {
    const supabase = getServiceClient();
    const numbers = await this.listLocationNumbers(locationId);
    const target = numbers.find((n) => n.slot === slot);
    if (!target) return { ok: false as const, reason: "not_found" as const };
    if (numbers.length <= 1) return { ok: false as const, reason: "last_number" as const };
    const promoteSlot = promoteAfterRemoval(numbers, slot);

    // Number row FIRST: ghl_location_numbers.tenant_id has no ON DELETE, so it
    // must go before anything that touches the tenant. Sticky rows follow.
    const { error: deleteError } = await supabase
      .from("ghl_location_numbers")
      .delete()
      .eq("location_id", locationId)
      .eq("slot", slot);
    if (deleteError) throw deleteError;
    const { error: stickyError } = await supabase
      .from("ghl_contact_numbers")
      .delete()
      .eq("location_id", locationId)
      .eq("tenant_id", target.tenantId);
    if (stickyError) throw stickyError;

    if (promoteSlot !== null) {
      const promoted = numbers.find((n) => n.slot === promoteSlot)!;
      await markDefault(locationId, promoted);
    }
    return { ok: true as const, removedTenantId: target.tenantId };
  }

  async setDefaultLocationNumber(locationId: string, slot: number) {
    const target = await this.getLocationNumberBySlot(locationId, slot);
    if (!target) return false;
    if (target.isDefault) return true;
    await markDefault(locationId, target);
    return true;
  }

  async getStickyTenant(locationId: string, ghlContactId: string) {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_contact_numbers")
      .select("tenant_id")
      .eq("location_id", locationId)
      .eq("ghl_contact_id", ghlContactId)
      .maybeSingle();
    if (error) throw error;
    return data ? (data as { tenant_id: string }).tenant_id : null;
  }

  async recordInboundForStickiness(locationId: string, ghlContactId: string, tenantId: string, receivedAtIso: string) {
    const supabase = getServiceClient();
    const readExisting = async () => {
      const { data, error } = await supabase
        .from("ghl_contact_numbers")
        .select("last_inbound_at")
        .eq("location_id", locationId)
        .eq("ghl_contact_id", ghlContactId)
        .maybeSingle();
      if (error) throw error;
      return data ? (data as { last_inbound_at: string }).last_inbound_at : null;
    };
    let existing = await readExisting();
    if (existing === null) {
      const { error } = await supabase.from("ghl_contact_numbers").insert({
        location_id: locationId,
        ghl_contact_id: ghlContactId,
        tenant_id: tenantId,
        last_inbound_at: receivedAtIso,
      });
      if (!error) return;
      if (!isUniqueViolation(error)) throw error;
      // Another drain inserted first: fall through and compare against its row.
      existing = await readExisting();
      if (existing === null) return;
    }
    if (!shouldReplaceSticky(existing, receivedAtIso)) return;
    // The .lt guard makes the write itself conditional, so a concurrent newer
    // update between our read and write is never overwritten.
    // PINNED (Task 3, Review Focus 3) — this must stay the SQL
    //   update ghl_contact_numbers set tenant_id = $3, last_inbound_at = $4
    //   where location_id = $1 and ghl_contact_id = $2
    //     and last_inbound_at < $4
    // Strictly-less-than, never <=, and never dropped: the inbound drain
    // (src/lib/ghl-inbound.ts's `recordStickiness`) can replay or reorder
    // rows, and an older inbound must never move a contact back to the
    // number they wrote from before. The in-process `shouldReplaceSticky`
    // check above is only the cheap early-out; this clause is the guarantee.
    const { error } = await supabase
      .from("ghl_contact_numbers")
      .update({ tenant_id: tenantId, last_inbound_at: receivedAtIso })
      .eq("location_id", locationId)
      .eq("ghl_contact_id", ghlContactId)
      .lt("last_inbound_at", receivedAtIso);
    if (error) throw error;
  }

  async getGhlAccounts() {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_accounts")
      .select(GHL_ACCOUNT_SUMMARY_COLUMNS)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as unknown as GhlAccountSummaryRow[]).map(mapGhlAccountSummary);
  }

  async upsertGhlAccount(draft: GhlAccountDraft) {
    const supabase = getServiceClient();
    const { error } = await supabase.from("ghl_accounts").upsert(
      {
        location_id: draft.locationId,
        tenant_id: draft.tenantId,
        label: draft.label,
        company_id: draft.companyId,
        access_token: draft.accessToken,
        access_token_expires_at: draft.accessTokenExpiresAt,
        refresh_token: draft.refreshToken,
        // A reconnect/reinstall always clears a previous failure — same
        // "reconnect implies a fresh start" convention as
        // upsertCalendarConnection.
        status: "active",
        last_error: null,
      },
      { onConflict: "location_id" }
    );
    if (error) throw error;
    // Every account has its tenant as a slot-1 default number (insert-if-absent).
    await ensureDefaultNumberRow(draft.locationId, draft.tenantId);
  }

  /**
   * W-CONNECT-BRAND — see `Repository.updateGhlAccountBranding`'s own JSDoc
   * (src/lib/data/index.ts) for the contract. `brandAccentColor` is
   * normalised through `normaliseHex` at the LAST moment before the write,
   * mirroring `updateCoachBrandingService`'s identical guarantee — an
   * unparseable value can never be persisted, and `?? null` (not
   * `|| undefined`) means an unparseable value CLEARS the column rather than
   * silently keeping the previous one, so what the owner panel shows after a
   * save is always what is actually stored.
   *
   * Migration 0076 not applied yet -> throws an honest refusal naming it,
   * rather than letting PostgREST's "unknown column" error surface as an
   * opaque failure — same "name the missing migration" posture
   * `createGhlConnectLinkAction` already established for 0075
   * (src/app/owner/setup-links/actions.ts).
   */
  async updateGhlAccountBranding(locationId: string, patch: GhlAccountBrandingPatch) {
    const supabase = getServiceClient();
    const update: Record<string, unknown> = {};
    if (patch.brandLogoPath !== undefined) update.brand_logo_path = patch.brandLogoPath;
    if (patch.brandAccentColor !== undefined) update.brand_accent_color = normaliseHex(patch.brandAccentColor) ?? null;

    // Nothing to do — avoid an empty UPDATE, which PostgREST rejects (same
    // guard as `updateCoachBrandingService`).
    if (Object.keys(update).length === 0) return;

    const { error } = await supabase.from("ghl_accounts").update(update).eq("location_id", locationId);
    if (error) {
      if (error.code === "PGRST204" || /brand_logo_path|brand_accent_color/.test(error.message ?? "")) {
        throw new Error(
          "[supabase] updateGhlAccountBranding: brand_logo_path/brand_accent_color columns are absent — apply migration 0076_ghl_account_branding.sql first"
        );
      }
      throw error;
    }
  }

  async createGhlTenant() {
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("whatsapp_tenants").insert({ kind: "ghl_location" }).select("id").single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  async saveGhlTokens(locationId: string, tokens: { accessToken: string; accessTokenExpiresAt: string; refreshToken: string }) {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("ghl_accounts")
      .update({
        access_token: tokens.accessToken,
        access_token_expires_at: tokens.accessTokenExpiresAt,
        refresh_token: tokens.refreshToken,
        status: "active",
        last_error: null,
        token_refresh_claimed_at: null,
      })
      .eq("location_id", locationId);
    if (error) throw error;
  }

  async markGhlNeedsReauth(locationId: string, error_: string) {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("ghl_accounts")
      .update({ status: "needs_reauth", last_error: error_.slice(0, 500), token_refresh_claimed_at: null })
      .eq("location_id", locationId);
    if (error) throw error;
  }

  /**
   * Same "row count tells you who won" shape as `claimSessionLock`
   * (services/whatsapp-bridge/src/store.ts) and `claimAutomationSequenceRun`
   * above — one UPDATE whose WHERE clause is the guard.
   */
  async claimGhlTokenRefresh(locationId: string) {
    const supabase = getServiceClient();
    const staleBefore = new Date(Date.now() - 30_000).toISOString();
    const { data, error } = await supabase
      .from("ghl_accounts")
      .update({ token_refresh_claimed_at: new Date().toISOString() })
      .eq("location_id", locationId)
      .or(`token_refresh_claimed_at.is.null,token_refresh_claimed_at.lt.${staleBefore}`)
      .select("location_id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  /**
   * "Revoke all links" — see `Repository.bumpGhlConnectLinkVersion`'s own
   * JSDoc (src/lib/data/index.ts) for what this is for.
   *
   * READ-THEN-WRITE, NOT A SINGLE ATOMIC `SET x = x + 1`: PostgREST's update
   * body is plain JSON column values, not a SQL expression — an actually
   * atomic increment needs a Postgres function (an RPC), and adding one was
   * deliberately out of scope for migration 0075 (see that file's own header
   * — it is a single additive column, nothing else). The race this accepts:
   * two "Revoke all links" clicks for the SAME location landing concurrently
   * could both read the same starting value and both write `start + 1`,
   * losing one bump. ACCEPTABLE, NOT IGNORED: this is a rare, deliberate,
   * single-operator admin action (Charlie clicking a button in his own owner
   * panel), not a hot path or an attacker-reachable surface — nothing here is
   * two DIFFERENT people racing to revoke, and the cost of a lost bump is
   * "click Revoke again", never a link staying valid that Charlie believed
   * revoked (a null/missing row still throws below rather than silently
   * no-op'ing, and a genuinely applied bump — the overwhelmingly common case
   * — always takes effect on the very next verify).
   */
  async bumpGhlConnectLinkVersion(locationId: string) {
    const supabase = getServiceClient();
    const { data: current, error: readError } = await supabase
      .from("ghl_accounts")
      .select("connect_link_version")
      .eq("location_id", locationId)
      .maybeSingle();
    if (readError) throw readError;
    if (!current) throw new Error(`[supabase] bumpGhlConnectLinkVersion: no ghl_accounts row for location ${locationId}`);
    const currentVersion = (current as { connect_link_version: number | null }).connect_link_version;
    if (typeof currentVersion !== "number") {
      throw new Error("[supabase] bumpGhlConnectLinkVersion: connect_link_version column is absent — apply supabase/migrations/0001_init.sql first");
    }
    const { error: writeError } = await supabase
      .from("ghl_accounts")
      .update({ connect_link_version: currentVersion + 1 })
      .eq("location_id", locationId);
    if (writeError) throw writeError;
  }

  /** Insert-or-return-existing on the `(location_id, ghl_message_id)` dedupe constraint (0069) — same shape as the bridge's own `acceptMessage`, see this method's JSDoc in index.ts. */
  async recordGhlOutboundMessage(draft: GhlOutboundMessageDraft) {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_outbound_messages")
      .insert({
        location_id: draft.locationId,
        tenant_id: draft.tenantId,
        ghl_message_id: draft.ghlMessageId,
        ghl_contact_id: draft.ghlContactId,
        idempotency_key: draft.idempotencyKey,
        to_phone: draft.toPhone,
        had_attachments: draft.hadAttachments,
        pending_text: draft.pendingText,
      })
      .select("*")
      .maybeSingle();
    if (!error && data) return { message: mapGhlOutboundMessage(data as GhlOutboundMessageRow), isNew: true };
    // 23505 = unique_violation — a GHL webhook redelivery, not a failure.
    if (error && error.code !== "23505") throw error;
    const { data: existing, error: existingError } = await supabase
      .from("ghl_outbound_messages")
      .select("*")
      .eq("location_id", draft.locationId)
      .eq("ghl_message_id", draft.ghlMessageId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      throw new Error("[supabase] ghl_outbound_messages dedupe conflict but existing row not found — should be impossible");
    }
    return { message: mapGhlOutboundMessage(existing as GhlOutboundMessageRow), isNew: false };
  }

  async updateGhlOutboundSendState(id: string, patch: { sendState: GhlOutboundSendState; sendAttempts?: number; refusalReason?: string }) {
    const supabase = getServiceClient();
    const update: Record<string, unknown> = { send_state: patch.sendState };
    if (patch.sendAttempts !== undefined) update.send_attempts = patch.sendAttempts;
    // 0070_ghl_outbound_pending_text.sql's whole contract: pending_text only
    // exists for the duration a row is a bridge-send retry candidate — clear
    // it the instant the row leaves 'pending_send' (see that migration's
    // header and Repository.updateGhlOutboundSendState's JSDoc).
    if (patch.sendState !== "pending_send") update.pending_text = null;
    // 0071_ghl_outbound_refusal_reason.sql — stamped once, alongside (not
    // instead of) report_error, and never cleared again (adversarial-review
    // finding 3 — see Repository.updateGhlOutboundSendState's JSDoc).
    if (patch.sendState === "refused" && patch.refusalReason !== undefined) update.refusal_reason = patch.refusalReason;
    let query = supabase.from("ghl_outbound_messages").update(update).eq("id", id);
    // Final cross-phase review, finding 2 — this write used to be a BLIND
    // PATCH regardless of the row's CURRENT state. `drainPendingSend`'s
    // transient-failure branch calls this to write `send_state:
    // 'pending_send'` back onto a row it read as 'pending_send' at the start
    // of the pass — but a faster CONCURRENT drain pass can have already
    // moved that same row all the way to 'accepted' (and cleared
    // `pending_text`) in between. Without a guard, this slower pass's write
    // would silently demote the row back to 'pending_send' with
    // `pending_text` left NULL (this write never SETS pending_text, only
    // clears it) — the next pass then sees an unrecoverable-looking row and
    // (before the ghl-provider.ts finding-2 fix) reported a false 'failed'
    // for a message the bridge had already accepted or delivered. Guarding
    // this exact write with `.eq("send_state", "pending_send")` makes it a
    // no-op (0 rows affected, no error) if the row has already moved on —
    // the row's true, newer state (written by the faster pass) survives
    // untouched. Every OTHER sendState transition this method writes
    // ('accepted', 'refused') is unconditional as before — only the
    // pending_send-to-pending_send retry-bookkeeping write needs this,
    // because it's the only one that can race a state transition already in
    // flight from elsewhere.
    if (patch.sendState === "pending_send") query = query.eq("send_state", "pending_send");
    const { error } = await query;
    if (error) throw error;
  }

  /**
   * Adversarial-review finding 1 (drain starvation): filtered to rows whose
   * `ghl_accounts.status = 'active'` via PostgREST's embedded-resource
   * `!inner` join filter (the FK 0069 already declares from
   * `ghl_outbound_messages.location_id` to `ghl_accounts.location_id` makes
   * this relationship auto-detectable — no new schema needed). A row tied to
   * a `needs_reauth`/`disabled` location can never be reported right now (no
   * usable access token exists), so leaving it eligible for this oldest-
   * first, capped batch would let it — and every other row for the same
   * stuck location — monopolise every pass once enough accumulate, starving
   * healthy rows from OTHER locations of ever being looked at (see
   * `Repository.listUnreportedGhlOutboundMessages`'s JSDoc). Self-healing:
   * the moment the location reconnects, its rows are eligible again with no
   * separate step.
   */
  async listUnreportedGhlOutboundMessages(limit = 50) {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_outbound_messages")
      .select("*, ghl_accounts!inner(status)")
      .is("reported_status", null)
      .eq("ghl_accounts.status", "active")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    // The embedded `ghl_accounts` object is select-only scaffolding for the
    // filter above — mapGhlOutboundMessage reads named columns off the row
    // and ignores it, same as every other mapper in this file that never
    // spreads a raw row.
    return ((data ?? []) as unknown as GhlOutboundMessageRow[]).map(mapGhlOutboundMessage);
  }

  async markGhlOutboundReported(id: string, patch: { reportedStatus: GhlOutboundReportedStatus | null; reportError: string | null }) {
    const supabase = getServiceClient();
    // Phase 2 adaptation (see Repository.markGhlOutboundReported's JSDoc):
    // reportedStatus: null means "the PUT to GHL itself failed" — stamp
    // report_error for diagnosis WITHOUT touching reported_status/reported_at,
    // so the row stays picked up by listUnreportedGhlOutboundMessages's
    // `reported_status IS NULL` filter and gets retried next pass.
    const update: Record<string, unknown> = { report_error: patch.reportError };
    if (patch.reportedStatus !== null) {
      update.reported_status = patch.reportedStatus;
      update.reported_at = new Date().toISOString();
    }
    const { error } = await supabase.from("ghl_outbound_messages").update(update).eq("id", id);
    if (error) throw error;
  }

  /** Bulk insert — see `Repository.recordGhlOutboundAttachments`'s JSDoc for the "called exactly once, after every pre-dispatch refusal check" contract this relies on (no upsert/dedupe needed here — unlike `recordGhlOutboundMessage`'s GHL-redelivery dedupe, this is never called twice for the same message). */
  async recordGhlOutboundAttachments(drafts: GhlOutboundAttachmentDraft[]) {
    if (drafts.length === 0) return [];
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_outbound_attachments")
      .insert(
        drafts.map((d) => ({
          outbound_message_id: d.outboundMessageId,
          seq: d.seq,
          idempotency_key: d.idempotencyKey,
          pending_url: d.pendingUrl,
          file_name: d.fileName,
        }))
      )
      .select("*");
    if (error) throw error;
    return ((data ?? []) as unknown as GhlOutboundAttachmentRow[]).map(mapGhlOutboundAttachment).sort((a, b) => a.seq - b.seq);
  }

  /** Batch fetch across multiple parent rows — see `Repository.listGhlOutboundAttachmentsForMessages`'s JSDoc for why this is one query, not one per row. */
  async listGhlOutboundAttachmentsForMessages(outboundMessageIds: string[]) {
    if (outboundMessageIds.length === 0) return [];
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("ghl_outbound_attachments")
      .select("*")
      .in("outbound_message_id", outboundMessageIds)
      .order("outbound_message_id", { ascending: true })
      .order("seq", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as unknown as GhlOutboundAttachmentRow[]).map(mapGhlOutboundAttachment);
  }

  async updateGhlOutboundAttachmentSendState(id: string, patch: { sendState: GhlOutboundAttachmentSendState; sendAttempts?: number; refusalReason?: string }) {
    const supabase = getServiceClient();
    const update: Record<string, unknown> = { send_state: patch.sendState };
    // 0073's `pending_url` follows 0070's `pending_text` lifecycle verbatim —
    // see `Repository.updateGhlOutboundAttachmentSendState`'s JSDoc.
    if (patch.sendState !== "pending_send") update.pending_url = null;
    if (patch.sendState === "refused" && patch.refusalReason !== undefined) update.refusal_reason = patch.refusalReason;
    // 0074 (QA Major 5, WRITTEN NOT APPLIED) — mirrors `updateGhlOutboundSendState`'s own `sendAttempts` write for the text part.
    if (patch.sendAttempts !== undefined) update.send_attempts = patch.sendAttempts;
    const { error } = await supabase.from("ghl_outbound_attachments").update(update).eq("id", id);
    if (error) throw error;
  }

  /**
   * `coachId` in the return shape is `whatsapp_messages`' own historical
   * column name (0046/0069) — for a row this returns, it holds a tenant id.
   *
   * Adversarial-review finding 2: filtered on BOTH `coach_id` (tenant ids)
   * AND `idempotency_key`, not tenant id alone — `whatsapp_messages` is never
   * purged, and a query with no `idempotency_key` filter and no `.limit()`
   * would return the tenants' ENTIRE ledger, which at scale exceeds
   * PostgREST's default 1000-row cap and can silently truncate the exact
   * rows this drain pass wants out of the response, well before the
   * client-side pair filter below even runs. Bounding the query itself to
   * `pairs.length` idempotency keys keeps the response size proportional to
   * the drain's own batch cap, never the whole table.
   */
  async getWhatsappMessagesByTenantKeys(pairs: { tenantId: string; idempotencyKey: string }[]) {
    if (pairs.length === 0) return [];
    const supabase = getServiceClient();
    const { tenantIds, idempotencyKeys } = ghlTenantKeyQueryFilters(pairs);
    const { data, error } = await supabase
      .from("whatsapp_messages")
      .select("coach_id, idempotency_key, status, error")
      .in("coach_id", tenantIds)
      .in("idempotency_key", idempotencyKeys);
    if (error) throw error;
    const wanted = new Set(pairs.map((p) => `${p.tenantId}:${p.idempotencyKey}`));
    return ((data ?? []) as { coach_id: string; idempotency_key: string; status: string; error: string | null }[])
      .filter((row) => wanted.has(`${row.coach_id}:${row.idempotency_key}`))
      .map((row) => ({ coachId: row.coach_id, idempotencyKey: row.idempotency_key, status: row.status, error: row.error }));
  }

  /**
   * Adversarial-review finding 1, applied here from day one (mirrors
   * `listUnreportedGhlOutboundMessages`'s `ghl_accounts!inner(status)`
   * filter): no direct/embeddable FK exists from `whatsapp_inbound_messages`
   * to `ghl_accounts` (unlike `ghl_outbound_messages.location_id`), so this
   * is the same two-query equivalent `getUnprocessedWhatsappInboundMessages`
   * already uses for its coach-kind fence — read every ACTIVE GHL location's
   * tenant id (bounded — one row per installed location), then `.in()`
   * against it. See `Repository.getUnprocessedGhlInboundMessages`'s JSDoc for
   * why `push_attempts` is deliberately NOT filtered here.
   */
  async getUnprocessedGhlInboundMessages(limit = 50) {
    const supabase = getServiceClient();
    const { data: activeAccounts, error: accountsError } = await supabase.from("ghl_accounts").select("tenant_id").eq("status", "active");
    if (accountsError) throw accountsError;
    const activeTenantIds = ((activeAccounts ?? []) as { tenant_id: string }[]).map((a) => a.tenant_id);
    if (activeTenantIds.length === 0) return [];
    // Media plan (docs/MEDIA-PLAN.md §6.1/§6.5) — over-fetch by `limit` extra
    // rows before applying the fresh-pending exclusion in JS (PostgREST has
    // no clean "exclude rows matching BOTH of these two column conditions
    // together" expression alongside the existing `.is("processed_at", null)`
    // filter without a second round trip) — a handful of fresh-pending rows
    // sitting at the head of the oldest-first queue would otherwise shrink
    // the effective batch size below `limit`, which just means this pass
    // does slightly less work, never a correctness issue (they're picked up
    // once they age past the 10-minute fence, on this same list next pass).
    const rows = await selectWhatsappInboundRows((columns) =>
      supabase
        .from("whatsapp_inbound_messages")
        .select(columns)
        .in("coach_id", activeTenantIds)
        .is("processed_at", null)
        .order("created_at", { ascending: true })
        .limit(limit + 50)
    );
    return rows.filter((row) => !isFreshPendingMedia(row)).slice(0, limit).map(mapWhatsappInboundMessage);
  }

  /**
   * Atomic claim — see Repository.claimWhatsappInboundMessage's JSDoc. The
   * `.select("id")` + row-count check is the SAME "did my own UPDATE
   * actually affect a row" pattern `claimAutomationSequenceRun` uses (0038) —
   * Supabase doesn't hand back an affected-row count directly, so a
   * conditional UPDATE that returns the row (or doesn't) is the only signal.
   */
  async claimWhatsappInboundMessage(id: string) {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("whatsapp_inbound_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", id)
      .is("processed_at", null)
      .select("id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async resolveGhlInboundMessage(id: string, patch: { resolution: string; pushError: string | null }) {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("whatsapp_inbound_messages")
      .update({ resolution: patch.resolution, push_error: patch.pushError })
      .eq("id", id);
    if (error) throw error;
  }

  async recordGhlInboundPushFailure(id: string, patch: { attempts: number; pushError: string; unclaim: boolean }) {
    const supabase = getServiceClient();
    const update: Record<string, unknown> = { push_attempts: patch.attempts, push_error: patch.pushError };
    if (patch.unclaim) update.processed_at = null;
    let query = supabase.from("whatsapp_inbound_messages").update(update).eq("id", id);
    // Adversarial-review finding 4 (cosmetic, guarded anyway): a PRE-CLAIM
    // failure (`unclaim: false` — this pass never held the claim on this
    // row) can race a concurrent pass that claims AND resolves the same row
    // in between this pass's upsert/token-lookup call and this write. Guard
    // with `.is("resolution", null)` so a slow pass can never stamp
    // push_error/push_attempts onto a row a faster pass already resolved
    // (e.g. 'ghl_pushed') — cheap to add even though the only harm was
    // misleading diagnostics (the row stays claimed/resolved either way).
    // The `unclaim: true` path (a post-claim POST failure) needs no such
    // guard: THIS pass holds the claim at that point, so no other pass can
    // have resolved the row concurrently.
    if (!patch.unclaim) query = query.is("resolution", null);
    const { error } = await query;
    if (error) throw error;
  }

  /**
   * See `Repository.purgeOldWhatsappInboundMessages`'s JSDoc (adversarial-review
   * fix, lens 3 finding 1) — deletes whole rows, not just `body`. Media plan
   * (docs/MEDIA-PLAN.md §6.4) extension: for any row about to be deleted that
   * has a stored media OBJECT (`media_status = 'stored'`, `media_path` set),
   * the storage object is deleted FIRST, then the row — an orphaned object
   * costs pennies, an orphaned row pointing at nothing is a broken link, so
   * this order is the one that fails safe. Tolerant of migration 0073 being
   * unapplied (selecting `media_status`/`media_path` on a pre-migration
   * table would 42703 — falls back to a plain row purge with no storage
   * step, i.e. today's exact behaviour).
   *
   * QA Minor 10(a) fix — a FAILED storage-object delete used to be logged
   * and then IGNORED: the row was deleted anyway, permanently orphaning the
   * object it pointed at (a stranger's photo/voice note left in the
   * `wa-media` bucket forever, unreachable by any row, invisible to the
   * 90-day retention promise). Now, when the object-delete call itself
   * fails, EVERY row that had a media object in this batch is excluded from
   * this pass's row deletion and left for the next pass to retry — the
   * object-delete and row-delete for a media-carrying row either both
   * happen this pass or neither does; rows with no media object are
   * unaffected and purge normally regardless. `storage.remove()`'s error
   * signal is all-or-nothing across the batch (no clean per-file partial
   * result from the client), so "some objects in the batch may have
   * genuinely been removed already" is accepted as the conservative
   * trade-off — retrying an already-gone object's delete on the next pass
   * is a no-op, never a correctness problem.
   *
   * NOTE (scope, disclosed): this fixes the ORDERING bug only. The
   * weekly orphan sweep the plan's §6.4 also calls for (list the bucket,
   * diff against `media_path` values, delete anything unreferenced) is
   * NOT built by this change — still on `docs/GHL-PROVIDER-GO-LIVE.md`'s
   * outstanding list. It remains the backstop for the OTHER orphan source
   * this function can't see at all: `runMediaCapture`'s own
   * status-write-fails-after-upload path (`services/whatsapp-bridge/src/media-capture.ts`),
   * which can leave a stored object behind a row that never reaches
   * `media_status = 'stored'` in the first place.
   */
  async purgeOldWhatsappInboundMessages(olderThanIso: string) {
    const supabase = getServiceClient();

    let mediaRows: { id: string; mediaPath: string }[] = [];
    const mediaSelect = await supabase
      .from("whatsapp_inbound_messages")
      .select("id, media_status, media_path")
      .lt("received_at", olderThanIso)
      .eq("media_status", "stored");
    if (!mediaSelect.error) {
      mediaRows = ((mediaSelect.data ?? []) as { id: string; media_path: string | null }[])
        .filter((r): r is { id: string; media_path: string } => Boolean(r.media_path))
        .map((r) => ({ id: r.id, mediaPath: r.media_path }));
    } else if (mediaSelect.error.code !== "42703") {
      throw mediaSelect.error;
    }
    // 42703 (migration 0073 not applied yet) -> mediaRows stays [] and this
    // purge behaves exactly as it did before the media plan.

    let excludeRowIds: string[] = [];
    if (mediaRows.length > 0) {
      const { error: removeError } = await supabase.storage.from(MEDIA_BUCKET).remove(mediaRows.map((r) => r.mediaPath));
      if (removeError) {
        excludeRowIds = mediaRows.map((r) => r.id);
        console.error(
          "[data] purgeOldWhatsappInboundMessages: storage object cleanup failed — the affected rows are LEFT for the next pass rather than deleted with an orphaned object behind them:",
          removeError
        );
      }
    }

    let query = supabase.from("whatsapp_inbound_messages").delete().lt("received_at", olderThanIso);
    if (excludeRowIds.length > 0) {
      query = query.not("id", "in", `(${excludeRowIds.join(",")})`);
    }
    const { data, error } = await query.select("id");
    if (error) throw error;
    return data?.length ?? 0;
  }

  /**
   * Media plan (docs/MEDIA-PLAN.md §6.2 decision I3) — mints a short-lived
   * signed URL for a `wa-media` storage object; the ONLY read path into that
   * private bucket (no policies on `storage.objects` for it — service-role
   * only). `WA_MEDIA_SIGNED_URL_TTL_DAYS` (default 90, matching the
   * retention window — see that env var's own note for why not shorter).
   * Returns `null` on any storage error (object missing, bucket misconfigured,
   * etc.) rather than throwing — the caller (`src/lib/ghl-inbound.ts`) treats
   * a null exactly like any other media-resolution failure: push the fixed
   * placeholder instead of a broken link, never crash the drain pass over it.
   */
  async createWhatsappMediaSignedUrl(path: string): Promise<string | null> {
    const supabase = getServiceClient();
    const ttlDays = Number.parseInt(process.env.WA_MEDIA_SIGNED_URL_TTL_DAYS ?? "90", 10);
    const ttlSeconds = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 90) * 24 * 60 * 60;
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, ttlSeconds);
    if (error || !data?.signedUrl) {
      console.error("[data] createWhatsappMediaSignedUrl failed:", error);
      return null;
    }
    return data.signedUrl;
  }

  async getWhatsappSessionSummary(coachId: string) {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("whatsapp_sessions")
      .select(WHATSAPP_SESSION_SUMMARY_COLUMNS)
      .eq("coach_id", coachId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const sentTodayByCoach = await getWhatsappSentTodayByCoach(supabase, [coachId]);
    return mapWhatsappSessionSummary(data as unknown as WhatsappSessionSummaryRow, sentTodayByCoach.get(coachId) ?? 0);
  }

  async getWhatsappSessionSummaries(scope: Scope) {
    // CODE-level scoping (0046 has no RLS policies to lean on). Deny by
    // default: only 'owner' sees rows; every other role gets `[]` WITHOUT a
    // query. Accounts have no ownership column yet, so there is nothing safe
    // to filter them down to until a later plan adds one.
    if (scope.role !== "owner") return [];

    const supabase = getServiceClient();
    const query = supabase.from("whatsapp_sessions").select(WHATSAPP_SESSION_SUMMARY_COLUMNS).order("coach_id", { ascending: true });
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as unknown as WhatsappSessionSummaryRow[];
    const sentTodayByCoach = await getWhatsappSentTodayByCoach(
      supabase,
      rows.map((r) => r.coach_id)
    );
    return rows.map((row) => mapWhatsappSessionSummary(row, sentTodayByCoach.get(row.coach_id) ?? 0));
  }

  async getGhlHealthSnapshot() {
    const supabase = getServiceClient();

    // Every installed location, active or not — see the interface JSDoc for
    // why this method deliberately does NOT filter by `status` the way the
    // two drains do.
    const { data: accountRows, error: accountsError } = await supabase.from("ghl_accounts").select("location_id, tenant_id, label");
    if (accountsError) throw accountsError;
    const locations: GhlHealthLocation[] = ((accountRows ?? []) as { location_id: string; tenant_id: string; label: string }[]).map((r) => ({
      locationId: r.location_id,
      tenantId: r.tenant_id,
      label: r.label,
    }));
    // Nothing installed yet — an empty snapshot with zero further reads,
    // same "no accounts, no work" short-circuit `getUnprocessedGhlInboundMessages`
    // already uses for its own tenant fence.
    if (locations.length === 0) return buildGhlHealthSnapshot([], [], [], Date.now());

    const tenantIds = locations.map((l) => l.tenantId);
    const inboundWindowStartIso = new Date(Date.now() - GHL_HEALTH_INBOUND_WINDOW_DAYS * 86_400_000).toISOString();

    const [outboundResult, inboundResult, waitingResult] = await Promise.all([
      // The exact backlog `drainGhlOutboundStatuses` itself retries — same
      // `reported_status IS NULL` filter, same partial index
      // (`ghl_outbound_unreported_idx`, 0069). Newest-first + capped — see
      // `GHL_HEALTH_OUTBOUND_BACKLOG_CAP`'s own JSDoc for why.
      supabase
        .from("ghl_outbound_messages")
        .select("location_id, created_at, report_error")
        .is("reported_status", null)
        .order("created_at", { ascending: false })
        .limit(GHL_HEALTH_OUTBOUND_BACKLOG_CAP),
      // The same two-query GHL-tenant fence `getUnprocessedGhlInboundMessages`
      // uses (no direct FK from whatsapp_inbound_messages to ghl_accounts to
      // embed this filter in one query) — `.in("coach_id", tenantIds)` — plus
      // a processed-resolution filter and the recency window this health read
      // needs but the drain's own unprocessed-only query doesn't.
      supabase
        .from("whatsapp_inbound_messages")
        .select("coach_id, created_at, resolution, push_error")
        .in("coach_id", tenantIds)
        .not("resolution", "is", null)
        .gte("created_at", inboundWindowStartIso)
        .order("created_at", { ascending: false })
        .limit(GHL_HEALTH_INBOUND_ROW_CAP),
      // Final cross-phase review, finding 9 — rows still `resolution IS
      // NULL`, i.e. genuinely waiting to be pushed. Same tenant fence as
      // above, deliberately NO time window (a row that's been waiting for
      // days is exactly what this exists to surface) and NO account-status
      // filter (matches this whole method's "show what's actually
      // happening" posture — see the interface JSDoc, src/lib/data/index.ts).
      supabase
        .from("whatsapp_inbound_messages")
        .select("coach_id, created_at")
        .in("coach_id", tenantIds)
        .is("resolution", null)
        .order("created_at", { ascending: false })
        .limit(GHL_HEALTH_INBOUND_ROW_CAP),
    ]);
    if (outboundResult.error) throw outboundResult.error;
    if (inboundResult.error) throw inboundResult.error;
    if (waitingResult.error) throw waitingResult.error;

    const outboundRows: GhlOutboundHealthRow[] = (
      (outboundResult.data ?? []) as { location_id: string; created_at: string; report_error: string | null }[]
    ).map((r) => ({ locationId: r.location_id, createdAt: r.created_at, reportError: r.report_error }));
    const inboundRows: GhlInboundHealthRow[] = (
      (inboundResult.data ?? []) as { coach_id: string; created_at: string; resolution: string; push_error: string | null }[]
    ).map((r) => ({ tenantId: r.coach_id, createdAt: r.created_at, resolution: r.resolution, pushError: r.push_error }));
    const waitingRows: GhlWaitingHealthRow[] = ((waitingResult.data ?? []) as { coach_id: string; created_at: string }[]).map((r) => ({
      tenantId: r.coach_id,
      createdAt: r.created_at,
    }));

    return buildGhlHealthSnapshot(locations, outboundRows, inboundRows, Date.now(), waitingRows);
  }
}

// ---------------------------------------------------------------------------
// GHL location logo storage — copied from PortalHub supabase.ts (the
// `saveGhlAccountBrandingAction` path, src/app/admin/actions.ts).
// ---------------------------------------------------------------------------

/**
 * W-CONNECT-BRAND (migration 0076) — put a GHL location's logo bytes in the
 * SHARED `client-logos` bucket and return the PATH to store on
 * `ghl_accounts.brand_logo_path`. Same ordering/uniqueness/cleanup structure
 * as `uploadCoachLogoService` immediately above (upload the new object
 * first, best-effort-delete the location's previous ones after — see that
 * function's own JSDoc for the full "why this order" reasoning, which
 * applies verbatim here), with two differences, both explained in migration
 * 0076's own header:
 *
 *   - The object path is prefixed `ghl/<locationId>/`, not bare
 *     `<locationId>/` — collision safety against `coaches.id` (0076, "WHY
 *     THIS SHARES `client-logos`... COLLISION SAFETY").
 *   - The return value is the PATH itself (`getPublicUrl` is never called
 *     here), not a URL — `brand_logo_path` stores a path, resolved to a URL
 *     on READ by `resolveLogoPath` (src/lib/brand.ts), not on write. See
 *     0076's header, "WHY A PATH, NOT A URL".
 */
export async function uploadGhlAccountLogoService(
  locationId: string,
  bytes: Uint8Array,
  contentType: SafeLogoType,
): Promise<string> {
  const supabase = getServiceClient();
  const prefix = `ghl/${locationId}`;
  const path = `${prefix}/${crypto.randomUUID()}.${LOGO_EXTENSION[contentType]}`;

  const { error: uploadError } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(path, bytes, { contentType, cacheControl: "31536000" });
  if (uploadError) throw uploadError;

  // Best-effort cleanup of this location's PREVIOUS logos — scoped to
  // `ghl/<locationId>/`, so it can never touch a coach's objects (which sit
  // at bare `<coachId>/...`, a disjoint namespace) even if the listing were
  // somehow wrong.
  try {
    const { data: existing } = await supabase.storage.from(LOGO_BUCKET).list(prefix);
    const stale = (existing ?? [])
      .map((o) => `${prefix}/${o.name}`)
      .filter((p) => p !== path);
    if (stale.length > 0) await supabase.storage.from(LOGO_BUCKET).remove(stale);
  } catch {
    // Deliberately swallowed — see `uploadCoachLogoService`'s identical note.
  }

  return path;
}

/**
 * W-CONNECT-BRAND — remove every stored logo object for one GHL location,
 * the `ghl/<locationId>/` twin of `deleteCoachLogoObjectsService` above. Same
 * best-effort posture: `brand_logo_path` going back to `null` is what
 * actually takes the logo off the connect page, and that write is the
 * caller's next step (`saveGhlAccountBrandingAction`,
 * src/app/owner/setup-links/actions.ts) — a failure to tidy the bucket must
 * not block it.
 */
export async function deleteGhlAccountLogoObjectsService(locationId: string): Promise<void> {
  try {
    const supabase = getServiceClient();
    const prefix = `ghl/${locationId}`;
    const { data: existing } = await supabase.storage.from(LOGO_BUCKET).list(prefix);
    const paths = (existing ?? []).map((o) => `${prefix}/${o.name}`);
    if (paths.length > 0) await supabase.storage.from(LOGO_BUCKET).remove(paths);
  } catch {
    // See above — tidying the bucket is never the operation the user asked for.
  }
}
