-- 0005_groups.sql — WhatsApp group creation.
--
-- Ownership:
--   * Bridge writes: whatsapp_group_jobs, whatsapp_group_posts.
--   * Portal writes: whatsapp_groups, whatsapp_group_members.
-- No message body is ever stored (whatsapp_group_posts is a status ledger).
-- whatsapp_group_jobs.results[].phone exists only so the portal can reconcile
-- member rows after a job; the table is service-role only.
-- Every table: RLS enabled, no policies (service-role only).

create table public.whatsapp_group_jobs (
  id               uuid primary key default gen_random_uuid(),
  coach_id         uuid not null references public.whatsapp_tenants (id) on delete cascade,
  group_jid        text not null,
  kind             text not null check (kind in ('add', 'create')),
  status           text not null default 'queued'
                     check (status in ('queued', 'running', 'done', 'interrupted')),
  requested_count  int not null,
  results          jsonb not null default '[]',
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

create index whatsapp_group_jobs_coach_idx
  on public.whatsapp_group_jobs (coach_id, created_at desc);

comment on table public.whatsapp_group_jobs is
  'Bridge-owned ledger of WhatsApp group add-participant jobs and group creations (a create row is inserted already done). results[] holds {phone, code, outcome} per requested phone, used only to reconcile portal member rows. Doubles as the source of the per-day add/create caps. RLS: no policies, service-role only.';

alter table public.whatsapp_group_jobs enable row level security;

create table public.whatsapp_group_posts (
  id                  uuid primary key default gen_random_uuid(),
  coach_id            uuid not null references public.whatsapp_tenants (id) on delete cascade,
  group_jid           text not null,
  idempotency_key     text not null,
  status              text not null default 'accepted'
                        check (status in ('accepted', 'sending', 'sent', 'failed')),
  wa_message_id       text,
  error               text,
  dispatch_attempted  boolean not null default false,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  constraint whatsapp_group_posts_idempotency unique (coach_id, idempotency_key)
);

create index whatsapp_group_posts_coach_idx
  on public.whatsapp_group_posts (coach_id, created_at desc);

comment on table public.whatsapp_group_posts is
  'Bridge-owned status ledger of messages posted into WhatsApp groups. Stores NO message body. One row per idempotency key per number. RLS: no policies, service-role only.';

alter table public.whatsapp_group_posts enable row level security;

create table public.whatsapp_groups (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.whatsapp_tenants (id) on delete cascade,
  location_id           text not null references public.ghl_accounts (location_id) on delete cascade,
  account_id            uuid not null references public.accounts (id) on delete cascade,
  wa_group_jid          text not null unique,
  subject               text not null check (char_length(subject) between 1 and 100),
  description           text check (description is null or char_length(description) <= 2048),
  invite_code           text,
  announce_only         boolean not null default false,
  admin_add_only        boolean not null default true,
  participant_count     int not null default 1,
  we_are_admin          boolean not null default true,
  created_by_profile_id uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index whatsapp_groups_account_idx
  on public.whatsapp_groups (account_id, created_at desc);

create trigger trg_whatsapp_groups_set_updated_at
before update on public.whatsapp_groups
for each row
execute function public.set_updated_at();

comment on table public.whatsapp_groups is
  'Portal-owned: WhatsApp groups created from a customer''s connected number. RLS: no policies, service-role only.';

alter table public.whatsapp_groups enable row level security;

create table public.whatsapp_group_members (
  id                      uuid primary key default gen_random_uuid(),
  group_id                uuid not null references public.whatsapp_groups (id) on delete cascade,
  phone                   text not null
                            check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  ghl_contact_id          text,
  display_name            text check (display_name is null or char_length(display_name) <= 120),
  state                   text not null default 'pending'
                            check (state in ('pending', 'added', 'invite_needed', 'invite_sent', 'recently_left', 'already_member', 'not_on_whatsapp', 'group_full', 'opted_out', 'failed')),
  job_id                  uuid,
  invite_idempotency_key  text,
  consent_confirmed_at    timestamptz not null,
  added_by_profile_id     uuid references public.profiles (id) on delete set null,
  last_reason             text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (group_id, phone)
);

create index whatsapp_group_members_state_idx
  on public.whatsapp_group_members (group_id, state);

create trigger trg_whatsapp_group_members_set_updated_at
before update on public.whatsapp_group_members
for each row
execute function public.set_updated_at();

comment on table public.whatsapp_group_members is
  'Portal-owned: people added (or to be added) to a WhatsApp group, with the state WhatsApp answered and the consent timestamp. Phones are the customer''s own contacts, shown only on their own dashboard. RLS: no policies, service-role only.';

alter table public.whatsapp_group_members enable row level security;
