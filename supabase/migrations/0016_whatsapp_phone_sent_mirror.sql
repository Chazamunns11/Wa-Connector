-- ---------------------------------------------------------------------------
-- PHONE-SENT MIRROR — show BOTH sides of a WhatsApp conversation in GHL.
--
-- THE GAP THIS CLOSES: a GHL conversation used to show the client's replies
-- (pushed by `src/lib/ghl-inbound.ts`) and whatever GHL itself sent (GHL
-- creates those messages before our provider delivers them), but never a
-- message the business typed on the connected phone, WhatsApp Web, or any
-- other linked device. The bridge dropped every `fromMe` message outright
-- (services/whatsapp-bridge/src/inbound.ts, filter step 2), so half the
-- conversation never reached GHL.
--
-- WHAT CHANGES: with `WA_MIRROR_PHONE_SENT_ENABLED` on, the bridge records a
-- session's phone-sent 1:1 messages in this same table with
-- `direction = 'outbound'`, and the GHL drain posts them to the contact's
-- conversation as outbound messages (`POST /conversations/messages/inbound`
-- with `direction: "outbound"`). On an outbound row `from_phone` holds the
-- CONTACT's number (the recipient), so every existing per-contact index and
-- fence keeps working unchanged.
--
-- WHY THIS TABLE AND NOT A NEW ONE: the drain's claim / bounded retry /
-- at-most-once / 90-day purge machinery is exactly what an outbound mirror
-- needs too. The readers that mean "the contact messaged us" filter
-- `direction = 'inbound'` (`hasInboundFromPhone`, bridge and portal), and the
-- drain gives outbound rows their own path (no STOP/START keyword check, no
-- workflow trigger, no number stickiness).
--
-- `ghl_message_id`: the id GHL returns when an outbound row is posted. The
-- provider webhook (`handleProviderOutboundMessage`) refuses to deliver a
-- message whose id matches one, so a mirrored message can never be sent to
-- the client a second time should GHL ever echo it to the Delivery URL.
--
-- Apply this before deploying the code that reads `direction` (the portal
-- selects it and `hasInboundFromPhone` filters on it), and before turning
-- `WA_MIRROR_PHONE_SENT_ENABLED` on.
-- ---------------------------------------------------------------------------

alter table public.whatsapp_inbound_messages
  add column if not exists direction text not null default 'inbound',
  add column if not exists ghl_message_id text;

alter table public.whatsapp_inbound_messages
  drop constraint if exists whatsapp_inbound_direction_check;
alter table public.whatsapp_inbound_messages
  add constraint whatsapp_inbound_direction_check check (direction in ('inbound', 'outbound'));

comment on column public.whatsapp_inbound_messages.direction is
  '''inbound'' = a client''s message to the business (every row before 0016). ''outbound'' = a message the business sent from the connected phone (GHL-location tenants only, WA_MIRROR_PHONE_SENT_ENABLED); from_phone then holds the CONTACT''s number.';

comment on column public.whatsapp_inbound_messages.ghl_message_id is
  'Outbound rows only: the GHL message id returned when the row was posted to the conversation. The provider webhook refuses to deliver a message with this id (echo guard).';

create index if not exists whatsapp_inbound_ghl_message_idx
  on public.whatsapp_inbound_messages (ghl_message_id)
  where ghl_message_id is not null;

-- The drain's own-send check (`wasWhatsappMessageSentByBridge`) looks a
-- phone-sent row up by the WhatsApp message id the bridge recorded on send.
create index if not exists whatsapp_messages_coach_wa_message_idx
  on public.whatsapp_messages (coach_id, wa_message_id)
  where wa_message_id is not null;
