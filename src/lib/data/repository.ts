/**
 * The data-access contract for the standalone GHL WhatsApp provider.
 *
 * Copied from PortalHub's `Repository`/`WebhookRepository` (src/lib/data/index.ts),
 * reduced to the 27 original methods (plus the 16 accounts/billing methods of migration 0002, and the location-number methods) the provider slice uses. There is exactly one
 * implementation (service-role Supabase, `SupabaseGhlRepository`) and no
 * user-session repo: every method here is service-role by design.
 */
import type {
  Account,
  AccountAdminRow,
  AccountBillingPatch,
  AccountDraft,
  GhlAccount,
  GhlAccountBrandingPatch,
  GhlAccountDraft,
  GhlAccountSummary,
  GhlHealthSnapshot,
  GhlOutboundAttachment,
  GhlOutboundAttachmentDraft,
  GhlOutboundAttachmentSendState,
  GhlOutboundMessage,
  GhlOutboundMessageDraft,
  GhlOutboundReportedStatus,
  GhlOutboundSendState,
  LocationNumber,
  LocationStats,
  Role,
  Scope,
  WhatsappGroup,
  WhatsappInboundMessage,
  WhatsappSessionSummary,
} from "@/lib/types";

export interface GhlRepository {
  /**
   * ONE location, TOKENS INCLUDED — `location_id` is `ghl_accounts`'
   * primary key, so a hit here is the entire routing decision the plan's §2
   * describes as "exactly one query" for an inbound GHL webhook. Never call
   * this from a page, a server action's caller, or any client component —
   * use `getGhlAccounts` for anything a human sees.
   */
  getGhlAccountByLocationId(locationId: string): Promise<GhlAccount | null>;

  // -------------------------------------------------------------------------
  // GHL custom conversation provider, Phase 3 — inbound (docs/GHL-PROVIDER-PLAN.md's
  // Phase 3 follow-on: a prospect's WhatsApp reply pushed into the client's
  // GHL conversation). Driven exclusively by `src/lib/ghl-inbound.ts`'s
  // `drainGhlInboundReplies`, called from the SAME poke route + reminders
  // cron as the inbound poke route — see that module's file header for the
  // full claim/retry contract. Schema: `supabase/migrations/0072_ghl_inbound_push.sql`
  // adds `push_attempts`/`push_error` to the EXISTING `whatsapp_inbound_messages`
  // table (0048) — no new table. `getGhlAccountByTenantId` is the one method
  // this section adds that Phase 3's own plan document didn't name
  // explicitly: every row here is keyed by `coach_id` (historically a tenant
  // id, 0069), not `location_id`, so resolving the installing account (for
  // its access token, `conversation_provider_id` override, and
  // `locationId`) needs a tenant-id lookup that `getGhlAccountByLocationId`
  // cannot serve.
  // -------------------------------------------------------------------------

  /**
   * ONE location, TOKENS INCLUDED, keyed by ANY of the location's numbers'
   * `whatsapp_tenants.id` (resolved through `ghl_location_numbers`, any slot),
   * so an inbound row from any number finds its location. The returned
   * `GhlAccount.tenantId` is still `ghl_accounts.tenant_id` (the DEFAULT
   * number); callers that need the specific number use the inbound row's own
   * tenant id. `ghl_location_numbers.tenant_id` is its primary key, so this is
   * exactly as safe a lookup as `getGhlAccountByLocationId`. Never call this
   * from a page, a server action's caller, or any client component — same rule
   * as `getGhlAccountByLocationId`.
   */
  getGhlAccountByTenantId(tenantId: string): Promise<GhlAccount | null>;

  // -------------------------------------------------------------------------
  // Several WhatsApp numbers per location (migration 0003): up to 3
  // `ghl_location_numbers` rows per location, one `whatsapp_tenants` row each,
  // plus sticky per-contact routing (`ghl_contact_numbers`). All service-role;
  // `LocationNumber` carries a tenant id and must never reach a browser.
  // -------------------------------------------------------------------------

  /** The location's numbers, ordered by slot. */
  listLocationNumbers(locationId: string): Promise<LocationNumber[]>;

  /** One number by its slot, or null. */
  getLocationNumberBySlot(locationId: string, slot: number): Promise<LocationNumber | null>;

  /**
   * Mint a `whatsapp_tenants` row (kind `ghl_location`) and attach it at the
   * lowest free slot. `limit` when all three slots are taken (a unique-violation
   * race is retried once). The first number of a location becomes the default.
   */
  addLocationNumber(
    locationId: string,
    label: string | null
  ): Promise<{ ok: true; number: LocationNumber } | { ok: false; reason: "limit" }>;

  /**
   * Delete a number's `ghl_contact_numbers` and `ghl_location_numbers` rows
   * (FIRST: the number row has no ON DELETE on its tenant) and switch its
   * `whatsapp_groups` off (`enabled = false`), promoting the
   * lowest remaining slot to default when the default is removed. Does NOT
   * delete the `whatsapp_tenants` row: the caller logs the bridge session out
   * of `removedTenantId` first.
   */
  removeLocationNumber(
    locationId: string,
    slot: number
  ): Promise<{ ok: true; removedTenantId: string } | { ok: false; reason: "last_number" | "not_found" }>;

  /** Make `slot` the location's default (and mirror it to `ghl_accounts.tenant_id`). False when the slot does not exist. */
  setDefaultLocationNumber(locationId: string, slot: number): Promise<boolean>;

  /** Set (or clear, with `null`) one number's label — already trimmed and at most 40 characters (0003's CHECK). False when the slot does not exist. */
  setLocationNumberLabel(locationId: string, slot: number, label: string | null): Promise<boolean>;

  /** The tenant a contact most recently messaged on, or null (fall back to the default number). */
  getStickyTenant(locationId: string, ghlContactId: string): Promise<string | null>;

  /** Upsert the contact's sticky number, overwriting only when `receivedAtIso` is strictly newer. */
  recordInboundForStickiness(
    locationId: string,
    ghlContactId: string,
    tenantId: string,
    receivedAtIso: string
  ): Promise<void>;

  // -------------------------------------------------------------------------
  // Opt-in WhatsApp groups (migration 0004): `whatsapp_groups`, one row per
  // (number, group). Nothing is forwarded to GHL for a group until its row is
  // `enabled`; `ghl_contact_id` is the one GHL contact standing for the group.
  // All service-role; a `WhatsappGroup` carries a tenant id.
  // -------------------------------------------------------------------------

  /** Every group row stored for one number (tenant), enabled or not, ordered by name. */
  listWhatsappGroups(tenantId: string): Promise<WhatsappGroup[]>;

  /**
   * Switch a group on or off for one number — upsert on `(tenant_id,
   * group_jid)`, so the first switch-on creates the row. `groupJid` must match
   * 0004's CHECK (`^[0-9]+(-[0-9]+)?@g\.us$`) or this throws before any
   * write; `name` is trimmed to 100 characters. Switching on also clears
   * `left_at`. Never touches `ghl_contact_id`, so a re-enabled group posts
   * into its existing GHL contact. The caller asks the bridge to reload its
   * enabled set afterwards (`refreshWhatsappGroups`).
   */
  setWhatsappGroupEnabled(tenantId: string, groupJid: string, name: string, enabled: boolean): Promise<void>;

  /** Stamp `left_at = now()` — the number is no longer in the group (the bridge's "no longer in that group" send failure). Cleared by the next `setWhatsappGroupEnabled(..., true)`. */
  markWhatsappGroupLeft(tenantId: string, groupJid: string): Promise<void>;

  /**
   * The group a GHL contact stands for, searched across all of the
   * location's numbers, or null when the contact is not a group contact.
   * Returned whether or not the group is enabled, so the caller can refuse a
   * send to a switched-off group with its fixed string. `left` is
   * `left_at IS NOT NULL` (the number is no longer in the group), so a send
   * to a left group can be refused with the bridge's "no longer in that
   * group" string rather than "turned off". A group of a number since removed
   * from the location (its tenant is no longer any location's number) comes
   * back with `enabled: false` and `numberRemoved: true`: the caller refuses
   * it rather than treating the contact as a phone contact.
   */
  getWhatsappGroupByContact(
    locationId: string,
    ghlContactId: string
  ): Promise<{ tenantId: string; groupJid: string; enabled: boolean; left: boolean; numberRemoved?: boolean } | null>;

  /** Store the GHL contact created for a group (the inbound drain, before it posts the group's first message). */
  setWhatsappGroupContact(tenantId: string, groupJid: string, ghlContactId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // GHL custom conversation provider, Phase 1 (WAGHL replacement —
  // docs/GHL-PROVIDER-PLAN.md). See supabase/migrations/0069_ghl_provider.sql
  // for the schema: `ghl_accounts` (location<->tenant map, tokens) and
  // `ghl_outbound_messages` (webhook intake ledger + status tracker) both
  // enable RLS with NO policies — same posture as 0046/0048/0052, so every
  // method below is ALWAYS service-role regardless of accessor. The
  // token-bearing read and the human-facing read are separate methods with
  // separate return types on purpose, same "the shape itself can't leak it"
  // argument as `getBookingTargetCalendarConnection` vs
  // `listCalendarConnectionSummaries`.
  //
  // Phase 2 (docs/GHL-PROVIDER-PLAN.md's file list #12-15) is now built:
  // `recordGhlOutboundMessage` and everything below it are driven by
  // `src/lib/ghl-provider.ts`'s `handleProviderOutboundMessage`/
  // `drainGhlOutboundStatuses`, called from `POST /api/webhooks/crm-provider`,
  // `POST /api/webhooks/crm-outbound-status`, and the hourly reminders cron —
  // all sessionless, hence also exposed on `WebhookRepository` below.
  // -------------------------------------------------------------------------

  /** Every installed GHL location, redacted (no tokens) — the owner setup-links page's "GHL WhatsApp numbers" panel. */
  getGhlAccounts(): Promise<GhlAccountSummary[]>;

  /**
   * Install (or reinstall) — UPSERTs on `location_id` (0069's primary key).
   * A reinstall of a KNOWN `locationId` updates its tokens/label in place and
   * does NOT mint a new `whatsapp_tenants` row — the OAuth callback route
   * only calls `createGhlTenant()` for a genuinely new `locationId` (see
   * that route). Always resets `status` to `'active'` and clears
   * `last_error`, same "a reconnect clears a previous failure" convention as
   * `upsertCalendarConnection`.
   */
  upsertGhlAccount(draft: GhlAccountDraft): Promise<void>;

  /**
   * W-CONNECT-BRAND — write `brand_logo_path`/`brand_accent_color` (migration
   * 0076) for ONE GHL location, the "New repo method to save branding" this
   * feature needed. Mirrors `bumpGhlConnectLinkVersion` immediately above:
   * OWNER CTX ONLY, never exposed on `WebhookRepository` (nothing sessionless
   * ever edits a client's logo/colour), always service-role regardless of
   * accessor (this section's own header — `ghl_accounts` has no RLS policies
   * at all).
   *
   * Allow-listed to exactly these two fields, same "the patch shape IS the
   * security boundary" argument as `updateCoachBranding` — nothing reachable
   * through here can touch a location's tokens, status, or label.
   * `normaliseHex`'d at the LAST moment before the write
   * (`updateGhlAccountBrandingService`, src/lib/data/supabase.ts), so an
   * unparseable colour can never be persisted regardless of caller.
   *
   * Caller: `saveGhlAccountBrandingAction` (src/app/owner/setup-links/actions.ts),
   * which resolves `locationId` from an owner-supplied form field but — same
   * as every sibling GHL action on that file — re-checks the location
   * actually exists (`repo.getGhlAccountByLocationId`) before ever reaching
   * this call, so an unknown/typo'd id fails with an honest message rather
   * than a silent no-op UPDATE matching zero rows.
   */
  updateGhlAccountBranding(locationId: string, patch: GhlAccountBrandingPatch): Promise<void>;

  /**
   * Mint a fresh `whatsapp_tenants` row of kind `'ghl_location'` (0069) and
   * return its id — the bridge session key a new GHL install's WhatsApp
   * number will connect under. Called ONCE per genuinely new `locationId`
   * (see `upsertGhlAccount`'s JSDoc); a reinstall never calls this again.
   */
  createGhlTenant(): Promise<string>;

  /**
   * The winner of `claimGhlTokenRefresh` writes the new access token (and,
   * ALWAYS, a refresh token — GHL may omit one on a refresh response, so the
   * caller carries the old one through, mirroring `refreshGhlToken`'s own
   * regression-pinned contract) and clears the claim. Also resets `status`
   * to `'active'`/`last_error` to null — a successful refresh proves the
   * credential is good again. Called from `src/lib/ghl-provider.ts`'s
   * `resolveGhlAccessToken` (Phase 2).
   */
  saveGhlTokens(locationId: string, tokens: { accessToken: string; accessTokenExpiresAt: string; refreshToken: string }): Promise<void>;

  /**
   * GHL rejected the refresh token (`invalid_grant`) — flips `status` to
   * `'needs_reauth'`, records `error`, and clears the claim so a later
   * manual reinstall is never blocked by a stale claim timestamp. The owner
   * panel surfaces this as an actionable "reconnect" badge, same UX contract
   * as `markCalendarConnectionNeedsReauth`. Called from
   * `src/lib/ghl-provider.ts`'s `resolveGhlAccessToken` (Phase 2).
   */
  markGhlNeedsReauth(locationId: string, error: string): Promise<void>;

  /**
   * Atomic single-flight claim on a token refresh (plan's D2): flips
   * `token_refresh_claimed_at` to `now()` iff it is null or older than 30s,
   * and reports whether THIS call actually won the flip — same "row count
   * tells you who won" shape as `claimAutomationSequenceRun`/
   * `claimWhatsappInboundMessage`. The loser is expected to sleep ~1s and
   * re-read via `getGhlAccountByLocationId` rather than refresh itself, so a
   * possibly-single-use GHL refresh token is never spent twice concurrently.
   * Called from `src/lib/ghl-provider.ts`'s `resolveGhlAccessToken` (Phase 2).
   */
  claimGhlTokenRefresh(locationId: string): Promise<boolean>;

  /**
   * Per-client connect links (docs/GHL-PROVIDER-CLIENT-MIGRATION.md,
   * migration 0075) — "Revoke all links" in `GhlAccountsPanel.tsx`
   * (`revokeGhlConnectLinksAction`, `src/app/owner/setup-links/actions.ts`).
   * Increments `ghl_accounts.connect_link_version` for THIS location only —
   * see `GhlAccount.connectLinkVersion`'s own JSDoc (src/lib/types.ts) for why
   * that single counter is the entire revocation mechanism: every link token
   * ever minted for this location carries the OLD value and stops verifying
   * the instant this returns. OWNER CTX ONLY, unlike the other GHL methods on
   * this interface — never exposed on `WebhookRepository`, since nothing
   * sessionless ever needs to revoke a link (creating one does NOT call this
   * — see `createGhlConnectLinkAction`'s own comment for why minting must
   * never bump the version).
   */
  bumpGhlConnectLinkVersion(locationId: string): Promise<void>;

  /**
   * Insert-or-return-existing on the `(location_id, ghl_message_id)` dedupe
   * constraint (0069) — the webhook route's intake ledger write, same shape
   * as the bridge's own `acceptMessage`: a redelivered GHL webhook hits the
   * unique constraint and gets the EXISTING row back rather than a second
   * one, which is what makes "the handler never double-sends on a GHL
   * retry" true regardless of GHL's own retry semantics (plan's D3). Called
   * from `POST /api/webhooks/crm-provider` (Phase 2).
   */
  recordGhlOutboundMessage(draft: GhlOutboundMessageDraft): Promise<{ message: GhlOutboundMessage; isNew: boolean }>;

  /**
   * Advance a ledger row's `send_state`/`send_attempts` — Phase 2's
   * handler/drain only. IMPLEMENTATIONS MUST CLEAR `pending_text` to `null`
   * whenever `patch.sendState` is neither `'pending_send'` nor `'held'` (a held
   * row keeps its text so the release pass can still send it) (0070_ghl_outbound_pending_text.sql's
   * whole contract: that column exists only for the duration a row is
   * eligible for a bridge-send retry).
   *
   * `refusalReason` (0071_ghl_outbound_refusal_reason.sql, adversarial-review
   * finding 3): pass this whenever `sendState: 'refused'` — the fixed reason
   * this row is being refused with, stamped into `refusal_reason` so it
   * survives even if the report attempt that follows fails and overwrites
   * `report_error` with a DIFFERENT string (e.g. "no valid GHL access token
   * available"). Ignored for any other `sendState`.
   *
   * IMPLEMENTATIONS MUST GUARD the write with `WHERE send_state =
   * 'pending_send'` whenever `patch.sendState === 'pending_send'` (final
   * cross-phase review finding 2) — this is the ONLY case that needs it: a
   * caller retrying a `pending_send` row transiently is writing back the
   * SAME state it read the row in, and a faster concurrent pass can have
   * already moved the row past `pending_send` (to `accepted`, clearing
   * `pending_text`) in between. An unconditional write would silently demote
   * that row back to `pending_send` with `pending_text` left `null`
   * (`pending_text` is only ever CLEARED by this method, never restored),
   * producing an unrecoverable-looking row the drain would otherwise report
   * a false `failed` for. Every OTHER `sendState` transition this method
   * writes stays unconditional — see `src/lib/data/supabase.ts`'s
   * implementation for the exact guard.
   *
   * `onlyIfSendState` (Review Focus 4): when set, the write also requires the
   * row's CURRENT `send_state` to equal it (0 rows affected, no error, if it
   * has moved on). The held-release pass uses `held` → `accepted`/`refused`
   * under this guard so it never overwrites a row another pass already moved.
   * Returns the number of rows matched (0 or 1): a caller that reports the
   * outcome to GoHighLevel must only do so when it won the write (1).
   * Attachment rows have no `held` state and stay `pending_send` while their
   * parent message is held.
   */
  updateGhlOutboundSendState(
    id: string,
    patch: {
      sendState: GhlOutboundSendState;
      sendAttempts?: number;
      refusalReason?: string;
      onlyIfSendState?: GhlOutboundSendState;
    }
  ): Promise<number>;

  /**
   * Oldest-first, `reported_status IS NULL` rows, capped at `limit` — Phase
   * 2's `drainGhlOutboundStatuses` batch cap, same convention as
   * `getUnprocessedWhatsappInboundMessages`.
   *
   * ADVERSARIAL-REVIEW FINDING 1 (drain starvation): IMPLEMENTATIONS MUST
   * ALSO EXCLUDE rows whose `ghl_accounts.status <> 'active'` — a row tied to
   * a `needs_reauth`/`disabled` location cannot be reported right now no
   * matter how many times it's retried (there is no usable access token),
   * so leaving it eligible for this oldest-first, capped batch lets it
   * monopolise every pass once enough of them accumulate, starving healthy
   * rows — from OTHER locations whose sends already delivered — of ever
   * being looked at. Excluding them here is self-healing: the moment the
   * location reconnects (`status` flips back to `'active'`), its rows become
   * eligible again with no separate re-activation step.
   */
  listUnreportedGhlOutboundMessages(limit?: number): Promise<GhlOutboundMessage[]>;

  /**
   * Distinct tenant ids with at least one `send_state = 'held'` row (paged by
   * tenant, so one busy tenant cannot hide the others; capped at 1000 tenants)
   * — the release pass's work list.
   */
  listHeldTenantIds(): Promise<string[]>;

  /**
   * One tenant's `held` rows, oldest first (default 50). Held rows are NEVER
   * returned by `listUnreportedGhlOutboundMessages` (Review Focus 5): the main
   * drain must not report them failed while they wait for a reconnect.
   * `pending_text` is kept on held rows.
   */
  listHeldGhlOutboundMessages(tenantId: string, limit?: number): Promise<GhlOutboundMessage[]>;

  /**
   * `held` rows with `created_at < cutoffIso`, oldest first (default 50) — the
   * expiry sweep (see `isHeldExpired` in src/lib/ghl-held-rules.ts).
   */
  listExpiredHeldGhlOutboundMessages(cutoffIso: string, limit?: number): Promise<GhlOutboundMessage[]>;

  /**
   * Per-tenant count of rows `send_state in ('pending_send','held')` — the
   * "waiting" definition, same as `getLocationStats.pendingSend`. Tenants with
   * none are absent from the map (callers default to 0).
   */
  countHeldByTenant(tenantIds: string[]): Promise<Map<string, number>>;

  /**
   * Stamp a ledger row's reported outcome — Phase 2's drain only. No atomic
   * claim: an overlapping poke/cron pass PUTs the same status to GHL twice at
   * worst, which is idempotent server-side (plan's D3 — contrast with the
   * inbound drain, whose claim guards a side effect that must fire exactly
   * once).
   *
   * PHASE 2 ADAPTATION — `reportedStatus` accepts `null`: when the PUT to
   * GHL's own Update Message Status endpoint itself fails (network error,
   * 4xx/5xx), `src/lib/ghl-provider.ts` calls this with `reportedStatus: null`
   * and `reportError` set to a fixed reason — this stamps `report_error`
   * (visible for diagnosis) while leaving `reported_status` (and therefore
   * `listUnreportedGhlOutboundMessages`'s `IS NULL` filter) untouched, so the
   * row is picked up and retried on the next drain pass instead of being
   * silently marked done despite GHL never actually hearing the outcome.
   */
  markGhlOutboundReported(id: string, patch: { reportedStatus: GhlOutboundReportedStatus | null; reportError: string | null }): Promise<void>;

  // -------------------------------------------------------------------------
  // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — outbound
  // attachment PARTS of one `ghl_outbound_messages` row
  // (`ghl_outbound_attachments`, supabase/migrations/0073_whatsapp_media.sql,
  // NOT applied). Driven exclusively by `src/lib/ghl-provider.ts`'s
  // `handleMediaSplitOutbound`/`drainMultipartRow` — same sessionless,
  // service-role-only posture as everything else in this section, hence also
  // exposed on `WebhookRepository` below.
  // -------------------------------------------------------------------------

  /**
   * Bulk-insert the attachment parts for ONE `ghl_outbound_messages` row —
   * called exactly once per fresh (never-before-seen) message, AFTER every
   * pre-dispatch refusal check (phone/text-length/account status/accept-time
   * budget) has already passed (see `GhlOutboundAttachmentDraft`'s own
   * JSDoc) — a refused-before-dispatch message never reaches this call at
   * all, so it never accumulates orphan attachment rows. Returns the
   * inserted rows WITH their generated `id`s (needed immediately after by
   * the caller's dispatch loop to call `updateGhlOutboundAttachmentSendState`
   * per part).
   */
  recordGhlOutboundAttachments(drafts: GhlOutboundAttachmentDraft[]): Promise<GhlOutboundAttachment[]>;

  /**
   * Batch fetch, across MULTIPLE `ghl_outbound_messages` ids at once — the
   * drain's per-pass equivalent of `getWhatsappMessagesByTenantKeys`'s own
   * "one query for the whole batch, not one per row" discipline
   * (adversarial-review finding 2's argument applies identically here: a
   * per-row query inside `drainGhlOutboundStatuses`'s loop would not exceed
   * PostgREST's row cap the same way, but it would multiply the drain's
   * round-trip count by its batch cap for no reason). Ordered by
   * `(outbound_message_id, seq)` so a caller can group by the former and
   * trust ascending `seq` within each group without a second sort.
   */
  listGhlOutboundAttachmentsForMessages(outboundMessageIds: string[]): Promise<GhlOutboundAttachment[]>;

  /**
   * Advance ONE attachment part's `send_state` — the per-part sibling of
   * `updateGhlOutboundSendState`, same "clear pending_url once the part
   * leaves pending_send" / "stamp refusal_reason once, on the transition
   * into refused" rules as that method's own JSDoc (0073's `pending_url`
   * follows 0070's `pending_text` lifecycle verbatim — see that migration's
   * comment). `sendAttempts`, when provided, is persisted to
   * `ghl_outbound_attachments.send_attempts` (migration 0074, WRITTEN NOT
   * APPLIED — QA Major 5 fix): this table used to have no attempt counter at
   * all, so a `pending_send` attachment part retried on every drain pass
   * forever while the bridge was unreachable, monopolising the oldest-first
   * drain batch and starving newer rows. `resolveAttachmentPartOutcome`
   * (`src/lib/ghl-provider.ts`) now mirrors `retryTextPart`'s own
   * `PENDING_SEND_MAX_ATTEMPTS` bound using this column exactly like the
   * parent row's own text part (`GhlOutboundMessage.sendAttempts`).
   */
  updateGhlOutboundAttachmentSendState(id: string, patch: { sendState: GhlOutboundAttachmentSendState; sendAttempts?: number; refusalReason?: string }): Promise<void>;

  /**
   * Service-role read of `whatsapp_messages` by exact (tenantId,
   * idempotencyKey) pairs — the drain's status join (plan's D3: "joins
   * whatsapp_messages by (coach_id = tenant_id, idempotency_key) directly
   * via the service-role client — same database, no bridge HTTP call
   * needed"). The bare `coachId` field name in the return shape is
   * `whatsapp_messages`' own historical column name (0046, restated by
   * 0069's header) — for a row this method returns, it holds a tenant id,
   * not necessarily a coach id.
   */
  getWhatsappMessagesByTenantKeys(
    pairs: { tenantId: string; idempotencyKey: string }[]
  ): Promise<{ coachId: string; idempotencyKey: string; status: string; error: string | null }[]>;

  /**
   * The complement of `getUnprocessedWhatsappInboundMessages`'s coach-only
   * fence: every still-unprocessed (`processed_at IS NULL`) row for a
   * `kind = 'ghl_location'` tenant, oldest `created_at` first, capped at
   * `limit` (default 50 — same convention as every other drain batch cap in
   * this codebase).
   *
   * ADVERSARIAL-REVIEW FINDING 1, applied here from day one (same fix as
   * `listUnreportedGhlOutboundMessages`): IMPLEMENTATIONS MUST EXCLUDE rows
   * whose `ghl_accounts.status <> 'active'` — a `needs_reauth`/`disabled`
   * location's rows would otherwise starve every other location's rows out
   * of this oldest-first, capped batch once enough accumulate. Self-healing:
   * the moment the location reconnects, its rows are eligible again with no
   * separate step.
   *
   * DELIBERATELY NOT filtered on `push_attempts` here (unlike
   * `listUnreportedGhlOutboundMessages`'s sibling, which filters on
   * `reported_status IS NULL` alone too) — the bounded-retry give-up check
   * lives in `src/lib/ghl-inbound.ts`'s per-row processing (mirrors
   * `drainGhlOutboundStatuses`'s `drainPendingSend` exhaustion check,
   * `row.sendAttempts >= PENDING_SEND_MAX_ATTEMPTS`, exactly): a row that has
   * already exhausted its attempts stays `processed_at IS NULL` (never
   * claimed) until the NEXT pass's per-row check claims it and stamps the
   * terminal `'ghl_push_failed'` resolution. Filtering `push_attempts` at
   * the SQL level here would make an exhausted row invisible to every future
   * pass BEFORE it ever received that terminal stamp — silently orphaning it
   * at `processed_at = NULL` forever instead of leaving the candidate set.
   */
  getUnprocessedGhlInboundMessages(limit?: number): Promise<WhatsappInboundMessage[]>;

  /**
   * Atomic claim — flips ONE row's `processed_at` from `null` to `now()`
   * (`update ... where id = ? and processed_at is null`) and reports whether
   * THIS call actually won that flip. Mirrors `claimAutomationSequenceRun`'s
   * race-safety exactly: the bridge's contentless "poke"
   * (`POST /api/webhooks/whatsapp-replies`) and the hourly reminders cron's
   * own drain pass can overlap (a poke landing in the same second the cron
   * already started its own pass), and this is what makes double-processing
   * the SAME reply — a duplicate feed row, a duplicate auto-stop sweep, a
   * duplicate `whatsapp_reply` trigger fire — structurally impossible rather
   * than merely unlikely. The loser of the race simply skips the row: it was
   * already (or is about to be) handled by whichever call won.
   */
  claimWhatsappInboundMessage(id: string): Promise<boolean>;

  /**
   * Stamp a CLAIMED GHL-tenant row's terminal outcome — `resolution` is one
   * of `'ghl_pushed' | 'ghl_rejected' | 'ghl_push_failed' | 'ghl_push_uncertain'
   * | 'group_not_enabled'`
   * (free text, no CHECK — same convention as `resolveWhatsappInboundMessage`).
   * Deliberately a SEPARATE method from `resolveWhatsappInboundMessage`
   * (rather than widening that one's `resolution` union) so the coach
   * method's narrow `"matched" | "no_matching_call"` type stays exactly what
   * it was — a GHL-tenant resolution value can never accidentally reach the
   * coach drain's call site, and vice versa. Never touches `processed_at`
   * (already set by the claim `src/lib/ghl-inbound.ts` takes before ever
   * calling this — same "claim sets processed_at; resolve only stamps the
   * outcome" split `resolveWhatsappInboundMessage` already uses).
   * `pushError: null` clears any previously-stamped retryable-failure string
   * on a genuine success (`'ghl_pushed'`).
   */
  resolveGhlInboundMessage(id: string, patch: { resolution: string; pushError: string | null }): Promise<void>;

  /**
   * Bounded-retry bookkeeping for a GHL-tenant row's push attempt that
   * failed in a RETRYABLE way (contact upsert 429/5xx/network error, or the
   * inbound-message POST's 429/5xx) — never called for a TERMINAL outcome
   * (those go through `resolveGhlInboundMessage` instead). `attempts` is the
   * caller-computed new total (`row.pushAttempts + 1`); `pushError` is one of
   * `src/lib/ghl-inbound.ts`'s fixed reason strings or an HTTP-status-only
   * string from `src/lib/ghl.ts` (finding-13 rule — never a raw upstream
   * body). `unclaim: true` resets `processed_at` back to `null` — required
   * for a POST-stage failure (the row was already claimed before the POST,
   * per the claim-before-non-idempotent-call contract — see
   * `src/lib/ghl-inbound.ts`'s file header); `unclaim: false` for a
   * pre-claim (contact upsert) failure, where `processed_at` is already
   * `null` and there is nothing to reset.
   */
  recordGhlInboundPushFailure(id: string, patch: { attempts: number; pushError: string; unclaim: boolean }): Promise<void>;

  /**
   * 90-DAY RETENTION (adversarial-review fix, lens 3 finding 1 — 0048's own
   * file header always documented this purge as part of the package's
   * privacy decision; it was written down and never actually wired up until
   * this fix). Deletes every `whatsapp_inbound_messages` ROW (not just the
   * `body` column — the row's `from_phone` is itself a prospect's personal
   * phone number, so bounding retention means bounding the whole row) whose
   * `received_at` is older than `olderThanIso`. Called from the hourly
   * reminders cron with a 90-day cutoff — see that route for the exact call
   * site — non-fatal, same "never block the rest of the cron pass" contract
   * as every other pass there. Returns the number of rows actually deleted
   * (logged when non-zero, so a silent stop in purging is at least
   * observable in the cron's own output). Safe to call on an empty table
   * (hard rule 6 — no bridge yet) or repeatedly in the same hour (a
   * `lt(received_at, cutoff)` delete is naturally idempotent: nothing left
   * to delete the second time round).
   */
  purgeOldWhatsappInboundMessages(olderThanIso: string): Promise<number>;

  /**
   * Media plan (docs/MEDIA-PLAN.md §6.2 decision I3) — mints a signed URL
   * (TTL `WA_MEDIA_SIGNED_URL_TTL_DAYS`, default 90) for a `wa-media`
   * storage object; the sole read path into that private bucket. `null` on
   * any storage failure — `src/lib/ghl-inbound.ts` treats that identically
   * to any other media-resolution failure (push the fixed placeholder
   * instead, never crash the drain pass).
   */
  createWhatsappMediaSignedUrl(path: string): Promise<string | null>;

  /**
   * Single-coach variant (same service-role rationale as above) — `null`
   * when the coach has never connected. Deliberately left UNSCOPED on this
   * interface (unlike the bulk method above) because `src/lib/sequences.ts`'s
   * engine calls this from a service context with no session to derive a
   * `Scope` from — see that module's whatsapp execution branch.
   *
   * CALLER-SIDE AUTHORISATION IS THE PAGE'S JOB — this method itself performs
   * NO scoping at all, so every call site is individually responsible for
   * only ever passing an id its OWN session is entitled to see. This is NOT
   * an exhaustive "safe call sites" inventory (an adversarial review flagged
   * an earlier version of this comment for understating it — treat any such
   * list as guidance, not a compile-time guarantee, and re-verify against a
   * `grep` for this method's name before trusting it): as of this writing the
   * call sites are (a) the owner client-detail WhatsApp card's server page +
   * its three server actions (`src/app/owner/clients/[id]/actions.ts`) —
   * behind the owner layout redirect + `assertOwner()`; (b) the owner
   * sequence builder's `getClientSequencesAction`
   * (`src/app/owner/automations/actions.ts`) — same `assertOwner()` guard;
   * and (c) `/client/automations/page.tsx`, a COACH session calling this
   * with only its OWN `session.coachId` (never a client-supplied id) and
   * forwarding just a derived boolean (`whatsappStepAvailable`) to the
   * browser — safe because the id is self-selected, not because of any
   * owner check. SELF-SERVE COACH MODE (30 Jul 2026) adds (d)
   * `/client/setup/whatsapp/page.tsx`, the same pattern as (c): a coach
   * session passing only the id `loadSelfServeSetupPage()` derived from that
   * session, on a route that has no id parameter at all. "Any coach can link
   * their own WhatsApp" (also 30 Jul 2026) adds (e)
   * `/client/whatsapp/page.tsx` — identical pattern again, id derived by
   * `loadCoachWhatsappPage()` from the session, no route param. A future
   * call site must independently satisfy one of
   * these two patterns (owner-asserted with any id, or a session forwarding
   * only its own id) — never a client-supplied id with no server-side check.
   */
  getWhatsappSessionSummary(coachId: string): Promise<WhatsappSessionSummary | null>;

  // (supabase/migrations/0046_whatsapp_sessions.sql); the portal reads status
  // here (DB, always available even with the bridge down — hard rule 5) and
  // talks to the bridge itself only via src/lib/whatsapp-bridge.ts (live QR,
  // connect/logout/send).
  // -------------------------------------------------------------------------

  /**
   * Every WhatsApp session summary, SCOPE-REQUIRED: `scope` is REQUIRED, not
   * optional, precisely so a caller can never forget to say who's asking.
   *   - `scope.role === 'owner'` -> every row.
   *   - any other role (`'account'`) -> `[]` WITHOUT querying, fail-safe deny:
   *     accounts have no ownership column yet, so there is nothing safe to
   *     filter them down to until a later plan adds an account filter.
   * The reads underneath are still ALWAYS service-role in live mode
   * regardless of scope: 0046 enables RLS with NO policies on these tables
   * (so no browser-scoped client could select a credential column via
   * PostgREST even if it tried), which also means the cookie client would
   * read zero rows on its own. The scoping here is therefore CODE-level, not
   * RLS-level — both backends filter the result set themselves rather than
   * relying on a policy that doesn't exist. The supabase.ts implementation
   * selects the summary columns EXPLICITLY — `creds_enc` cannot ride along
   * (`WhatsappSessionSummary`'s JSDoc, src/lib/types.ts).
   */
  getWhatsappSessionSummaries(scope: Scope): Promise<WhatsappSessionSummary[]>;

  // -------------------------------------------------------------------------
  // GHL provider operator health surface (owner Setup Links, "GHL WhatsApp
  // health" panel) — the missing operator surface flagged after Phases 1-3:
  // three GHL API contracts in that build (the status PUT's enum, the
  // contacts upsert endpoint, the inbound POST's contactId acceptance) were
  // ASSUMED rather than confirmed live, and every one of them was mitigated
  // in the design docs with "the owner panel surfaces it" — but
  // `GhlAccountsPanel.tsx` only ever showed a per-location connection status
  // chip, so the go-live runbook (docs/GHL-PROVIDER-GO-LIVE.md) and the
  // migration doc (docs/GHL-PROVIDER-CLIENT-MIGRATION.md) both told the
  // operator to hand-query Supabase. Owner-only, READ-ONLY, no message
  // content, no phone numbers, no GHL contact ids — see
  // `GhlHealthSnapshot`'s own JSDoc (src/lib/types.ts) for the exact privacy
  // shape and `src/lib/ghl-health.ts` for the pure aggregation this method's
  // two reads feed into.
  // -------------------------------------------------------------------------

  /**
   * The whole owner health panel in one call — two bounded reads plus a
   * label lookup, reduced client-side by `buildGhlHealthSnapshot`
   * (src/lib/ghl-health.ts). Neither read fetches a whole table:
   *
   *   - OUTBOUND: `ghl_outbound_messages` rows with `reported_status IS
   *     NULL` (the exact backlog `drainGhlOutboundStatuses` itself retries —
   *     the SAME partial index, `ghl_outbound_unreported_idx`, 0069),
   *     newest `created_at` first, capped at
   *     `GHL_HEALTH_OUTBOUND_BACKLOG_CAP` (500) — see that constant's own
   *     JSDoc for why the filter itself is the real bound and the cap is
   *     only a safety net. Every installed location is represented even at
   *     zero rows (`buildGhlHealthSnapshot` seeds one entry per location
   *     from the label list below before folding these rows in).
   *   - INBOUND: `whatsapp_inbound_messages` rows for a `kind = 'ghl_location'`
   *     tenant (the SAME two-query fence `getUnprocessedGhlInboundMessages`
   *     uses — read every installed `ghl_accounts.tenant_id`, `.in()` against
   *     it; there is no direct FK to embed the filter in one query) with a
   *     non-null `resolution`, within `GHL_HEALTH_INBOUND_WINDOW_DAYS` (7)
   *     of `created_at`, capped at `GHL_HEALTH_INBOUND_ROW_CAP` (3000) —
   *     both constants live in src/lib/ghl-health.ts, see that file's header
   *   - WAITING (finding 9): a THIRD read, same tenant fence as INBOUND
   *     above but `resolution IS NULL` instead — rows genuinely waiting to
   *     be pushed, deliberately NOT time-windowed (unlike INBOUND) and NOT
   *     filtered by account status, capped the same way. Feeds
   *     `GhlInboundLocationHealth.waitingCount` — see src/lib/ghl-health.ts's
   *     header for why the other two reads alone left this blind.
   *     for why inbound needs a TIME window (never purged for 90 days,
   *     cold inbound ungated) where outbound doesn't.
   *
   * IMPLEMENTATIONS MUST NOT filter either read by `ghl_accounts.status` —
   * unlike the two drains (`listUnreportedGhlOutboundMessages`,
   * `getUnprocessedGhlInboundMessages`), which deliberately exclude
   * `needs_reauth`/`disabled` accounts to prevent retry starvation (finding
   * 1), THIS method exists to show the operator exactly what a stuck account
   * is doing — hiding a `needs_reauth` location's growing backlog would
   * defeat the panel's entire purpose.
   */
  getGhlHealthSnapshot(): Promise<GhlHealthSnapshot>;

  // -------------------------------------------------------------------------
  // Accounts and billing (migration 0002)
  // -------------------------------------------------------------------------

  /** One account by id, or null. */
  getAccountById(id: string): Promise<Account | null>;
  /** The account holding this Stripe customer id, or null. */
  getAccountByStripeCustomerId(customerId: string): Promise<Account | null>;
  /** Inserts an account with billingStatus 'pending' and returns it. */
  createAccount(draft: AccountDraft): Promise<Account>;
  /** Applies only the fields present in the patch. */
  updateAccountBilling(id: string, patch: AccountBillingPatch): Promise<void>;
  /** Every account with its location and activated-number counts, oldest first. */
  listAccountsForAdmin(): Promise<AccountAdminRow[]>;
  /** Accounts with cancelled_at < iso AND cleaned_up_at IS NULL. */
  listAccountsCancelledBefore(iso: string): Promise<Account[]>;
  /** Inserts a portal profile row for an existing auth user. */
  createProfile(draft: { id: string; role: Role; email: string; accountId: string | null }): Promise<void>;
  /** Profile lookup by lower-cased, trimmed email (all writes store it normalised), or null. */
  getProfileByEmail(email: string): Promise<{ id: string; role: Role; accountId: string | null } | null>;
  /** The redacted summaries of an account's locations, ordered by label. */
  listGhlAccountsForAccount(accountId: string): Promise<GhlAccountSummary[]>;
  /** Claims an unowned location (UPDATE ... WHERE account_id IS NULL); true iff exactly one row changed. */
  claimGhlAccount(locationId: string, accountId: string): Promise<boolean>;
  /**
   * Clears (null) or sets activated_at; returns the rows changed. Setting is conditional
   * (only while activated_at IS NULL, so 0 = already active) and the database enforces the
   * trial cap and the optional platform cap, throwing ActivationCapError when it refuses.
   */
  setGhlActivated(locationId: string, activatedAt: string | null, opts?: { platformCap?: number | null }): Promise<number>;
  /** Number of activated locations owned by this account. */
  countActivatedForAccount(accountId: string): Promise<number>;
  /** Number of activated locations across all accounts. */
  countActivatedAll(): Promise<number>;
  /** Session summaries for exactly these tenant ids (no role scope; callers authorise first). */
  getWhatsappSessionSummariesForTenants(tenantIds: string[]): Promise<WhatsappSessionSummary[]>;
  /** Per-location outbound stats since sinceIso; every requested id appears in the result. */
  getLocationStats(locationIds: string[], sinceIso: string): Promise<Record<string, LocationStats>>;
  /**
   * Records that `phone` opted out on this tenant's number (W10: one number
   * only). Upsert on (tenant_id, phone), refreshing `opted_out_at`, so a
   * repeated STOP is harmless. The phone is normalised with
   * `normalisePhoneE164(phone, "GB")` like every other phone in the portal;
   * one that cannot be normalised throws (never stored as a guess).
   */
  recordOptOut(input: { tenantId: string; phone: string; keyword: string; ghlContactId: string | null }): Promise<void>;
  /** Opt-in (START): deletes the (tenant, phone) opt-out; a no-op when absent or when the phone cannot be normalised. */
  clearOptOut(tenantId: string, phone: string): Promise<void>;
  /** True iff this (tenant, phone) has opted out. An unnormalisable phone is never opted out. */
  isOptedOut(tenantId: string, phone: string): Promise<boolean>;
  /** Opt-out counts per tenant; every requested id appears (0 when none). */
  countOptOutsByTenant(tenantIds: string[]): Promise<Map<string, number>>;
  /** Records a Stripe event id: INSERT ... ON CONFLICT DO NOTHING; true iff newly inserted. */
  recordStripeEvent(eventId: string, type: string): Promise<boolean>;
  /** Releases a recorded Stripe event id after a processing failure so Stripe's retry is handled, not dropped as a duplicate. */
  deleteStripeEvent(eventId: string): Promise<void>;
}
