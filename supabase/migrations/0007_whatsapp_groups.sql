-- Opt-in WhatsApp groups, and the inbound columns that carry them.
--
-- WHY OPT-IN: a linked number can sit in dozens of groups, and mirroring all
-- of them into GHL would flood the client's CRM with contacts and
-- conversations they never asked for. A group row is created when the owner
-- switches a group on in the embed (the app's setWhatsappGroupEnabled, from
-- the bridge's live group list); groups never switched on have no row and
-- nothing from them is forwarded or stored. Switching a group off keeps its
-- row with `enabled = false` (the column defaults to false), and no GHL
-- contact is made until the first forwarded message.
--
-- Deploy order: apply BEFORE the bridge or portal build that reads these.

-- ---------------------------------------------------------------------------
-- whatsapp_groups — one row per (number, group). RLS on, no policies:
-- service-role only.
-- ---------------------------------------------------------------------------

create table public.whatsapp_groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.whatsapp_tenants (id) on delete cascade,
  -- WhatsApp group id, e.g. 120363012345678901@g.us or 447700900123-1600000000@g.us.
  group_jid   text not null check (group_jid ~ '^[0-9]+(-[0-9]+)?@g\.us$'),
  name        text not null check (char_length(name) <= 100),
  -- Opt-in switch; see the header. false until the client turns it on.
  enabled     boolean not null default false,
  -- The GHL contact that stands for this group in the conversation list.
  -- NULL until the first forwarded message creates it.
  ghl_contact_id text,
  -- Set when the number leaves or is removed from the group; NULL while a
  -- member. Kept (not deleted) so the client's choice survives a rejoin.
  left_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint whatsapp_groups_tenant_jid unique (tenant_id, group_jid)
);

comment on table public.whatsapp_groups is
  'WhatsApp groups seen by a tenant''s linked number. Opt-in: enabled defaults to false and nothing is forwarded to GHL until the client enables the group. ghl_contact_id is the GHL contact standing for the group. RLS: no policies — service-role only.';

create trigger trg_whatsapp_groups_set_updated_at
before update on public.whatsapp_groups
for each row
execute function public.set_updated_at();

alter table public.whatsapp_groups enable row level security;
-- NO policies, deliberately. Service-role only.

-- ---------------------------------------------------------------------------
-- Inbound columns for group messages.
-- ---------------------------------------------------------------------------

alter table public.whatsapp_inbound_messages
  add column group_jid text,
  add column sender_name text
    constraint whatsapp_inbound_sender_name_len check (
      sender_name is null or char_length(sender_name) <= 60
    );

comment on column public.whatsapp_inbound_messages.group_jid is
  'NULL for a one-to-one reply. For a message from an enabled WhatsApp group, the group''s jid (whatsapp_groups.group_jid); from_phone is then the member who wrote it.';

comment on column public.whatsapp_inbound_messages.sender_name is
  'The group member''s WhatsApp display name (<=60 chars), shown as a prefix in the GHL message. NULL for one-to-one replies.';
