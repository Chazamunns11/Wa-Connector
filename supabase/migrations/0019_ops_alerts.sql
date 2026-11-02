-- ---------------------------------------------------------------------------
-- OPERATOR ALERTS — "your WhatsApp dropped" emails, sent once per outage.
--
-- One row per thing that is currently DOWN (a number's session, the bridge,
-- a location's HighLevel connection), keyed e.g. `session:<tenant uuid>`,
-- `bridge`, `ghl:<location id>`. Written by the health cron
-- (src/app/api/cron/health/route.ts, src/lib/session-alerts.ts):
--   * first pass that sees it down inserts the row (down_since);
--   * the pass that claims `alerted_at` (UPDATE ... WHERE alerted_at IS NULL)
--     is the only one that emails, so overlapping passes alert once;
--   * when it is back up the row is DELETEd, and only the pass whose DELETE
--     returned an alerted row sends "reconnected".
-- Deliberately separate from whatsapp_sessions.trigger_* (workflow triggers),
-- so the two features can never block each other.
-- ---------------------------------------------------------------------------

create table public.ops_alerts (
  key         text primary key check (char_length(key) between 1 and 200),
  down_since  timestamptz not null default now(),
  alerted_at  timestamptz,
  detail      text check (detail is null or char_length(detail) <= 500)
);

comment on table public.ops_alerts is
  'Health cron alert state: one row per thing currently down (session:<tenant>, bridge, ghl:<location>). alerted_at claimed once per outage; row deleted on recovery. RLS: no policies — service-role only.';

alter table public.ops_alerts enable row level security;
-- NO policies, deliberately. Service-role only.
