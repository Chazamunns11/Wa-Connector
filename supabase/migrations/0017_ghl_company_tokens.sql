-- ---------------------------------------------------------------------------
-- AGENCY (BULK) INSTALLS — keep the agency token, mint location tokens from it.
--
-- THE BUG THIS CLOSES (Nov 2026): installing from the agency chooser came back
-- `/admin?ghl=bulk_failed&installed=0&failed=1` and saved nothing. An agency
-- install hands back a Company token; the callback trades it for a location
-- token with `POST /oauth/locationToken`. Per HighLevel's own OpenAPI spec
-- (GoHighLevel/highlevel-api-docs, apps/oauth.json,
-- GetLocationAccessTokenSuccessfulResponseDto) that response carries NO
-- refresh_token, and `installGhlLocation` refused any token without one, so
-- every location "failed" without a log line. (The endpoint also needs the
-- agency-only `oauth.write` scope, which the app never asked for.)
--
-- WHAT CHANGES:
--   * ghl_companies holds ONE agency token per HighLevel company. It is not
--     copied onto each location: HighLevel refresh tokens rotate on use, so N
--     copies would invalidate each other on the first refresh.
--   * ghl_accounts.refresh_token becomes nullable. NULL means "minted from the
--     agency token" — the location is refreshed by re-minting from
--     ghl_companies (src/lib/ghl-provider.ts, resolveGhlAccessToken). A
--     location that does get its own refresh token keeps working as before.
--
-- Additive and safe on a live database: one new table, one relaxed NOT NULL.
-- ---------------------------------------------------------------------------

create table public.ghl_companies (
  company_id               text primary key,
  access_token             text not null,
  access_token_expires_at  timestamptz not null,
  -- Rotates on every refresh; stored as issued (same posture as
  -- ghl_accounts.refresh_token).
  refresh_token            text not null,
  -- The scopes HighLevel actually granted, as it reported them. Not secret;
  -- kept so a missing oauth.write is diagnosable from the database.
  scope                    text,
  status                   text not null default 'active'
                             check (status in ('active', 'needs_reauth')),
  -- Single-flight refresh claim, same shape as ghl_accounts.
  token_refresh_claimed_at timestamptz,
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.ghl_companies is
  'GHL provider — the agency (Company) OAuth token from an agency/bulk install, one row per HighLevel company. Used to mint location tokens via POST /oauth/locationToken for ghl_accounts rows whose refresh_token is NULL. SERVICE-ROLE ONLY: RLS on, no policies.';

alter table public.ghl_companies enable row level security;
-- NO policies, deliberately. Service-role only.

create trigger trg_ghl_companies_set_updated_at
before update on public.ghl_companies
for each row
execute function public.set_updated_at();

alter table public.ghl_accounts alter column refresh_token drop not null;

comment on column public.ghl_accounts.refresh_token is
  'Stored as issued, never app-encrypted (an app key would live in the same environment as the service-role key). Never selected by any summary read — see getGhlAccounts vs getGhlAccountByLocationId. NULL (0017) = installed through an agency install with no location refresh token: the access token is re-minted from ghl_companies for company_id.';
