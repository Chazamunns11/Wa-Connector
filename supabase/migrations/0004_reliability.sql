-- 0004_reliability.sql — go-live gates (a) held messages and (b) STOP opt-outs.
--
-- (a) ghl_outbound_messages.send_state gains 'held': the number is
--     disconnected, so GoHighLevel's message is kept (with its pending_text)
--     and released in order when the number reconnects, or failed honestly
--     after the maximum hold. 0070's rule "pending_text is cleared the
--     instant the row leaves pending_send" now reads "cleared when leaving
--     pending_send/held": a held row keeps its pending_text.
--
-- (b) whatsapp_opt_outs records a contact who replied STOP. It is per
--     (tenant_id, phone), i.e. per number (ruling W10): other numbers in the
--     same account are unaffected. opted_out_at defaults to now(); keyword is
--     the canonical matched word (STOP, UNSUBSCRIBE, ...), not the raw text.
--     RLS enabled with no policies: service-role only.

alter table public.ghl_outbound_messages drop constraint ghl_outbound_messages_send_state_check;
alter table public.ghl_outbound_messages
  add constraint ghl_outbound_messages_send_state_check
  check (send_state in ('pending_send', 'held', 'accepted', 'refused'));

create index ghl_outbound_held_idx on public.ghl_outbound_messages (tenant_id, created_at)
  where send_state = 'held';

comment on column public.ghl_outbound_messages.pending_text is
  'The exact text last built for this row (src/lib/ghl.ts buildOutboundText), populated ONLY while send_state is ''pending_send'' or ''held'' and cleared to null the instant the row leaves those states. Exists so a bridge-unreachable send, or a held release, resends the SAME text under the SAME idempotency key.';

create table public.whatsapp_opt_outs (
  tenant_id       uuid not null references public.whatsapp_tenants (id) on delete cascade,
  phone           text not null
                    check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  opted_out_at    timestamptz not null default now(),
  keyword         text not null check (char_length(keyword) <= 16),
  ghl_contact_id  text,
  primary key (tenant_id, phone)
);

comment on table public.whatsapp_opt_outs is
  'Contacts who replied STOP (or another opt-out keyword) to a specific number. Keyed (tenant_id, phone) so an opt-out applies to one number only (W10). Removed when the contact replies START. RLS: no policies, service-role only.';

alter table public.whatsapp_opt_outs enable row level security;
