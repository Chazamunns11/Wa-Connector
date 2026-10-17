-- Group management: create groups, add and remove people, invite links.
--
-- Additive only. Deploy order: apply BEFORE the bridge or portal build that
-- reads these.

-- ---------------------------------------------------------------------------
-- whatsapp_groups.created_by_us
-- ---------------------------------------------------------------------------

-- true for a group this number created through the app, false for one it was
-- only added to. Lets the UI tell the two apart; management itself is gated
-- on being an admin, not on this flag.
alter table public.whatsapp_groups
  add column created_by_us boolean not null default false;

-- Backs the lookup of a group by its GHL contact (an outbound GHL message
-- names the contact, not the group). Partial: most rows have no contact yet.
create index whatsapp_groups_ghl_contact_idx on public.whatsapp_groups (ghl_contact_id)
  where ghl_contact_id is not null;

-- ---------------------------------------------------------------------------
-- whatsapp_group_actions — what each number has done to groups.
-- RLS on, no policies: service-role only.
-- ---------------------------------------------------------------------------

-- Only 'create' and 'add' rows count towards the per-number daily limits
-- (groups created, people added directly). Every other action is an audit
-- trail for a later owner view.
create table public.whatsapp_group_actions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.whatsapp_tenants (id) on delete cascade,
  -- NULL when the action has no group yet (a create that failed to produce one).
  group_jid   text check (group_jid is null or group_jid ~ '^[0-9]+(-[0-9]+)?@g\.us$'),
  action      text not null check (action in ('create', 'add', 'remove', 'promote', 'demote', 'update', 'invite_reset', 'leave')),
  -- How many people the action touched (1 for a create). Capped at the
  -- largest batch a single request may carry.
  count       int not null check (count between 1 and 50),
  created_at  timestamptz not null default now()
);

comment on table public.whatsapp_group_actions is
  'Group management actions per tenant. Only create and add rows count towards the daily limits; the rest is an audit trail. No group names, numbers or links are stored. RLS: no policies — service-role only.';

-- Daily-limit counts read (tenant, today).
create index whatsapp_group_actions_tenant_created_idx on public.whatsapp_group_actions (tenant_id, created_at);

alter table public.whatsapp_group_actions enable row level security;
-- NO policies, deliberately. Service-role only.

-- ---------------------------------------------------------------------------
-- ghl_accounts.group_invite_template
-- ---------------------------------------------------------------------------

-- The message sent to each invitee with the group's invite link. Per GHL
-- sub-account (each has its own wording, edited inside GHL). NULL means use
-- the built-in default. Placeholders: {first_name}, {group_name},
-- {coach_name}; {link} is required.
alter table public.ghl_accounts
  add column group_invite_template text
    check (
      group_invite_template is null or (
        char_length(group_invite_template) between 1 and 500
        and strpos(group_invite_template, '{link}') > 0
      )
    );
