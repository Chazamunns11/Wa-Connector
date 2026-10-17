-- SMS fallback B: when a contact isn't on WhatsApp, PingWren asks GoHighLevel
-- to send the same text as an SMS (docs/superpowers/plans/2026-10-17-sms-fallback-b.md).
--
-- Additive only. Deploy order: apply BEFORE the portal build that reads these.
-- The global switch (GHL_SMS_FALLBACK_ENABLED) stays off until the sandbox
-- check, so applying this changes nothing on its own.

-- ---------------------------------------------------------------------------
-- ghl_accounts.sms_fallback_enabled / sms_fallback_blocked_at
-- ---------------------------------------------------------------------------

-- sms_fallback_enabled: the sub-account's own switch, on unless it turns it off.
-- sms_fallback_blocked_at: set by the loop guard when GoHighLevel handed our
-- own fallback SMS back to PingWren (PingWren is that sub-account's SMS
-- provider). While set, that sub-account never falls back. Switching the
-- setting on again clears it.
alter table public.ghl_accounts
  add column if not exists sms_fallback_enabled boolean not null default true,
  add column if not exists sms_fallback_blocked_at timestamptz;

-- ---------------------------------------------------------------------------
-- ghl_outbound_messages.sms_fallback
-- ---------------------------------------------------------------------------

-- Once per message: 'claimed' by the one pass that may send the fallback SMS
-- for this row (conditional on it being unclaimed and unreported), then
-- 'sent' or 'failed'. A later pass that retries the status report reads it,
-- so it reports the right reason and never sends a second SMS.
alter table public.ghl_outbound_messages
  add column if not exists sms_fallback text
    check (sms_fallback is null or sms_fallback in ('claimed', 'sent', 'failed'));

-- ---------------------------------------------------------------------------
-- ghl_sms_fallback_echoes
-- ---------------------------------------------------------------------------

-- A fallback SMS we just asked GoHighLevel to send, for 10 minutes, so the
-- provider webhook can recognise it if GoHighLevel hands it back to us. Only
-- the sha256 of the text is stored, never the text.
create table public.ghl_sms_fallback_echoes (
  location_id text not null references public.ghl_accounts (location_id) on delete cascade,
  contact_id  text not null,
  text_sha256 text not null,
  expires_at  timestamptz not null,
  primary key (location_id, contact_id, text_sha256)
);

comment on table public.ghl_sms_fallback_echoes is
  'GHL provider — pending echoes of fallback SMS sends (sha256 of the text only), valid until expires_at. Consumed by the provider webhook loop guard. RLS: no policies — service-role only.';

alter table public.ghl_sms_fallback_echoes enable row level security;
-- NO policies, deliberately. Service-role only.
