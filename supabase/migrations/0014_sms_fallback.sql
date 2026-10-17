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
-- so it reports the right reason and never sends a second SMS. The loop
-- guard sets 'failed' when GHL handed the SMS back to PingWren.
-- sms_fallback_claimed_at: when the claim was taken. A pass that finds a
-- claim younger than 2 minutes leaves the row to the pass that holds it; an
-- older claim (that pass died) reads as failed.
alter table public.ghl_outbound_messages
  add column if not exists sms_fallback text
    check (sms_fallback is null or sms_fallback in ('claimed', 'sent', 'failed')),
  add column if not exists sms_fallback_claimed_at timestamptz;

-- ---------------------------------------------------------------------------
-- ghl_sms_fallback_echoes
-- ---------------------------------------------------------------------------

-- The fallback SMS we last asked GoHighLevel to send to a contact, for 10
-- minutes. One row per (location, contact): it is also the cooldown (at most
-- one fallback SMS per contact per 10 minutes, a conditional insert), so a
-- missed echo costs one hop, never a loop. The provider webhook recognises the
-- SMS if GoHighLevel hands it back to us: by GHL's message id once the POST
-- has answered (ghl_message_id), else by the sha256 of the normalised text.
-- outbound_message_id is the original message, corrected when the echo comes
-- back. Only the hash is stored, never the text.
create table public.ghl_sms_fallback_echoes (
  location_id         text not null references public.ghl_accounts (location_id) on delete cascade,
  contact_id          text not null,
  text_sha256         text not null,
  outbound_message_id uuid not null references public.ghl_outbound_messages (id) on delete cascade,
  ghl_message_id      text,
  expires_at          timestamptz not null,
  primary key (location_id, contact_id)
);

comment on table public.ghl_sms_fallback_echoes is
  'GHL provider — the pending echo of the last fallback SMS per contact (sha256 of the normalised text, never the text; GHL''s message id once known), valid until expires_at. The SMS cooldown and the provider webhook loop guard. Expired rows are purged by the hourly cron. RLS: no policies — service-role only.';

create index ghl_sms_fallback_echoes_expires_idx on public.ghl_sms_fallback_echoes (expires_at);

alter table public.ghl_sms_fallback_echoes enable row level security;
-- NO policies, deliberately. Service-role only.
