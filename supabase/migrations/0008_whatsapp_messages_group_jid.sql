-- Group sends in the send ledger (whatsapp_messages).
--
-- WHY: a send to an opted-in WhatsApp group (0007's whatsapp_groups) has no
-- phone number, and `to_phone` carries a strict E.164 CHECK. So `to_phone`
-- becomes nullable and the row records the group in a new `group_jid`
-- column instead, with the same jid CHECK as whatsapp_groups.group_jid. A
-- second CHECK keeps every row honest: exactly one of the two is set, so a
-- ledger row can never name both targets, or neither.
--
-- Additive for existing rows: every row written so far has `to_phone` set and
-- no `group_jid`, which satisfies both CHECKs as is.
--
-- Deploy order: apply BEFORE the bridge build that writes group sends.

alter table public.whatsapp_messages
  alter column to_phone drop not null;

alter table public.whatsapp_messages
  add column group_jid text
    constraint whatsapp_messages_group_jid_format check (
      group_jid is null or group_jid ~ '^[0-9]+(-[0-9]+)?@g\.us$'
    );

alter table public.whatsapp_messages
  add constraint whatsapp_messages_one_target check (
    (to_phone is null) <> (group_jid is null)
  );

comment on column public.whatsapp_messages.group_jid is
  'NULL for a one-to-one send (to_phone set). For a send to an opted-in WhatsApp group, the group''s jid (whatsapp_groups.group_jid) and to_phone is NULL. Exactly one of the two is set (whatsapp_messages_one_target). A group send counts 5 daily-cap units at the bridge.';
