-- Workflow triggers: GHL workflow trigger subscriptions, per-number
-- disconnect/reconnect state, and a memory of contacts who are not on
-- WhatsApp.
--
-- Additive only. Deploy order: apply BEFORE the bridge or portal build that
-- reads these.

-- ---------------------------------------------------------------------------
-- ghl_workflow_trigger_subscriptions
-- ---------------------------------------------------------------------------

-- One row per GHL workflow that uses one of our triggers. `id` is GHL's own
-- triggerData.id. `target_url` is where we POST when the trigger fires; the
-- subscription webhook only stores leadconnectorhq.com https hosts.
create table public.ghl_workflow_trigger_subscriptions (
  id          text primary key,
  location_id text not null references public.ghl_accounts (location_id) on delete cascade,
  workflow_id text,
  trigger_key text not null check (trigger_key in (
    'whatsapp_disconnected',
    'whatsapp_reconnected',
    'whatsapp_message_received',
    'whatsapp_missed_call',
    'whatsapp_message_read',
    'whatsapp_not_on_whatsapp'
  )),
  target_url  text not null,
  filters     jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.ghl_workflow_trigger_subscriptions is
  'GHL provider — workflow trigger subscriptions (id = GHL triggerData.id). target_url is a leadconnectorhq.com https URL. RLS: no policies — service-role only.';

create index ghl_workflow_trigger_subscriptions_location_key_idx
  on public.ghl_workflow_trigger_subscriptions (location_id, trigger_key);

alter table public.ghl_workflow_trigger_subscriptions enable row level security;
-- NO policies, deliberately. Service-role only.

-- ---------------------------------------------------------------------------
-- whatsapp_sessions.trigger_down_since / trigger_last_fired
-- ---------------------------------------------------------------------------

-- trigger_down_since: when the number was first seen down (NULL = up).
-- trigger_last_fired: the last connection trigger fired for it, so a
-- disconnect fires once and a reconnect fires only after a disconnect fired.
alter table public.whatsapp_sessions
  add column if not exists trigger_down_since timestamptz,
  add column if not exists trigger_last_fired text
    check (trigger_last_fired is null or trigger_last_fired in ('down', 'up'));

-- trigger_phone: the number's E.164, stamped by the portal whenever it sees
-- phone_number set. The bridge's credential wipe (logged out / banned) nulls
-- phone_number but never this column, so the disconnect alert still has the
-- number.
alter table public.whatsapp_sessions
  add column if not exists trigger_phone text
    check (trigger_phone is null or trigger_phone ~ '^\+[1-9][0-9]{6,14}$');

-- ---------------------------------------------------------------------------
-- ghl_not_on_whatsapp
-- ---------------------------------------------------------------------------

-- Phones we found are not on WhatsApp, remembered per location until `until`.
create table public.ghl_not_on_whatsapp (
  location_id text not null references public.ghl_accounts (location_id) on delete cascade,
  phone_e164  text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  until       timestamptz not null,
  primary key (location_id, phone_e164)
);

comment on table public.ghl_not_on_whatsapp is
  'GHL provider — phones known not to be on WhatsApp, per location, until `until`. Cleared when the phone sends us a one-to-one inbound row. RLS: no policies — service-role only.';

alter table public.ghl_not_on_whatsapp enable row level security;
-- NO policies, deliberately. Service-role only.
