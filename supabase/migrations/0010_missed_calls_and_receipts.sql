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
