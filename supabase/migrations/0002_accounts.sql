-- WA Connector — accounts, logins and billing schema.
--
-- Adds the customer account that owns portal logins and GHL installs, and the
-- Stripe event ledger that makes webhook handling idempotent.
--
-- POSTURE: service-role only. Every new table has RLS enabled and NO policies;
-- authorisation lives in server code (session + ownership check).
--
-- ghl_accounts.account_id IS NULL means "installed from the Marketplace, not
-- yet claimed by an account". ghl_accounts.activated_at non-null means
-- "billed, active number" (counts toward the Stripe quantity).
--
-- comped convention: the FitClosers account is inserted by hand with
-- billing_status = 'comped' and no Stripe ids. It never touches Stripe.
--
-- billing_status is only ever written from a Stripe subscription object.

create table public.accounts (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  kind                    text not null check (kind in ('agency', 'business')),
  owner_email             text not null,
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  billing_status          text not null default 'pending'
                            check (billing_status in ('pending', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'comped')),
  trial_ends_at           timestamptz,
  cancelled_at            timestamptz,
  cleaned_up_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.accounts is
  'A paying customer (agency or business). Owns profiles and ghl_accounts rows. billing_status mirrors the Stripe subscription; comped accounts have no Stripe ids. RLS: no policies — service-role only.';

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

alter table public.accounts enable row level security;
-- NO policies, deliberately — service-role only.

alter table public.profiles add column account_id uuid references public.accounts (id) on delete restrict;
-- Normalise any existing rows first so the plain unique index below is
-- equivalent to a case-insensitive one (every write path lower-cases).
update public.profiles set email = lower(trim(email));
create unique index profiles_email_idx on public.profiles (email);

alter table public.ghl_accounts add column account_id uuid references public.accounts (id) on delete restrict;
alter table public.ghl_accounts add column activated_at timestamptz;
create index ghl_accounts_account_idx on public.ghl_accounts (account_id);

create table public.stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

comment on table public.stripe_events is
  'Stripe event ids already handled (idempotency ledger for the billing webhook). RLS: no policies — service-role only.';

alter table public.stripe_events enable row level security;
-- NO policies, deliberately — service-role only.
