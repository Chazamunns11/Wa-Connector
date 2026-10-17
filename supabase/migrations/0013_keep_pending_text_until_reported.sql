-- pending_text now lives until the row's status is reported to GoHighLevel
-- (delivered or failed), not only until it leaves pending_send/held. A
-- "not on WhatsApp" workflow trigger carries the unsent text, so SMS fallback
-- needs it. It is still cleared on refusal and when reported, and never logged.
--
-- Comment only; no schema change. Safe to apply before or after the deploy.

comment on column public.ghl_outbound_messages.pending_text is
  'The exact text last built for this row (src/lib/ghl.ts buildOutboundText). Populated while send_state is ''pending_send'', ''held'' or ''accepted''; cleared to null when the row is refused and when its status is reported to GHL (reported_status set). Exists so a bridge-unreachable send or a held release resends the SAME text under the SAME idempotency key, and so a not-on-WhatsApp trigger can carry the unsent text. Never logged.';
