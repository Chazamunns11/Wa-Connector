-- Several WhatsApp numbers per GHL sub-account (up to 3), one
-- whatsapp_tenants row per number, plus "sticky" per-contact number routing.
-- Design: docs/superpowers/specs/2026-10-17-multiple-numbers-per-sub-account-design.md
--
-- ghl_accounts is UNCHANGED: its tenant_id keeps meaning "the default number's
-- tenant", so every existing read keeps working.
--
-- Deploy order: apply BEFORE the portal build that reads these tables.

-- ---------------------------------------------------------------------------
-- ghl_location_numbers — the numbers of one GHL location. RLS on, no
-- policies: service-role only.
-- ---------------------------------------------------------------------------

create table public.ghl_location_numbers (
  -- The number's own tenant (one tenant per number: the bridge session, lease,
  -- pacer, daily cap and warm-up are all keyed on it).
  tenant_id   uuid primary key references public.whatsapp_tenants (id),
  location_id text not null references public.ghl_accounts (location_id) on delete cascade,
  -- The number's position, 1 to 3. This is what the browser sees (embed
  -- routes, connect links, UI); a tenant id never leaves the server.
  slot        smallint not null check (slot between 1 and 3),
  -- Exactly one default per location (partial unique index below). It is the
  -- sender for a contact with no sticky number, and mirrors
  -- ghl_accounts.tenant_id.
  is_default  boolean not null default false,
  -- Human label shown in the UI and in the inbound prefix ("Sales line").
  label       text check (label is null or char_length(label) <= 40),
  created_at  timestamptz not null default now(),
  constraint ghl_location_numbers_slot_unique unique (location_id, slot)
);

comment on table public.ghl_location_numbers is
  'GHL provider — the WhatsApp numbers (one whatsapp_tenants row each) of a GHL location, at most 3 (limit enforced in the add-number server action, slot is checked 1 to 3). Exactly one is_default per location. ghl_accounts.tenant_id still means the default number''s tenant. RLS: no policies — service-role only.';

comment on column public.ghl_location_numbers.slot is
  'The number''s position (1 to 3) within its location. Browser-facing surfaces address a number by slot, never by tenant id.';

-- Exactly one default number per location.
create unique index ghl_location_numbers_one_default_idx
  on public.ghl_location_numbers (location_id)
  where is_default;

alter table public.ghl_location_numbers enable row level security;
-- NO policies, deliberately. Service-role only.

-- Backfill: each existing location's current tenant becomes slot 1, default.
insert into public.ghl_location_numbers (tenant_id, location_id, slot, is_default)
select tenant_id, location_id, 1, true
from public.ghl_accounts
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- ghl_contact_numbers — stickiness: which number a contact last wrote to.
-- Written by the inbound drain (only if newer), read by outbound.
-- ---------------------------------------------------------------------------

create table public.ghl_contact_numbers (
  location_id     text not null references public.ghl_accounts (location_id) on delete cascade,
  ghl_contact_id  text not null,
  -- Deleted with the tenant, so a removed number leaves no sticky rows and its
  -- contacts fall back to the default number.
  tenant_id       uuid not null references public.whatsapp_tenants (id) on delete cascade,
  -- The most recent inbound from this contact on that number. Compared on
  -- write so out-of-order drain rows never overwrite a newer one.
  last_inbound_at timestamptz not null,
  primary key (location_id, ghl_contact_id)
);

comment on table public.ghl_contact_numbers is
  'GHL provider — sticky routing: the number (tenant) a contact most recently messaged, so replies go out from that number. Written by the inbound drain only when newer than last_inbound_at. RLS: no policies — service-role only.';

alter table public.ghl_contact_numbers enable row level security;
-- NO policies, deliberately. Service-role only.
