/**
 * Type declarations copied from PortalHub `src/lib/types.ts` — only the WhatsApp
 * session / GHL provider slice (plus `Role`/`Scope`, which the copied
 * `getWhatsappSessionSummaries(scope)` signature takes). Never redefine these
 * elsewhere — import from here.
 *
 * Adaptation: `WhatsappInboundMessage.callId` is dropped (the schema has no
 * `call_id` column; nothing in this repo reads it).
 */

export type Role = "owner" | "account";

export interface Scope {
  role: Role;
}


// ---------------------------------------------------------------------------
// WhatsApp bridge foundation (WAGHL replacement, 29 Jul 2026) — portal-visible
// session state only. The bridge service (services/whatsapp-bridge/) owns the
// tables (supabase/migrations/0046_whatsapp_sessions.sql); the portal READS a
// summary and never touches credential columns.
// ---------------------------------------------------------------------------

/**
 * Mirrors whatsapp_sessions.status's CHECK constraint (0046) and the bridge's
 * own `SessionStatus` (services/whatsapp-bridge/src/store.ts) — all three
 * kept in lockstep by convention, same as `AutomationEvent` vs
 * automation_webhooks.event. 'waiting_qr' means the bridge holds a live QR
 * IN MEMORY (fetched via src/lib/whatsapp-bridge.ts, never stored/read from
 * the DB — a QR is a device-link grant).
 */
export type WhatsappSessionStatus = "disconnected" | "waiting_qr" | "connected" | "logged_out" | "banned";

/**
 * `Repository.getWhatsappSessionSummaries`/`getWhatsappSessionSummary`'s row
 * shape — deliberately EXCLUDES every credential column (creds_enc, lock_*):
 * the mapper selects columns explicitly, so a hijack-grade blob can never
 * ride along into a page prop (hard rule: creds are never returned by any
 * API response). This is what the future owner/coach "WhatsApp" card renders;
 * live QR/queue state comes from the bridge API instead
 * (src/lib/whatsapp-bridge.ts's `getWhatsappBridgeSession`).
 */
export interface WhatsappSessionSummary {
  coachId: string;
  status: WhatsappSessionStatus;
  /** The linked number (strict E.164, CHECK-backed) — "Connected as +44…" on the UI card. Null until first successful link. */
  phoneNumber: string | null;
  lastConnectedAt: string | null;
  /** Why the session last dropped ('logged out from phone', 'banned (403)', …) — human-readable, set by the bridge. */
  lastDisconnectReason: string | null;
  /**
   * WhatsApp UI package (29 Jul 2026) — count of this coach's own
   * `whatsapp_messages` rows with `status = 'sent'` and `sent_at` on today's
   * UTC calendar day. Read from the SAME table/definition the bridge's own
   * pacer counts against (0046's `whatsapp_messages`), so the portal's "Sends
   * today" figure and the bridge's own daily-cap enforcement never disagree.
   * `0` for a coach with no session row at all (never set up) — not a signal
   * of anything, just nothing sent.
   */
  sentToday: number;
}

/**
 * `WhatsappSessionSummary` MINUS `coachId` — what `POST /api/crm/embed/session`
 * (src/app/api/crm/embed/session/route.ts) is allowed to put on the wire
 * (adversarial review lens 4, finding 2 — MAJOR).
 *
 * `WhatsappSessionSummary.coachId` is, for a GHL location, literally
 * `ghl_accounts.tenant_id` — the exact id `src/lib/whatsapp-bridge.ts`
 * authorizes every bridge call on (`/sessions/${coachId}/...`). The embed
 * session route used to return `summary` verbatim, which handed that id
 * straight to an unauthenticated GHL iframe — directly contradicting the
 * "never client-supplied, never returned" invariant the three embed
 * WhatsApp routes themselves already hold (see
 * `src/app/api/crm/embed/whatsapp/connect/route.ts`'s header). This type
 * exists so that invariant is enforced by the compiler at the one place it
 * was actually broken, not just documented: the session route builds this
 * shape by ENUMERATING fields, never by spreading `WhatsappSessionSummary`
 * and deleting `coachId`, so a future field added to that interface can
 * never ride along by default.
 */
export type GhlEmbedWhatsappSummary = Omit<WhatsappSessionSummary, "coachId">;

// ---------------------------------------------------------------------------
// GHL custom conversation provider, Phase 1 (WAGHL replacement — replacing
// WA Connector 1 on 11-15 GHL sub-accounts with our own bridge, via a GHL
// custom conversation provider; docs/GHL-PROVIDER-PLAN.md). See
// supabase/migrations/0069_ghl_provider.sql for the schema, the kind-pinned
// FK that makes a GHL location resolving to a Hub coach's own WhatsApp
// number physically impossible, and the 0052 token-storage precedent this
// mirrors. src/lib/ghl.ts is the HTTP layer these types back.
//
// Phase 1 is plumbing/OAuth/the tenant map only — `GhlOutboundMessage` and
// its draft exist now so the schema, the repo interface, and both backends
// all compile against the same shape before Phase 2's webhook route (the
// only thing that actually writes/reads rows of substance) ships.
// ---------------------------------------------------------------------------

/** `'needs_reauth'` = GHL rejected the refresh token (see the plan's D2 — single-flight on-demand refresh). `'disabled'` = an operator turned this location off without uninstalling. Mirrors `ghl_accounts.status`'s CHECK (0069). */
export type GhlAccountStatus = "active" | "needs_reauth" | "disabled";

/**
 * One installed GHL sub-account <-> WhatsApp tenant mapping (`ghl_accounts`,
 * 0069), TOKENS INCLUDED. Service-role reads only — same "two types so a
 * function's return signature answers 'did I just leak a refresh token'"
 * split as `CalendarConnection`/`CalendarConnectionSummary`. Never return
 * this from a page, a server action's caller, or any client component — use
 * `GhlAccountSummary`.
 */
export interface GhlAccount {
  /** GHL's own natural key — primary key on `ghl_accounts`. */
  locationId: string;
  /** The `whatsapp_tenants` row (kind `ghl_location`) this location's WhatsApp session lives under. */
  tenantId: string;
  label: string;
  companyId: string | null;
  /** GHL's id for the conversation provider registration — set once known (see 0069's column comment); null until then. */
  conversationProviderId: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshToken: string;
  status: GhlAccountStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Per-client connect links (docs/GHL-PROVIDER-CLIENT-MIGRATION.md,
   * migration 0075) — the generation counter a `ghl-connect-link` token's `v`
   * field is checked against on every verify
   * (`src/app/api/connect/session/route.ts`). Bumped by
   * `Repository.bumpGhlConnectLinkVersion` ("Revoke all links" in
   * `GhlAccountsPanel.tsx"), which instantly invalidates every previously
   * minted link for THIS location without touching any other location or the
   * WhatsApp session itself — see 0075's own header for the full rationale.
   *
   * `null` MEANS "the `connect_link_version` column is absent or not a
   * number" — either a pre-0075 database (migration not applied yet) or a
   * genuinely malformed read — and is TREATED IDENTICALLY BY EVERY CALLER:
   * feature-unavailable, fail closed. This is DELIBERATELY NEVER defaulted to
   * `0` in `mapGhlAccount` (src/lib/data/supabase.ts): a freshly-migrated row
   * legitimately starts at generation `0` (0075's column default), so if a
   * missing column were ALSO mapped to `0`, a v=0 connect-link token minted
   * before the migration shipped (impossible in practice, since minting is
   * itself gated on this being non-null — but the point is the TYPE must not
   * make that gate unnecessary) would verify successfully against a database
   * that never actually created the column it claims to be checking. `number
   * | null` is what forces every mint/verify call site
   * (`src/lib/ghl-connect-link.ts`, `src/app/api/connect/guard.ts`) to
   * express that distinction in its own type signature rather than trusting
   * a comment.
   */
  connectLinkVersion: number | null;
  /**
   * Per-client connect-page branding (migration 0076,
   * docs/GHL-PROVIDER-CLIENT-MIGRATION.md) — a PATH within the shared
   * `client-logos` bucket (0066), NOT a URL. Resolve with `resolveLogoPath`
   * (src/lib/brand.ts) before rendering. `null` covers BOTH "no logo
   * uploaded yet" and "migration 0076 not applied" identically — unlike
   * `connectLinkVersion` this is not security-relevant, so there is no
   * fail-closed distinction to preserve: every reader treats `null` as
   * "show the monogram fallback", which is the correct behaviour either way
   * (see 0076's own header, "DEPLOY ORDER").
   */
  brandLogoPath: string | null;
  /** Per-client connect-page branding (migration 0076) — `#RRGGBB`, normalised by `normaliseHex` at write time, or `null` for the default brand colour. Same "null means unset OR pre-migration, and both read the same way" posture as `brandLogoPath` above. */
  brandAccentColor: string | null;
  /** Owning account (migration 0002); null = installed but not yet claimed. */
  accountId: string | null;
  /** Non-null = billed, active number (migration 0002). */
  activatedAt: string | null;
}

/** The redacted projection every UI surface gets — structurally unable to carry a token, same argument as `CalendarConnectionSummary`. Backs the owner setup-links "GHL WhatsApp numbers" panel. Carries the two branding fields (unlike the token/tenant internals) because `GhlAccountsPanel.tsx`'s branding editor renders directly off this summary — see `GhlAccount.brandLogoPath`/`brandAccentColor`'s own JSDoc. */
export interface GhlAccountSummary {
  locationId: string;
  tenantId: string;
  label: string;
  companyId: string | null;
  status: GhlAccountStatus;
  lastError: string | null;
  createdAt: string;
  brandLogoPath: string | null;
  brandAccentColor: string | null;
  accountId: string | null;
  activatedAt: string | null;
}

/**
 * W-CONNECT-BRAND — the branding write for one GHL location, mirroring
 * `CoachBrandingPatch`'s shape and reasoning exactly (src/lib/types.ts, W20):
 * each field is optional so the colour can be saved without touching the
 * logo and vice versa, and `null` explicitly CLEARS (back to monogram /
 * default teal) rather than leaving the previous value in place — which is
 * why these are `string | null` rather than plain `string`.
 *
 * Kept OFF any generic "edit this GHL location" patch for the same reason
 * `CoachBrandingPatch` is kept off `CoachPatch`: a logo arrives as an
 * uploaded FILE through `storeGhlAccountLogo`, which must own the whole
 * validate -> store -> record sequence, and `Repository.updateGhlAccountBranding`
 * is the only writer of these two columns.
 */
export interface GhlAccountBrandingPatch {
  brandLogoPath?: string | null;
  brandAccentColor?: string | null;
}

/** Written only by the OAuth callback route (`/api/crm/oauth/callback`) — install (a genuinely new `locationId`) or reinstall (an UPSERT on an existing one; see `Repository.upsertGhlAccount`'s JSDoc for why a reinstall never mints a second tenant). */
export interface GhlAccountDraft {
  locationId: string;
  tenantId: string;
  label: string;
  companyId: string | null;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
}

/** `'pending_send'` -> `'accepted'` (the bridge accepted the send) | `'refused'` (a terminal refusal reported inline — see the plan's D3 status table). Mirrors `ghl_outbound_messages.send_state`'s CHECK (0069). */
export type GhlOutboundSendState = "pending_send" | "accepted" | "refused";

/** What was last reported to GHL's Update Message Status endpoint for a row, if anything — `null` until Phase 2's drain reports an outcome. */
export type GhlOutboundReportedStatus = "delivered" | "failed";

/**
 * One "GHL asked us to send this over WhatsApp" webhook, intake-ledgered +
 * status-tracked (`ghl_outbound_messages`, 0069). No message BODY (0046's
 * privacy rule — this is an intake ledger + status tracker, not a
 * transcript). Phase 2 (`src/lib/ghl-provider.ts`, not part of this phase)
 * is the only reader/writer of substance.
 */
export interface GhlOutboundMessage {
  id: string;
  locationId: string;
  tenantId: string;
  ghlMessageId: string;
  ghlContactId: string;
  /** The exact key passed to the bridge's send API — GHL's `messageId` verbatim when it fits the bridge's `[A-Za-z0-9_-]{1,128}` regex, else its sha256 hex (`src/lib/ghl.ts`'s `deriveIdempotencyKey`). */
  idempotencyKey: string;
  /** `normalisePhoneE164(phone, "GB")` of GHL's `phone` field — `null` when that failed (an immediate `failed` status report, never a guess; see the plan's D5). */
  toPhone: string | null;
  hadAttachments: boolean;
  sendState: GhlOutboundSendState;
  sendAttempts: number;
  /**
   * Phase 2 addition (0070_ghl_outbound_pending_text.sql) — the exact text
   * `src/lib/ghl.ts`'s `buildOutboundText` built for this row, present ONLY
   * while `sendState === 'pending_send'`. See that migration's header for
   * why: `drainGhlOutboundStatuses` (src/lib/ghl-provider.ts) retries a
   * bridge-unreachable send under the SAME idempotency key, and that retry
   * is only correct if it resends this EXACT text — 0069's own "no message
   * body stored" posture made that retry impossible, so this column exists
   * purely to close that gap, cleared to `null` the instant the row leaves
   * `pending_send`.
   */
  pendingText: string | null;
  /**
   * 0071_ghl_outbound_refusal_reason.sql — the fixed reason string this row
   * was (or will be) refused with, stamped the instant `sendState` becomes
   * `'refused'`, alongside (not instead of) `reportError`. Exists because
   * `reportError` gets OVERWRITTEN by whatever went wrong with the GHL PUT
   * itself (e.g. "no valid GHL access token available" when the account
   * needs reauth, or the PUT's own HTTP failure) — without a separate,
   * never-overwritten field, the ORIGINAL reason (why the message was
   * refused in the first place) is lost the moment the first report attempt
   * fails, and `drainGhlOutboundStatuses`'s defensive retry for a still-
   * unreported 'refused' row (src/lib/ghl-provider.ts) had nothing to report
   * but a generic fallback (adversarial-review finding 3). `null` only for a
   * row that has never been refused.
   */
  refusalReason: string | null;
  reportedStatus: GhlOutboundReportedStatus | null;
  reportedAt: string | null;
  reportError: string | null;
  createdAt: string;
}

/** Input for `Repository.recordGhlOutboundMessage` — the webhook route's own fields, already normalised/derived by `src/lib/ghl.ts` before this is called. */
export interface GhlOutboundMessageDraft {
  locationId: string;
  tenantId: string;
  ghlMessageId: string;
  ghlContactId: string;
  idempotencyKey: string;
  toPhone: string | null;
  hadAttachments: boolean;
  /** See `GhlOutboundMessage.pendingText`'s JSDoc — non-null only when `toPhone` resolved AND `buildOutboundText` succeeded (i.e. this row is actually going to attempt a bridge send), `null` for a refusal recorded purely for the dedupe ledger. */
  pendingText: string | null;
}

// ---------------------------------------------------------------------------
// Media plan (docs/MEDIA-PLAN.md §5/§7b) — outbound attachment PARTS of one
// `ghl_outbound_messages` row (`ghl_outbound_attachments`,
// supabase/migrations/0073_whatsapp_media.sql, NOT applied — see that
// migration's own header). Built ONLY when `WA_MEDIA_OUTBOUND_ENABLED` is on
// AND the webhook payload actually carried attachments
// (`src/lib/ghl-provider.ts`'s `handleMediaSplitOutbound`) — a row with zero
// associated attachment rows (flag off, or no attachments) is the pre-media-
// plan single-send row, unchanged.
// ---------------------------------------------------------------------------

/** `'pending_send'` -> `'accepted'` (the bridge accepted THIS part's send) | `'refused'` (a terminal per-part refusal). Mirrors `ghl_outbound_attachments.send_state`'s CHECK (0073) — the exact same three-state shape as `GhlOutboundSendState`, kept as its own type so the two can diverge if a future need arises. */
export type GhlOutboundAttachmentSendState = "pending_send" | "accepted" | "refused";

/**
 * One attachment part of a multipart GHL outbound message
 * (`ghl_outbound_attachments`, 0073) — plan §5.1's "N+1 separate bridge
 * sends" model, one row per attachment (`seq`, 0-based). `idempotencyKey` is
 * `deriveAttachmentIdempotencyKey(ghlMessageId, seq)` (`src/lib/ghl.ts`) —
 * always the sha256 digest, never GHL's message id verbatim, so it can never
 * collide with the parent row's own (text-part) idempotency key. Delivery
 * truth for a `sendState = 'accepted'` part lives in `whatsapp_messages`,
 * exactly like the parent row's own text part — this table is intake +
 * status tracking only, same "no message body stored" posture 0069 set for
 * `ghl_outbound_messages` (the attachment URL itself is GHL-hosted
 * content-adjacent data, not ours to keep past dispatch — see `pendingUrl`).
 */
export interface GhlOutboundAttachment {
  id: string;
  outboundMessageId: string;
  seq: number;
  idempotencyKey: string;
  /** Populate-then-clear, same lifecycle as `GhlOutboundMessage.pendingText` (0070) — held only while `sendState === 'pending_send'` (the drain's retry candidate window), cleared the instant the part leaves that state. */
  pendingUrl: string | null;
  /** Display name for a document attachment, ≤128 chars — `null` when GHL's payload carried no filename for this URL (today's `attachments: string[]` payload shape never does; see `Repository.recordGhlOutboundAttachments`'s JSDoc). */
  fileName: string | null;
  sendState: GhlOutboundAttachmentSendState;
  /** The fixed reason this part was (or will be) refused with — stamped once, the instant `sendState` becomes `'refused'`, same "never overwritten again" rule as `GhlOutboundMessage.refusalReason` (0071). `null` for a part that has never been refused. */
  refusalReason: string | null;
  /** QA Major 5 fix (migration 0074, WRITTEN NOT APPLIED) — mirrors `GhlOutboundMessage.sendAttempts` (0069). Incremented on each transient bridge failure while this part sits `pending_send`; `resolveAttachmentPartOutcome` (`src/lib/ghl-provider.ts`) gives up past `PENDING_SEND_MAX_ATTEMPTS`, the same bound the text part already uses, so a permanently-unreachable bridge cannot retry this part forever and starve the drain of newer rows. */
  sendAttempts: number;
  createdAt: string;
}

/** Input for `Repository.recordGhlOutboundAttachments` — one draft per attachment URL, built by `src/lib/ghl-provider.ts` AFTER the parent `ghl_outbound_messages` row exists (needs its id) and AFTER every pre-dispatch refusal check (phone/text-length/account status/accept-time budget) has already passed — a message refused before dispatch never gets attachment rows at all. */
export interface GhlOutboundAttachmentDraft {
  outboundMessageId: string;
  seq: number;
  idempotencyKey: string;
  pendingUrl: string;
  fileName: string | null;
}

// ---------------------------------------------------------------------------
// Inbound WhatsApp replies (BATCH 4, 29 Jul 2026 — "where a human sees
// replies") — the read-side type for `whatsapp_inbound_messages`
// (supabase/migrations/0048_whatsapp_inbound.sql). That migration (and its
// own header) is the authority on the privacy decision this type reflects:
// `body` is bounded (<=500 chars) and present ONLY for a portal-initiated
// thread (the bridge's own ledger gate — see that migration's header — never
// a coach's personal inbox at large); `null` for a non-text reply, with
// `messageType` naming what arrived instead ('conversation' | 'imageMessage'
// | 'audioMessage' | ... — Baileys' own `getContentType` key, free text, no
// CHECK). The bridge (service-role) is the ONLY writer; this type is a pure
// READ shape.
// ---------------------------------------------------------------------------

/**
 * One prospect-authored WhatsApp reply, as read back for a single call's
 * "WhatsApp replies" drawer section (`Repository.getWhatsappInboundMessagesForCall`,
 * src/lib/data/index.ts — see that method's JSDoc for the caller-side
 * authorisation contract every call site must independently satisfy, same
 * "code-level scoping, not RLS" shape as `WhatsappSessionSummary`'s reads
 * just above). NEVER include this row's `body` in a feed title, an
 * automation webhook payload, or a sequence merge field — see 0048's header
 * and `src/lib/feed.ts`/`src/lib/automations.ts`'s own PRIVACY notes for the
 * cross-coach leak that would otherwise create.
 */
export interface WhatsappInboundMessage {
  id: string;
  coachId: string;
  /** The replying prospect's own number — strict E.164 (0048's CHECK), same contract as `Call.prospectPhone`. */
  fromPhone: string;
  /** First 500 chars of the prospect's message; `null` for a non-text reply — see `messageType`. */
  body: string | null;
  /** Baileys' own content-type key (`'conversation'`, `'imageMessage'`, `'audioMessage'`, …) — a body-less row still names what arrived, so a reader can render "Voice note" / "Photo" instead of a blank line. */
  messageType: string;
  receivedAt: string;
  /** `null` while still queued for the portal-side drain; set (alongside `resolution`) once processed exactly once. */
  processedAt: string | null;
  /**
   * `'matched' | 'no_matching_call'` (coach-tenant rows) or — GHL provider
   * Phase 3, `supabase/migrations/0072_ghl_inbound_push.sql` —
   * `'ghl_pushed' | 'ghl_rejected' | 'ghl_push_failed' | 'ghl_push_uncertain'`
   * (GHL-tenant rows; `src/lib/ghl-inbound.ts`'s `drainGhlInboundReplies` is
   * the only writer of these four). Free text (no CHECK), mirrors
   * `automation_sequences.trigger_event`'s convention — a new resolution kind
   * never needs a migration. `null` until processed.
   */
  resolution: string | null;
  /**
   * GHL provider Phase 3 (0072) — bounded retry counter for the GHL inbound
   * push. Always `0` for a coach-tenant row (the coach drain never touches
   * this column). At 5 the row is terminally resolved `'ghl_push_failed'` —
   * see `src/lib/ghl-inbound.ts`'s retry table.
   */
  pushAttempts: number;
  /**
   * GHL provider Phase 3 (0072) — the fixed diagnostic string from the last
   * failed GHL push attempt (HTTP status int at most, never a raw response
   * body — same finding-13 rule Phase 1-2's `report_error` follows). `null`
   * for coach-tenant rows and for a row that has never failed a push.
   */
  pushError: string | null;
  createdAt: string;
  /**
   * Media plan (docs/MEDIA-PLAN.md §6, `supabase/migrations/0073_whatsapp_media.sql`) —
   * `'pending' | 'stored' | 'too_large' | 'rate_limited' | 'failed'`, or
   * `undefined`/`null` when media capture never applied to this row at all:
   * a text reply, a coach-tenant row (hard fence — media capture is
   * `ghl_location` tenants only, enforced bridge-side, never by this column
   * being absent), or ANY row written while `WA_MEDIA_INBOUND_ENABLED` was
   * false on the bridge. Optional rather than required (unlike
   * `pushAttempts`/`pushError`) so demo-mode fixtures need no change — demo
   * mode has no GHL-tenant row at all, so this is always absent there,
   * exactly like "not applicable" in live mode.
   */
  mediaStatus?: "pending" | "stored" | "too_large" | "rate_limited" | "failed" | null;
  /** The storage object path inside the `wa-media` bucket, set only once `mediaStatus === 'stored'`. */
  mediaPath?: string | null;
  /** SNIFFED mime (never the sender's claim) — set only once `mediaStatus === 'stored'`. */
  mediaMime?: string | null;
  /** Actual downloaded byte size — set only once `mediaStatus === 'stored'`. */
  mediaSizeBytes?: number | null;
}

// ---------------------------------------------------------------------------
// GHL provider operator health surface (owner Setup Links, "GHL WhatsApp
// health" panel) — the missing piece flagged after Phases 1-3 shipped: three
// GHL API contracts in that build were ASSUMED rather than confirmed against
// a live account, and the documented mitigation for all three was "the owner
// panel surfaces it" — but no such panel existed, so the go-live runbook
// (docs/GHL-PROVIDER-GO-LIVE.md) and the migration doc
// (docs/GHL-PROVIDER-CLIENT-MIGRATION.md) both told the operator to
// hand-query Supabase (`report_error`/`push_error` "in the DB"). This section
// is READ-ONLY — nothing here is ever written by anything except the two
// bounded reads `Repository.getGhlHealthSnapshot` runs (src/lib/data/index.ts);
// no field triggers a retry or a resend. Pure aggregation lives in
// src/lib/ghl-health.ts (`buildGhlHealthSnapshot`), mirroring
// src/lib/integration-health.ts's split from `CoachIntegrationHealth`.
// ---------------------------------------------------------------------------

/**
 * Per-location outbound send-status backlog — answers the go-live runbook's
 * "GHL shows pending forever" symptom without a DB query. Built from exactly
 * the `reported_status IS NULL` rows `drainGhlOutboundStatuses`
 * (src/lib/ghl-provider.ts) itself retries — see
 * `Repository.getGhlHealthSnapshot`'s JSDoc for the bounded query behind it.
 */
export interface GhlOutboundLocationHealth {
  locationId: string;
  label: string;
  /** Unreported rows younger than `GHL_HEALTH_STALE_MS` (src/lib/ghl-health.ts, one hour) — GHL is showing "pending", but the drain hasn't had a pass to resolve it yet; not itself a problem. */
  pendingUnderOneHour: number;
  /** Unreported rows AT LEAST `GHL_HEALTH_STALE_MS` old — many drain passes have had a chance to resolve these and haven't; worth a look. */
  pendingOverOneHour: number;
  /**
   * Rows whose last `PUT .../status` attempt itself failed
   * (`report_error IS NOT NULL`) — a SUBSET of the two counts above, never
   * additional to them: `reportGhlOutcome` (src/lib/ghl-provider.ts) sets
   * `reportedStatus`/`reportError` as a strict either/or on every write (see
   * `buildGhlHealthSnapshot`'s own header for the full argument), so a row
   * with a `reportError` is, by construction, always still unreported too.
   */
  erroredCount: number;
  /** The most recent `report_error` string across this location's errored rows, or `null`. Always one of the fixed strings `src/lib/ghl-provider.ts`/`src/lib/ghl.ts` write (finding-13 rule) — never a raw GHL/Supabase error body. */
  latestReportError: string | null;
}

/**
 * Per-location inbound-push resolution counts, within the health window
 * (`GHL_HEALTH_INBOUND_WINDOW_DAYS`, src/lib/ghl-health.ts) — answers the
 * runbook's "replies aren't showing up in GHL" symptom.
 */
export interface GhlInboundLocationHealth {
  locationId: string;
  label: string;
  /** `resolution = 'ghl_pushed'` within the window — healthy, reached GHL. */
  pushedCount: number;
  /**
   * `resolution = 'ghl_push_uncertain'` — THE one outcome the go-live
   * runbook says means a human must open that GHL conversation by hand (the
   * reply may or may not have landed — never retried automatically, to keep
   * at-most-once). Deliberately its own field, never folded into a generic
   * "problems" total: `GhlHealthPanel.tsx` renders this with its own
   * unmissable callout, never buried in a routine-failure count.
   */
  uncertainCount: number;
  /** `resolution = 'ghl_push_failed'` — retried up to 5 times (0072's `push_attempts` bound) and given up; the reply never reached GHL. */
  failedCount: number;
  /** `resolution = 'ghl_rejected'` — GHL gave a definite non-2xx refusal; usually a contract-shape mismatch (go-live doc Part 7's "verify at first go-live" list). */
  rejectedCount: number;
  /** Which of the three problem kinds `latestProblemError` belongs to, or `null` if this location has none in the window. */
  latestProblemKind: "ghl_push_uncertain" | "ghl_push_failed" | "ghl_rejected" | null;
  /** The most recent `push_error` string across this location's uncertain/failed/rejected rows in the window, or `null`. Same fixed-string guarantee as `GhlOutboundLocationHealth.latestReportError`. */
  latestProblemError: string | null;
  /**
   * Final cross-phase review, finding 9 (LOW) — rows for this location still
   * `resolution IS NULL` (the exact candidate set `getUnprocessedGhlInboundMessages`
   * reads) — i.e. genuinely waiting to be pushed to GHL, not yet attempted or
   * mid-retry. NOT time-windowed (unlike the four counts above) and NOT
   * filtered by account status — a stalled drain (broken `CRON_SECRET`,
   * failing pokes, or every row fenced out by a `needs_reauth` location) used
   * to be invisible here: every OTHER count in this interface only counts
   * rows the drain has already finished with, so a stalled queue rendered as
   * an all-zero, all-healthy panel. See `src/lib/ghl-health.ts`'s header for
   * the full argument.
   */
  waitingCount: number;
}

/**
 * One row in the health panel's "recent problems" incident list.
 * Deliberately carries NO message content, NO prospect phone number, NO GHL
 * contact id — the panel's hard privacy constraint (this is a health panel,
 * not an inbox; reply text goes to the client's own GHL and nowhere else in
 * this UI). `detail` is always one of the fixed reason strings
 * `src/lib/ghl-provider.ts`/`src/lib/ghl-inbound.ts` already write, never raw
 * upstream output.
 */
export interface GhlHealthProblem {
  locationId: string;
  label: string;
  atIso: string;
  kind: "outbound_report_error" | "ghl_push_uncertain" | "ghl_push_failed" | "ghl_rejected";
  detail: string;
}

/**
 * `Repository.getGhlHealthSnapshot`'s return shape — the whole owner health
 * panel in one read. `outbound`/`inbound` carry one entry per INSTALLED
 * location regardless of activity (zero counts included, so a healthy
 * location reads "0 issues" rather than silently vanishing from the panel) —
 * see that method's own JSDoc (src/lib/data/index.ts) for the exact bounded
 * queries behind both arrays.
 */
export interface GhlHealthSnapshot {
  outbound: GhlOutboundLocationHealth[];
  inbound: GhlInboundLocationHealth[];
  /** Newest-first, capped at `GHL_HEALTH_RECENT_PROBLEMS_LIMIT` (src/lib/ghl-health.ts) — merges outbound report errors and inbound uncertain/failed/rejected rows into one glance-able list ("something's wrong with client X" in one look). */
  recentProblems: GhlHealthProblem[];
  /**
   * Final cross-phase review, finding 3 — `true` whenever ANY of the
   * snapshot's bounded reads came back with exactly its cap's worth of rows
   * (`GHL_HEALTH_OUTBOUND_BACKLOG_CAP`/`GHL_HEALTH_INBOUND_ROW_CAP`,
   * src/lib/ghl-health.ts), meaning more rows may have been silently cut off
   * (an arbitrary newest-first slice, not necessarily this location's own
   * rows — one flooding location can evict another's out of a global,
   * uncapped-per-location query). When `true`, every count in `outbound`/
   * `inbound` is a LOWER BOUND, not a complete figure — `GhlHealthPanel.tsx`
   * renders a visible banner rather than presenting them as complete.
   */
  truncated: boolean;
}

/** How a client's logo is seated on the connect page (copied from PortalHub `types.ts`; only the type — `brand.ts`'s `ResolvedBranding` needs it). */
export type LogoBackdrop = "none" | "light" | "dark";

// ---------------------------------------------------------------------------
// Accounts and billing (migration 0002)
// ---------------------------------------------------------------------------

export type BillingStatus = "pending" | "trialing" | "active" | "past_due" | "paused" | "cancelled" | "comped";
export type AccountKind = "agency" | "business";

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  ownerEmail: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingStatus: BillingStatus;
  trialEndsAt: string | null;
  cancelledAt: string | null;
  cleanedUpAt: string | null;
  createdAt: string;
}

/** Inserts with billingStatus 'pending'. */
export interface AccountDraft {
  name: string;
  kind: AccountKind;
  ownerEmail: string;
}

export interface AccountBillingPatch {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  billingStatus?: BillingStatus;
  trialEndsAt?: string | null;
  cancelledAt?: string | null;
  cleanedUpAt?: string | null;
}

export interface AccountAdminRow {
  account: Account;
  locations: number;
  activeNumbers: number;
}

export interface LocationStats {
  pendingSend: number;
  failedLast7Days: { count: number; reasons: string[] };
  everReceived: boolean;
}
