-- WA Connector — squashed initial schema for the standalone GHL WhatsApp
-- provider + bridge tables.
--
-- SOURCE: PortalHub supabase/migrations 0046, 0048, 0069, 0070, 0071, 0072,
-- 0073, 0074, 0075, 0076 — only the parts that touch whatsapp_* / ghl_*
-- tables, folded into plain CREATE TABLE statements (later ALTERs merged in),
-- keeping their indexes, comments, constraints, RLS-enabled-with-NO-policies
-- (service-role only) and the private wa-media storage bucket (0073).
--
-- CHANGES FROM THE SOURCE:
--   1. whatsapp_tenants.kind CHECK allows only 'ghl_location'. The coach_id
--      column, the kind-shape constraint, the coach backfill and the
--      coaches->tenant trigger/function (ensure_whatsapp_tenant_for_coach) are
--      dropped. The (id, kind) unique constraint is kept: ghl_accounts
--      references it.
--   2. whatsapp_inbound_messages: call_id and its FK to calls (and
--      whatsapp_inbound_call_idx) are dropped. `resolution` stays free text.
--   3. Every FK to coaches / calls / profiles is removed. The whatsapp_*
--      "coach_id" columns keep their name (the bridge code uses it) and
--      reference whatsapp_tenants(id), as 0069 retargeted them.
--      Tables that become unreferenced are not created.
--   4. Skipped (Hub sequences / calendar only): 0047, 0049, 0052, 0056, 0057.
--   5. Added: public.set_updated_at() (defined in PortalHub 0001, needed by the
--      updated_at triggers) and public.profiles (owner/account roles), RLS on,
--      no policies.
--   6. 0076 branding columns are kept on ghl_accounts. The shared
--      "client-logos" bucket (PortalHub 0066) is NOT created here; it is out
--      of this task's scope.
--
-- Deploy order: apply BEFORE the bridge or portal ever runs against the DB.

-- ---------------------------------------------------------------------------
-- Shared helper (PortalHub 0001_schema.sql)
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — portal users. RLS on, no policies: service-role only.
-- ---------------------------------------------------------------------------

create table public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  role       text not null check (role in ('owner', 'account')),
  email      text not null,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
-- NO policies — service-role only.

-- ---------------------------------------------------------------------------
-- whatsapp_tenants (0069) — the bridge session key. Every row is a GHL
-- location's tenant; a fresh uuid unrelated to any other table.
-- ---------------------------------------------------------------------------

create table public.whatsapp_tenants (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('ghl_location')),
  created_at timestamptz not null default now(),
  -- The composite target `ghl_accounts.tenant_id`/`tenant_kind` references
  -- below (kind-pinned FK).
  constraint whatsapp_tenants_id_kind unique (id, kind)
);

comment on table public.whatsapp_tenants is
  'GHL provider — the whatsapp_sessions/whatsapp_session_keys/whatsapp_messages/whatsapp_inbound_messages session key (historically a bare coach id). kind=''ghl_location'' rows back a ghl_accounts installation. RLS: no policies — service-role only, same posture as 0046.';

alter table public.whatsapp_tenants enable row level security;
-- NO policies, deliberately — service-role only.

-- ===========================================================================
-- 0046 — WhatsApp bridge foundation
-- SECURITY MODEL: `creds_enc` / `value_enc` are AES-256-GCM ciphertext
-- produced by the bridge (key only in the bridge's env, WA_CREDS_KEY), bound
-- via GCM AAD to the tenant id and column. RLS is enabled on every table with
-- NO policies: only the service-role key can touch these rows.
-- ===========================================================================

-- whatsapp_sessions — one row per tenant with a (current or former) linked
-- WhatsApp device: encrypted Baileys creds, portal-visible status, and the
-- single-writer lease (split-brain guard). The column keeps its historical
-- name "coach_id"; it holds a whatsapp_tenants.id.
create table public.whatsapp_sessions (
  coach_id             uuid primary key references public.whatsapp_tenants (id) on delete cascade,
  -- 'waiting_qr' means the bridge holds a live QR IN MEMORY (never stored
  -- here — a QR is a device-link grant, served only over the bridge's
  -- authenticated API and expiring in ~60s).
  status               text not null default 'disconnected'
                         check (status in ('disconnected', 'waiting_qr', 'connected', 'logged_out', 'banned')),
  -- The linked number, strict E.164 or NULL (same contract as
  -- src/lib/phone.ts).
  phone_number         text
                         constraint whatsapp_sessions_phone_e164 check (
                           phone_number is null or phone_number ~ '^\+[1-9][0-9]{6,14}$'
                         ),
  -- AES-256-GCM envelope (versioned, AAD-bound) of the Baileys
  -- AuthenticationCreds JSON. NULL = no device linked. NEVER selected by any
  -- portal read.
  creds_enc            text,
  last_connected_at    timestamptz,
  -- Human-readable close reason ('logged out from phone', 'banned (403)',
  -- 'connection replaced', …) — for the ops runbook, never raw stack traces.
  last_disconnect_reason text,
  -- Single-writer lease (split-brain guard): a Baileys session is ONE
  -- WebSocket; two bridge instances (overlapping deploys) running the same
  -- session corrupt the Signal ratchet state. An instance may only open a
  -- socket while it holds this lease, and must renew lock_heartbeat_at every
  -- WA_LOCK_HEARTBEAT_MS; a rival may steal the lease only when the heartbeat
  -- is older than WA_LOCK_TTL_MS.
  lock_instance_id     text,
  lock_heartbeat_at    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.whatsapp_sessions is
  'WhatsApp bridge foundation — one row per tenant with a linked device. creds_enc is AES-256-GCM ciphertext; the key lives only in the bridge''s env (services/whatsapp-bridge/src/crypto.ts), so a Supabase breach alone cannot hijack a session. RLS: no policies — service-role only.';

comment on column public.whatsapp_sessions.creds_enc is
  'Encrypted Baileys AuthenticationCreds (linked-device credential = full read/send access to the client''s WhatsApp). AES-256-GCM, key only in bridge env, AAD-bound to the tenant id so it cannot be replayed onto another tenant''s row. Never selected by portal reads, never logged, never in any API response.';

comment on column public.whatsapp_sessions.lock_instance_id is
  'Single-writer lease holder (bridge instance UUID). Guards against two bridge instances (overlapping deploys) opening the same WhatsApp session — see services/whatsapp-bridge/src/lock.ts.';

create trigger trg_whatsapp_sessions_set_updated_at
before update on public.whatsapp_sessions
for each row
execute function public.set_updated_at();

alter table public.whatsapp_sessions enable row level security;
-- NO policies, deliberately. Service-role only.

-- whatsapp_session_keys — the Baileys SignalKeyStore, one row per
-- (tenant, category, key id). Categories are Baileys' SignalDataTypeMap keys;
-- free text, not a CHECK, so a Baileys upgrade adding a category never needs
-- a migration.
create table public.whatsapp_session_keys (
  coach_id    uuid not null references public.whatsapp_tenants (id) on delete cascade,
  category    text not null,
  key_id      text not null,
  -- Same AES-256-GCM envelope as whatsapp_sessions.creds_enc (AAD-bound to
  -- tenant id + category + key_id). Signal key material is exactly as
  -- credential-grade as the creds blob.
  value_enc   text not null,
  updated_at  timestamptz not null default now(),
  primary key (coach_id, category, key_id)
);

comment on table public.whatsapp_session_keys is
  'Baileys SignalKeyStore backing rows (pre-keys, per-chat Signal sessions, sender keys, app-state sync keys). Same encryption + RLS posture as whatsapp_sessions.creds_enc — service-role only, ciphertext only.';

alter table public.whatsapp_session_keys enable row level security;
-- NO policies, deliberately. Service-role only.

-- whatsapp_messages — the send-path idempotency ledger + audit trail (a retry,
-- a cron re-run, or a redeploy must never deliver the same message twice to a
-- real human). One row per ACCEPTED send request, keyed by
-- (coach_id, idempotency_key); the unique constraint is the dedupe.
--
-- Status flow: accepted -> sending -> sent | failed | not_on_whatsapp.
-- 'sending' is the claim: the ONLY path to an actual Baileys send is the
-- atomic accepted->sending flip. A row found still 'sending' at bridge boot is
-- marked 'failed' and NEVER auto-retried (at-most-once on the real wire).
--
-- PRIVACY: the message BODY is deliberately NOT stored — identity and status
-- only. `to_phone` carries the strict E.164 CHECK.
create table public.whatsapp_messages (
  id               uuid primary key default gen_random_uuid(),
  coach_id         uuid not null references public.whatsapp_tenants (id) on delete cascade,
  idempotency_key  text not null,
  to_phone         text not null
                     constraint whatsapp_messages_to_phone_e164 check (
                       to_phone ~ '^\+[1-9][0-9]{6,14}$'
                     ),
  status           text not null default 'accepted'
                     check (status in ('accepted', 'sending', 'sent', 'failed', 'not_on_whatsapp')),
  -- WhatsApp's own message id, stamped on a successful send — the receipt.
  wa_message_id    text,
  -- Fixed reason string only (the bridge never writes a raw upstream
  -- error/stack here) — returned verbatim by authenticated bridge routes.
  error            text,
  -- True iff the bridge actually invoked Baileys' send API for this attempt.
  -- false + 'failed' = definitely never reached the wire (safe to reissue
  -- under a new key); true + 'failed' = outcome UNCERTAIN, must NOT be
  -- blindly reissued.
  dispatch_attempted boolean not null default false,
  -- 0073: which kind of frame this row was (diagnostics + the partial-failure
  -- status report). Default keeps every text row honest.
  kind             text not null default 'text' check (kind in ('text', 'media')),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  constraint whatsapp_messages_idempotency unique (coach_id, idempotency_key)
);

comment on table public.whatsapp_messages is
  'Send-path idempotency ledger (unique (coach_id, idempotency_key) is the dedupe) + per-tenant daily-cap counter source. Message BODIES are deliberately never stored — identity and status only. RLS: no policies — service-role only.';

-- Daily-cap counting (pacing.ts counts a tenant's sent-today rows at session
-- start) and the boot-time 'accepted'/'sending' sweep both filter
-- coach_id + created_at.
create index whatsapp_messages_coach_created_idx
  on public.whatsapp_messages (coach_id, created_at desc);

alter table public.whatsapp_messages enable row level security;
-- NO policies, deliberately. Service-role only.

-- ===========================================================================
-- 0048 + 0072 + 0073 — inbound WhatsApp replies
-- The bridge is the ONLY writer (service-role client); no portal endpoint
-- accepts reply DATA. The bridge only writes a row for a phone number this
-- tenant's own send ledger (whatsapp_messages) shows a status='sent' row to.
-- Body is BOUNDED (first 500 chars), NULL for non-text replies. For
-- ghl_location tenants the body is forwarded into the client's own GHL
-- conversation (0072 privacy amendment). Rows are purged once received_at is
-- more than 90 days old. Unique (coach_id, wa_message_id) makes redelivery a
-- harmless no-op insert.
-- ===========================================================================

create table public.whatsapp_inbound_messages (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references public.whatsapp_tenants (id) on delete cascade,
  -- The replying prospect's number. Strict E.164 or nothing reaches here.
  from_phone    text not null
                  constraint whatsapp_inbound_from_phone_e164 check (
                    from_phone ~ '^\+[1-9][0-9]{6,14}$'
                  ),
  -- Baileys' own message id (key.id) — the dedupe key alongside coach_id.
  wa_message_id text not null,
  -- First 500 chars of a PROSPECT-INITIATED message on a PORTAL-INITIATED
  -- thread only. NULL for a non-text reply (`message_type` still records it).
  body          text check (body is null or char_length(body) <= 500),
  -- The Baileys content-type key ('conversation', 'extendedTextMessage',
  -- 'imageMessage', 'audioMessage', …).
  message_type  text not null default 'conversation',
  received_at   timestamptz not null,
  -- NULL until the portal-side drain has processed this row; flipped under an
  -- atomic claim (the row count tells you who won).
  processed_at  timestamptz,
  -- Free text (not a CHECK) so a new resolution kind never needs a migration.
  -- Values in use: 'ghl_pushed', 'ghl_rejected', 'ghl_push_failed',
  -- 'ghl_push_uncertain'.
  resolution    text,
  -- 0072: bounded retry counter for the GHL inbound push. At 5 the row is
  -- terminally resolved 'ghl_push_failed'.
  push_attempts int not null default 0,
  push_error    text,
  -- 0073: inbound media bookkeeping (ghl_location tenants only; NULL for text
  -- replies).
  media_status     text
    check (media_status is null or media_status in
      ('pending', 'stored', 'too_large', 'rate_limited', 'failed')),
  media_path       text,   -- storage object path in the wa-media bucket
  media_mime       text,   -- SNIFFED mime, never the sender's claim
  media_size_bytes bigint check (media_size_bytes is null or media_size_bytes >= 0),
  created_at    timestamptz not null default now(),
  constraint whatsapp_inbound_dedupe unique (coach_id, wa_message_id)
);

comment on table public.whatsapp_inbound_messages is
  'Inbound WhatsApp replies from a tenant''s linked device, written directly by the bridge''s service-role client (the ONLY writer — no portal endpoint accepts reply data). Ledger-gated at the bridge: only numbers the portal itself has sent to (whatsapp_messages) ever produce a row here. body is bounded (<=500 chars), NULL for non-text replies. RLS: no policies — service-role only.';

comment on column public.whatsapp_inbound_messages.body is
  'First 500 chars of a prospect''s reply on a portal-initiated thread only. Whole row purged (not just this column) once received_at is over 90 days old.';

comment on column public.whatsapp_inbound_messages.processed_at is
  'NULL until the portal-side drain has processed this row exactly once. The drain claims a row by atomically flipping this from NULL.';

comment on column public.whatsapp_inbound_messages.push_attempts is
  'GHL inbound push — bounded retry counter. At 5 the row is terminally resolved ''ghl_push_failed'' (see src/lib/ghl-inbound.ts).';

comment on column public.whatsapp_inbound_messages.push_error is
  'Fixed diagnostic string from the last failed GHL push attempt (an HTTP status int at most, never a raw response body). Null for a row that has never failed a push.';

comment on column public.whatsapp_inbound_messages.media_status is
  'NULL for text replies (media capture not applicable). pending -> stored/too_large/rate_limited/failed, resolved by the bridge before it pokes. The GHL drain treats pending older than 10 minutes as failed (bridge died mid-download).';

-- Drain query: oldest unprocessed rows first.
create index whatsapp_inbound_unprocessed_idx
  on public.whatsapp_inbound_messages (created_at)
  where processed_at is null;

-- Send-time last-look and any coach+phone scoped read.
create index whatsapp_inbound_coach_phone_idx
  on public.whatsapp_inbound_messages (coach_id, from_phone, received_at desc);

alter table public.whatsapp_inbound_messages enable row level security;
-- NO policies, deliberately. Service-role only.

-- ===========================================================================
-- 0069 (+0070, 0071, 0075, 0076) — GHL custom conversation provider
-- ===========================================================================

-- ghl_accounts — one row per installed GHL sub-account. THE location<->tenant
-- map. `location_id` is GHL's own natural key.
--
-- KIND-PINNED FK: tenant_id references the COMPOSITE whatsapp_tenants(id, kind)
-- with tenant_kind hard-pinned by a CHECK to 'ghl_location'.
--
-- TOKEN STORAGE: access_token/refresh_token are stored as issued (Supabase
-- encrypts at rest); RLS enabled with NO policies — service-role only. The
-- owner panel renders a REDACTED summary.
create table public.ghl_accounts (
  location_id              text primary key,
  tenant_kind              text not null default 'ghl_location' check (tenant_kind = 'ghl_location'),
  tenant_id                uuid not null unique,
  foreign key (tenant_id, tenant_kind) references public.whatsapp_tenants (id, kind) on delete restrict,
  -- Human label for the owner setup-links panel.
  label                    text not null,
  company_id               text,
  -- GHL's own id for the conversation provider registration this install
  -- authorised against — nullable (app-wide, not always available per-install
  -- at token-exchange time).
  conversation_provider_id text,
  access_token             text,
  access_token_expires_at  timestamptz,
  refresh_token            text not null,
  status                   text not null default 'active'
                             check (status in ('active', 'needs_reauth', 'disabled')),
  -- Single-flight refresh claim — "row count tells you who won".
  token_refresh_claimed_at timestamptz,
  last_error               text,
  -- 0075: per-location connect-link generation. Minted into every link token
  -- and re-checked on verify; bumping it instantly invalidates every
  -- outstanding link for this location only.
  connect_link_version     integer not null default 0,
  -- 0076: per-client connect-page branding. brand_logo_path is a bare storage
  -- PATH ("ghl/<locationId>/<uuid>.png"), not a URL; brand_accent_color is a
  -- canonical #RRGGBB or null, normalised in app code (no CHECK).
  brand_logo_path          text,
  brand_accent_color       text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.ghl_accounts is
  'GHL provider — one row per installed GHL sub-account, mapping location_id (GHL''s own natural key) to a whatsapp_tenants row of kind ghl_location. SERVICE-ROLE ONLY: RLS is enabled with NO policies, so no authenticated session can ever read a token. The owner setup-links panel renders a redacted summary instead.';

comment on column public.ghl_accounts.refresh_token is
  'Stored as issued, never app-encrypted (an app key would live in the same environment as the service-role key). Never selected by any summary read — see getGhlAccounts vs getGhlAccountByLocationId.';

comment on column public.ghl_accounts.connect_link_version is
  'Per-client connect links. Bumped by "Revoke all links" — every previously-minted /connect/[token] link for this location carries the OLD value and fails the version check (410 link_revoked) the instant this changes. Read as a nullable number app-side so an unmigrated deployment fails closed instead of treating a missing column as generation 0.';

comment on column public.ghl_accounts.brand_logo_path is
  'Per-client connect-page branding — a PATH within the shared "client-logos" bucket, prefixed "ghl/<location_id>/", NOT a full URL. Resolved into a public URL on read by resolveLogoPath. Null = no logo uploaded yet (monogram-on-accent badge fallback).';

comment on column public.ghl_accounts.brand_accent_color is
  'Per-client connect-page branding — this location''s accent colour as a #RRGGBB hex, normalised on write by normaliseHex. The matching text colour is never stored: it is computed per render. Null = the default accent.';

alter table public.ghl_accounts enable row level security;
-- NO policies, deliberately. Service-role only.

create trigger trg_ghl_accounts_set_updated_at
before update on public.ghl_accounts
for each row
execute function public.set_updated_at();

-- ghl_outbound_messages — webhook intake ledger + status-report tracker for
-- messages GHL asked us to send over WhatsApp. No message BODY is stored
-- except the transient pending_text (0070).
create table public.ghl_outbound_messages (
  id               uuid primary key default gen_random_uuid(),
  location_id      text not null references public.ghl_accounts (location_id) on delete cascade,
  tenant_id        uuid not null references public.whatsapp_tenants (id) on delete cascade,
  -- GHL's own message id — the dedupe key alongside location_id and the basis
  -- for the bridge idempotency key (deriveIdempotencyKey).
  ghl_message_id   text not null,
  ghl_contact_id   text not null,
  -- The exact key passed to the bridge's send API — recorded so the status
  -- drain can look up the matching whatsapp_messages row.
  idempotency_key  text not null,
  to_phone         text check (to_phone is null or to_phone ~ '^\+[1-9][0-9]{6,14}$'),
  had_attachments  boolean not null default false,
  send_state       text not null default 'pending_send'
                     check (send_state in ('pending_send', 'accepted', 'refused')),
  send_attempts    int not null default 0,
  -- 0070: the exact text last built for this row, populated ONLY while
  -- send_state = 'pending_send' and cleared to null the instant the row leaves
  -- that state. Exists solely so drainGhlOutboundStatuses can retry a
  -- bridge-unreachable send with the SAME text under the SAME idempotency key.
  pending_text     text,
  -- 0071: the fixed reason string this row was refused with, stamped once when
  -- send_state becomes 'refused' and never overwritten (contrast report_error).
  refusal_reason   text,
  -- null | 'delivered' | 'failed' — what was last PUT to GHL's Update Message
  -- Status endpoint for this row, if anything yet.
  reported_status  text check (reported_status is null or reported_status in ('delivered', 'failed')),
  reported_at      timestamptz,
  report_error     text,
  created_at       timestamptz not null default now(),
  -- Portal-level dedupe of GHL webhook redelivery.
  constraint ghl_outbound_dedupe unique (location_id, ghl_message_id)
);

comment on table public.ghl_outbound_messages is
  'GHL provider — webhook intake ledger + delivery-status tracker for outbound WhatsApp sends GHL asked for. No message BODY beyond the transient pending_text. unique (location_id, ghl_message_id) is the portal-level dedupe of GHL webhook redelivery. RLS: no policies — service-role only.';

comment on column public.ghl_outbound_messages.pending_text is
  'The exact text last built for this row (src/lib/ghl.ts buildOutboundText), populated ONLY while send_state = ''pending_send'' and cleared to null the instant the row leaves that state. Exists solely so drainGhlOutboundStatuses can retry a bridge-unreachable send with the SAME text under the SAME idempotency key, never a placeholder.';

comment on column public.ghl_outbound_messages.refusal_reason is
  'The fixed reason string this row was refused with, stamped once when send_state becomes ''refused'' and never overwritten again (contrast with report_error, which records the separate — and separately mutable — question of whether GHL was successfully TOLD about it). Null for a row that has never been refused.';

-- Drain query: oldest unreported rows first.
create index ghl_outbound_unreported_idx on public.ghl_outbound_messages (created_at)
  where reported_status is null;

alter table public.ghl_outbound_messages enable row level security;
-- NO policies, deliberately. Service-role only.

-- ghl_outbound_attachments (0073 + 0074) — one row per attachment of one GHL
-- message. pending_url follows pending_text's populate-then-clear lifecycle.
create table public.ghl_outbound_attachments (
  id                  uuid primary key default gen_random_uuid(),
  outbound_message_id uuid not null references public.ghl_outbound_messages (id) on delete cascade,
  seq                 int  not null check (seq >= 0),
  -- sha256(ghlMessageId || ':a' || seq) — always valid against the bridge's
  -- idempotency-key regex, deterministic across webhook redelivery.
  idempotency_key     text not null,
  pending_url         text,           -- cleared once send_state leaves pending_send
  file_name           text check (file_name is null or char_length(file_name) <= 128),
  send_state          text not null default 'pending_send'
                        check (send_state in ('pending_send', 'accepted', 'refused')),
  refusal_reason      text,
  -- 0074: attempt counter, mirrors ghl_outbound_messages.send_attempts, so a
  -- permanently-unreachable bridge cannot starve the drain of newer rows.
  send_attempts       int not null default 0,
  created_at          timestamptz not null default now(),
  constraint ghl_outbound_attachments_dedupe unique (outbound_message_id, seq)
);

comment on table public.ghl_outbound_attachments is
  'The attachment parts of one GHL outbound message. Each part is its own bridge send with its own idempotency key; delivery truth lives in whatsapp_messages per part. RLS: no policies — service-role only.';

comment on column public.ghl_outbound_attachments.send_attempts is
  'Mirrors ghl_outbound_messages.send_attempts. Incremented on each transient bridge failure while this part sits pending_send; resolveAttachmentPartOutcome gives up past PENDING_SEND_MAX_ATTEMPTS so a permanently-unreachable bridge cannot starve the drain of newer rows forever.';

create index ghl_outbound_attachments_message_idx
  on public.ghl_outbound_attachments (outbound_message_id, seq);

alter table public.ghl_outbound_attachments enable row level security;
-- NO policies — service-role only.

-- ---------------------------------------------------------------------------
-- 0073 (d) — the private media bucket. No policies on storage.objects for this
-- bucket — service-role only, signed URLs are the sole read path. (If
-- storage.buckets insert privileges differ on the hosted project, create the
-- bucket once in the dashboard instead.)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wa-media', 'wa-media', false)
on conflict (id) do nothing;
