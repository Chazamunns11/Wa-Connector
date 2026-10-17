-- Missed-call logging and read receipts.
--
-- Additive only. Deploy order: apply BEFORE the bridge or portal build that
-- reads these.

-- ---------------------------------------------------------------------------
-- whatsapp_inbound_messages.event_kind
-- ---------------------------------------------------------------------------

-- What kind of non-message event a row records. NULL for an ordinary message.
-- 'missed_call' is written by the bridge (body is NULL, message_type is
-- 'missedVoiceCall' or 'missedVideoCall'). 'edit', 'reaction' and 'delete'
-- are reserved for a later feature so it needs no second migration.
alter table public.whatsapp_inbound_messages
  add column if not exists event_kind text
    check (event_kind is null or event_kind in ('missed_call', 'edit', 'reaction', 'delete'));

-- Backs the one-missed-call-per-caller-per-10-minutes check. Partial: almost
-- every row is an ordinary message.
create index if not exists whatsapp_inbound_missed_call_idx
  on public.whatsapp_inbound_messages (coach_id, from_phone, received_at desc)
  where event_kind = 'missed_call';

-- ---------------------------------------------------------------------------
-- whatsapp_messages.delivered_at / read_at
-- ---------------------------------------------------------------------------

-- When WhatsApp first acknowledged delivery / reading of an outbound message.
-- Each is set once and never moves backwards; setting read_at also sets
-- delivered_at when it is NULL. NULL read_at means "no read ack seen", never
-- "not read".
alter table public.whatsapp_messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;

-- Backs the lookup of a ledger row by the id in an incoming receipt.
-- Partial: rows not yet sent have no wa_message_id.
create index if not exists whatsapp_messages_wa_id_idx
  on public.whatsapp_messages (coach_id, wa_message_id)
  where wa_message_id is not null;

-- ---------------------------------------------------------------------------
-- ghl_outbound_messages.read_reported_at / read_report_error
-- ---------------------------------------------------------------------------

-- When the 'read' status was PUT to GHL for this message. NULL until then.
alter table public.ghl_outbound_messages
  add column if not exists read_reported_at timestamptz;

-- Fixed diagnostic string (an HTTP status at most, never a response body)
-- from a failed or rejected 'read' report. NULL when none has failed.
alter table public.ghl_outbound_messages
  add column if not exists read_report_error text;

-- Backs the drain that reports 'read': rows GHL already knows as delivered
-- and not yet reported read. Partial, so it stays small.
create index if not exists ghl_outbound_read_pending_idx
  on public.ghl_outbound_messages (created_at)
  where reported_status = 'delivered' and read_reported_at is null;

-- RLS is already on for all three tables; no new policies, deliberately.
-- Service-role only.

-- ---------------------------------------------------------------------------
-- ghl_outbound_awaiting_read: the read-receipt drain's work list
-- ---------------------------------------------------------------------------

-- Delivered-and-not-yet-read-reported rows whose bridge ledger row HAS a
-- read_at, oldest first. The join lives in SQL so rows that were never read
-- (contacts with read receipts off) cannot fill the batch and starve the rest.
-- Only rows of an ACTIVE ghl_accounts location, the same fence
-- listUnreportedGhlOutboundMessages applies (ghl_accounts!inner(status)), so a
-- location that needs re-auth or is disabled cannot fill the batch either.
-- Service-role only, like activate_ghl_location.
create or replace function public.ghl_outbound_awaiting_read(p_since timestamptz, p_limit int)
returns table (
  id uuid,
  location_id text,
  tenant_id uuid,
  ghl_message_id text,
  ghl_contact_id text,
  idempotency_key text,
  to_phone text,
  had_attachments boolean,
  send_state text,
  send_attempts int,
  pending_text text,
  refusal_reason text,
  reported_status text,
  reported_at timestamptz,
  report_error text,
  read_reported_at timestamptz,
  read_report_error text,
  created_at timestamptz,
  read_at timestamptz
)
language sql
stable
security invoker
as $$
  select g.id, g.location_id, g.tenant_id, g.ghl_message_id, g.ghl_contact_id,
         g.idempotency_key, g.to_phone, g.had_attachments, g.send_state,
         g.send_attempts, g.pending_text, g.refusal_reason, g.reported_status,
         g.reported_at, g.report_error, g.read_reported_at, g.read_report_error,
         g.created_at, w.read_at
  from public.ghl_outbound_messages g
  join public.whatsapp_messages w
    on w.coach_id = g.tenant_id and w.idempotency_key = g.idempotency_key
  join public.ghl_accounts a
    on a.location_id = g.location_id and a.status = 'active'
  where g.reported_status = 'delivered'
    and g.read_reported_at is null
    and g.created_at >= p_since
    and w.read_at is not null
  order by g.created_at
  limit p_limit
$$;

revoke all on function public.ghl_outbound_awaiting_read(timestamptz, int) from public, anon, authenticated;
grant execute on function public.ghl_outbound_awaiting_read(timestamptz, int) to service_role;
