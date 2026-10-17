-- Message events: edits, reactions, deletes and quoted replies synced to GHL.
--
-- Additive only. Deploy order: apply BEFORE the bridge or portal build that
-- reads these.

-- ---------------------------------------------------------------------------
-- whatsapp_inbound_messages.target_wa_message_id / target_from_me
-- ---------------------------------------------------------------------------

-- For an 'edit', 'reaction' or 'delete' row (event_kind, 0010): the id of the
-- message it applies to, and whether that message was sent by us (true) or by
-- the contact (false). NULL for an ordinary message or a missed call, and for
-- any row written before this migration.
alter table public.whatsapp_inbound_messages
  add column if not exists target_wa_message_id text,
  add column if not exists target_from_me boolean;

-- No new index for the reaction-target lookup (coach_id, wa_message_id):
-- whatsapp_inbound_dedupe (0001) is a UNIQUE constraint on exactly that pair,
-- so Postgres already maintains a unique index that serves it.

-- ---------------------------------------------------------------------------
-- ghl_accounts.show_reactions / show_deletes
-- ---------------------------------------------------------------------------

-- Per-sub-account opt-ins. Reactions and deletes appear in GHL as new
-- messages and can trigger "Customer replied" workflows, so both are off
-- until the sub-account turns them on. Quoted replies and edits are real
-- replies and are always posted.
alter table public.ghl_accounts
  add column if not exists show_reactions boolean not null default false,
  add column if not exists show_deletes boolean not null default false;

-- RLS is already on for both tables; no new policies, deliberately.
-- Service-role only.
