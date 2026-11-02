-- ---------------------------------------------------------------------------
-- PER-USER SENDING NUMBER — a setter's replies go out from the setter's number.
--
-- HighLevel's ProviderOutboundMessage webhook carries `userId` (the HighLevel
-- user who sent the message) and no "from" number
-- (marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage), so the
-- provider has to map user -> number itself. One row = "this user's replies
-- in this sub-account go from this number". Set by the user themselves from
-- the PingWren page inside HighLevel (the embed knows who is looking at it).
--
-- Precedence on send (src/lib/sending-number.ts): this user's number, then
-- the contact's sticky number, then the default — the same order HighLevel
-- uses for its own numbers (user-assigned before last-used; help article
-- 48001152126). Messages with no userId, or a user with no row, are routed
-- exactly as before.
--
-- Cascades with the NUMBER (ghl_location_numbers), so removing a number
-- drops its user assignments and those users fall back to sticky/default.
-- ---------------------------------------------------------------------------

create table public.ghl_user_numbers (
  location_id  text not null references public.ghl_accounts (location_id) on delete cascade,
  ghl_user_id  text not null check (char_length(ghl_user_id) between 1 and 64),
  tenant_id    uuid not null references public.ghl_location_numbers (tenant_id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (location_id, ghl_user_id)
);

comment on table public.ghl_user_numbers is
  'GHL provider — which of a location''s WhatsApp numbers a HighLevel user''s replies go out from (setter seats). Beats the contact''s sticky number; absent = sticky/default routing. RLS: no policies — service-role only.';

create index ghl_user_numbers_tenant_idx on public.ghl_user_numbers (tenant_id);

alter table public.ghl_user_numbers enable row level security;
-- NO policies, deliberately. Service-role only.
