# Workflow triggers and AI replies: sandbox check

17 Oct 2026. Run on a sandbox sub-account with LC Premium Triggers & Actions on, after the new app version from `docs/GHL-WORKFLOW-TRIGGERS-SETUP.md` is installed.

Before you start: `workflows.readonly` is enabled in the portal, `GHL_REQUEST_WORKFLOWS_SCOPE=true` is set, and the sandbox install has been re-authorised (so its token carries the scope). `GHL_WORKFLOW_TRIGGERS_ENABLED` starts off, and is only set after section A passes.

Nothing in the build has been run against real GHL. Three things are unverified: how `targetUrl` is called (method, auth, `Version` header), whether `services.leadconnectorhq.com` is the only host, and whether Conversation AI replies through a custom provider.

## A. Subscriptions (flag off)

For each of the six keys:
- [ ] Add the trigger to a workflow and save. A row appears in `ghl_workflow_trigger_subscriptions` with the right `location_id`, `trigger_key` and a normalised https `target_url`.
- [ ] Edit the workflow: the row updates, not duplicates.
- [ ] Remove the trigger or delete the workflow: the row goes.
- [ ] Record the `target_url` host. If it is not `services.leadconnectorhq.com` or a subdomain, the route refuses it (400). Widen the allow-list in `src/lib/ghl-trigger-keys.ts` only if the sandbox shows another host.
- [ ] With the flag off, confirm no call is made to any `targetUrl`.

## B. Firing (flag on)

Only after section A passes, set `GHL_WORKFLOW_TRIGGERS_ENABLED=true`. For each, confirm the workflow starts and the payload fields match the portal sample:
- [ ] `whatsapp_message_received`: send a WhatsApp text to the number; then a voice note (`voice_note`), an image.
- [ ] `whatsapp_missed_call`: ring the number and let it go unanswered, voice and video.
- [ ] `whatsapp_message_read`: needs `GHL_READ_RECEIPTS_ENABLED=true` and the bridge's `WA_READ_RECEIPTS_ENABLED=true`. Send from GHL, read on the phone, then wait for (or run) the hourly cron: it fires from there.
- [ ] `whatsapp_not_on_whatsapp`: send to a number not on WhatsApp. The trigger carries the text. A second send fails fast (30-day memory). Then message us from that number: the memory clears. An attachment-only send fires with an empty `message`.
- [ ] `whatsapp_disconnected`: stop the number's bridge session for 5+ minutes; one alert. (Taking the phone offline does not drop a linked device, so it fires nothing.) Then log the linked device out: an alert at once with `logged_out`. `reconnectUrl` opens the connect page. Check the alert's description warns it is internal.
- [ ] `whatsapp_reconnected`: bring it back; one alert with `downMinutes`.
- [ ] A 2 minute blip fires nothing.

If the fire fails (check the fixed error line and HTTP status in the logs), `postTriggerEvent` in `src/lib/ghl-triggers.ts` is the one function to change. Record the working method here:

> Working method: _to fill in_

## C. AI replies (calls spec section 7)

- [ ] Turn on Conversation AI for the sub-account's WhatsApp channel and message the number. Does the AI reply arrive by WhatsApp?
- [ ] Does the reply go through PingWren's sending, with pacing and typing? Send several messages quickly.
- [ ] Does the AI reply in a group? It must not. Exclude the `whatsapp-group` tag and re-test.
- [ ] A contact who sent STOP gets no AI reply.

If the AI does not use custom providers, spec a bridge then; do not guess now. Update `src/app/(site)/docs/ai-replies/page.tsx` with the result.

## D. SMS fallback B (calls spec section 6)

Only after migration 0014. Set `GHL_SMS_FALLBACK_ENABLED=true` and leave the sub-account's "Send as SMS when a contact isn't on WhatsApp" switch on.
- [ ] Send from GHL to a number not on WhatsApp. Record which provider sends the SMS (LC Phone, Twilio, or PingWren itself), and that the contact gets the same text once. GHL shows the original as failed with `Not on WhatsApp — sent as SMS instead`. `whatsapp_not_on_whatsapp` does not fire.
- [ ] Send again (the 30-day memory refuses it at once): one SMS, same reason.
- [ ] A message with an attachment and text: the SMS carries the text only. Attachment only: no SMS, and the trigger fires.
- [ ] A contact who sent STOP: nothing, and no trigger.
- [ ] On a sub-account whose SMS provider is PingWren: if GHL hands the SMS back to PingWren, it is refused with `This sub-account sends SMS through PingWren, so the SMS fallback can't be used — not sent`, nothing goes out on WhatsApp, and the embed shows the setting off with the "Turned off: this sub-account's SMS goes through PingWren…" notice. The next not-on-WhatsApp send gets no SMS and fires the trigger. Switching the setting back on clears the notice.
- [ ] If the SMS call itself is refused, `sendGhlSms` in `src/lib/ghl.ts` is the one function to change. Record the working call here:

> Working call: _to fill in_
