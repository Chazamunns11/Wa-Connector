# Workflow triggers and AI replies: sandbox check

17 Oct 2026. Run on a sandbox sub-account with LC Premium Triggers & Actions on, after the new app version from `docs/GHL-WORKFLOW-TRIGGERS-SETUP.md` is installed. `GHL_WORKFLOW_TRIGGERS_ENABLED` starts off.

Nothing in the build has been run against real GHL. Three things are unverified: how `targetUrl` is called (method, auth, `Version` header), whether `services.leadconnectorhq.com` is the only host, and whether Conversation AI replies through a custom provider.

## A. Subscriptions (flag off)

For each of the six keys:
- [ ] Add the trigger to a workflow and save. A row appears in `ghl_workflow_trigger_subscriptions` with the right `location_id`, `trigger_key` and a normalised https `target_url`.
- [ ] Edit the workflow: the row updates, not duplicates.
- [ ] Remove the trigger or delete the workflow: the row goes.
- [ ] Record the `target_url` host. If it is not `services.leadconnectorhq.com` or a subdomain, the route refuses it (400). Widen the allow-list in `src/lib/ghl-trigger-keys.ts` only if the sandbox shows another host.
- [ ] With the flag off, confirm no call is made to any `targetUrl`.

## B. Firing (flag on)

Set `GHL_WORKFLOW_TRIGGERS_ENABLED=true`. For each, confirm the workflow starts and the payload fields match the portal sample:
- [ ] `whatsapp_message_received`: send a WhatsApp text to the number; then a voice note (`voice_note`), an image.
- [ ] `whatsapp_missed_call`: ring the number and let it go unanswered, voice and video.
- [ ] `whatsapp_message_read`: send from GHL, read on the phone.
- [ ] `whatsapp_not_on_whatsapp`: send to a number not on WhatsApp. The trigger carries the text. A second send fails fast (30-day memory). Then message us from that number: the memory clears.
- [ ] `whatsapp_disconnected`: take the phone offline 5+ minutes; one alert. Then log the linked device out: an alert at once with `logged_out`. `reconnectUrl` opens the connect page. Check the alert's description warns it is internal.
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
