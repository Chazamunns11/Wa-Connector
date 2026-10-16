-- WA Connector — race-safe number activation.
--
-- The app checks the trial cap before activating, but two parallel requests can
-- both pass that check. This function is the authority: it takes a row lock on
-- the owning account (serialising that account's activations), re-counts the
-- activated rows, applies the caps and writes activated_at only if it is still
-- null. Returns the number of rows changed (0 = already active or not owned).
-- Cap refusals raise 'trial_cap' / 'platform_cap' (SQLSTATE P0001).
--
-- The trial cap of 3 mirrors TRIAL_MAX_NUMBERS in src/lib/pricing.ts.
-- POSTURE: service-role only (execute revoked from every other role).

create function public.activate_ghl_location(
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
  v_status  text;
  v_rows    integer;
begin
  select account_id into v_account from public.ghl_accounts where location_id = p_location_id;
  if v_account is null then
    return 0;
  end if;

  -- Serialise this account's activations.
  select billing_status into v_status from public.accounts where id = v_account for update;

  if p_platform_cap is not null then
    perform pg_advisory_xact_lock(hashtext('ghl_activation_platform'));
  end if;

  if exists (select 1 from public.ghl_accounts where location_id = p_location_id and activated_at is not null) then
    return 0;
  end if;

  if v_status = 'trialing'
     and (select count(*) from public.ghl_accounts where account_id = v_account and activated_at is not null) >= 3 then
    raise exception 'trial_cap';
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
