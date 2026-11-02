-- ---------------------------------------------------------------------------
-- PER-NUMBER BILLING — every WhatsApp number is its own Stripe subscription.
--
-- The billed unit moves from the activated sub-account (one subscription per
-- account, quantity = activated locations) to the WhatsApp NUMBER
-- (ghl_location_numbers row). Each number gets its own subscription, its own
-- 7-day trial and its own monthly charge on the day its trial ended. The
-- account's total of billed numbers sets the volume tier price applied to all
-- of them (src/lib/pricing.ts, src/lib/billing/numbers.ts).
--
-- ADDITIVE AND SAFE ON A LIVE DATABASE: new nullable columns only (null = "no
-- subscription yet"), no backfill, no rewrite of existing rows. The columns
-- are written only from a Stripe subscription object (create call or webhook).
--
-- accounts.billing_status now means "is a card on file" for a billed account:
-- 'pending' (no card yet) -> 'active' (card saved by the setup Checkout), or
-- 'comped' (never touches Stripe). accounts.stripe_subscription_id and
-- trial_ends_at stay for history but are no longer written.
--
-- The 0003 trial cap (3 activated locations while an account is 'trialing')
-- no longer exists: the trial is per number. activate_ghl_location is
-- replaced with the same function minus that rule; the platform cap stays.
-- ---------------------------------------------------------------------------

alter table public.ghl_location_numbers
  add column stripe_subscription_id text unique,
  add column billing_status text
    check (billing_status is null or billing_status in ('trialing', 'active', 'past_due', 'paused', 'incomplete', 'cancelled')),
  add column trial_ends_at timestamptz,
  add column price_pence integer check (price_pence is null or price_pence >= 0);

comment on column public.ghl_location_numbers.stripe_subscription_id is
  'This number''s own Stripe subscription (metadata: account_id, location_id, tenant_id). Kept after cancellation: a number that has had one restarts without a trial. Null = never subscribed.';
comment on column public.ghl_location_numbers.billing_status is
  'Mirror of the number''s Stripe subscription status. Only trialing/active/past_due may send (comped accounts excepted). Null = no subscription.';
comment on column public.ghl_location_numbers.trial_ends_at is
  'When this number''s free trial ends (its first charge and monthly billing anchor). Null outside a trial.';
comment on column public.ghl_location_numbers.price_pence is
  'Unit price in pence Stripe last reported for this number''s subscription; compared with the account''s tier price to re-price without proration.';

create or replace function public.activate_ghl_location(
  p_location_id  text,
  p_activated_at timestamptz,
  p_platform_cap integer default null
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_account uuid;
  v_rows    integer;
begin
  select account_id into v_account from public.ghl_accounts where location_id = p_location_id;
  if v_account is null then
    return 0;
  end if;

  -- Serialise this account's activations.
  perform 1 from public.accounts where id = v_account for update;

  if p_platform_cap is not null then
    perform pg_advisory_xact_lock(hashtext('ghl_activation_platform'));
  end if;

  if exists (select 1 from public.ghl_accounts where location_id = p_location_id and activated_at is not null) then
    return 0;
  end if;

  if p_platform_cap is not null
     and (select count(*) from public.ghl_accounts where activated_at is not null) >= p_platform_cap then
    raise exception 'platform_cap';
  end if;

  update public.ghl_accounts
     set activated_at = p_activated_at
   where location_id = p_location_id and activated_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.activate_ghl_location(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.activate_ghl_location(text, timestamptz, integer) to service_role;
