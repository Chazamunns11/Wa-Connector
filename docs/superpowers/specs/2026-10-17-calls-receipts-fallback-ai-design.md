# Missed calls, read receipts, SMS fallback and AI replies: design

17 Oct 2026. Covers items 5–8 of the "frequently asked for" list in the go-to-market plan. Draft for Charlie's review. Items 1–4 have their own specs:

| # | Feature | Spec |
|---|---|---|
| 1 | Voice notes | `2026-10-17-voice-notes-and-message-events-design.md` |
| 2 | Create and manage groups | `2026-10-17-group-creation-and-management-design.md` |
| 3 | WhatsApp triggers in workflows | `2026-10-17-ghl-workflow-triggers-actions-design.md` |
| 4 | Edits, quoted replies, reactions | `2026-10-17-voice-notes-and-message-events-design.md` |
| 5 | Missed-call text-back | this file. Logging built without triggers, pending the real-device check |
| 6 | SMS fallback | this file |
| 7 | AI replies | this file |
| 8 | Read receipts | this file. Built without triggers, pending the real-device check |

Items 5, 6 and 8 lean on item 3 (custom triggers). Each section says what works without it.

## 5. Missed-call text-back

**What the user gets.** Someone rings the coach's WhatsApp number and nobody answers. GHL logs "Missed WhatsApp call" in the contact's conversation, and a workflow can text them straight back ("Sorry I missed you, when's a good time?").

**How.**
- The bridge subscribes to Baileys' `call` event. Each call goes through `offer` / `ringing` and ends in `accept`, `reject`, `timeout` or `terminate`. A call is **missed** when it ends without an `accept` from any of the number's devices. Group calls (`isGroup`) and calls from our own number are ignored.
- The bridge never answers or rejects a call: the phone keeps ringing as normal. It only observes.
- Missed calls are written as an inbound row with a new `event_kind = 'missed_call'` (the column comes from the item 4 spec) and `body = null`. They go through the same sender resolution (PN or confirmed LID only) and the same drain as messages.
- The app posts them to GHL as an inbound message, `📞 Missed WhatsApp call` (voice) or `📞 Missed WhatsApp video call`. Posting as an inbound message is deliberate here: it is a contact reaching out, so "Customer replied" workflows firing is the point.
- With item 3: a `whatsapp_missed_call` trigger carrying `number`, `numberLabel`, `isVideo` and `contactId`, so the text-back workflow can filter on it.
- Without item 3: the "Customer replied" trigger fires on the posted message, and a workflow condition on the message body containing `📞 Missed` does the same job. Use "contains", not "starts with": on a location with more than one number the body carries a number label first (`[Sales] 📞 Missed WhatsApp call`).

**Guardrails.** A per-caller limit of one missed-call post per 10 minutes, so a caller ringing five times doesn't create five messages or five text-backs. A missed call more than 6 hours old when the app's drain reaches it (for example after a long outage and a reconnect) is not posted; it is closed with the resolution `missed_call_stale`, so nobody gets a text-back hours late. A missed call never counts as the contact having messaged the number, so it does not make them eligible for a direct group add.

**Fixed strings:** `📞 Missed WhatsApp call`, `📞 Missed WhatsApp video call`.

## 6. SMS fallback

**What the user gets.** If a contact isn't on WhatsApp, the message goes by SMS instead, automatically, so a follow-up never silently dies.

**How.** The bridge already knows when a number isn't on WhatsApp: the existence check records `not_on_whatsapp`, and the app reports it to GHL as a failed message. Two ways to fall back:

- **A. GHL workflow branch (no new sending code, recommended first).** With item 3, a `whatsapp_not_on_whatsapp` trigger carrying `contactId` and the original message's text. The agency's workflow sends it by GHL's own SMS (LC Phone or Twilio) and can tag the contact `no-whatsapp`. Without item 3, the same is done with GHL's "message failed" condition where available (confirm in the sandbox).
- **B. Built-in fallback (later, opt-in per sub-account).** On `not_on_whatsapp`, the app sends the text through GHL's Conversations API as an SMS on the sub-account's own SMS provider. This means one GHL API call, and the cost stays on the customer's SMS account, not ours. It needs a setting ("Send by SMS when a contact isn't on WhatsApp"), off by default, because SMS costs money and some coaches won't want it.

**Remember the answer.** Store `not_on_whatsapp` per (location, phone) for 30 days, so the next message skips the WhatsApp check and goes straight to fallback. Clear it when that contact messages us on WhatsApp.

**STOP still wins.** A contact who opted out gets neither WhatsApp nor the SMS fallback.

## 7. AI replies

**Decision: don't build our own bot.** GHL's AI agents (Conversation AI) already reply in Conversations on the channel the message came in on. Because PingWren is a Conversation Provider, an AI reply should go out over WhatsApp through our normal send path, with pacing, typing, held messages and STOP all applying.

**Work: test and document, not build.**
1. In a sandbox sub-account, turn on Conversation AI for the WhatsApp/SMS channel PingWren provides.
2. Message the number and check: does the AI reply arrive by WhatsApp? Does it respect our pacing? Does it reply to group messages? (It must not; if it does, the setup doc tells users to exclude the `whatsapp-group` tag.)
3. Write a setup guide page on the website ("AI replies on WhatsApp with GHL's Conversation AI") and a YouTube walkthrough.

**If the sandbox shows a gap** (for example, GHL's AI doesn't use custom providers), spec a bridge to it then. Don't guess now.

## 8. Read receipts

**What the user gets.** GHL shows a sent WhatsApp message as **delivered** and then **read**, like the blue ticks on the phone. A workflow can act on "read but no reply after 24 hours".

**How.**
- The bridge subscribes to `messages.update` only, for our own sent one-to-one messages (`fromMe`), and maps WhatsApp's acks to `delivered` and `read`. It does not use `message-receipt.update` (that is where Baileys sends group receipts, which we don't track).
- `whatsapp_messages` gains `delivered_at` and `read_at`, set once and never moved backwards.
- The app's outbound status drain already reports to GHL. It adds `delivered`, then `read`, through GHL's message status update, if GHL's provider status API accepts those values (the drain uses it today for `delivered` and `failed`; confirm `read` in the sandbox).
- With item 3: a `whatsapp_message_read` trigger carrying `contactId` and `messageId`, for "read, no reply" workflows.
- Group messages: no receipts at all. Baileys sends group receipts through a different event, and per-member read tracking would be noisy anyway.

**Privacy.** If the contact has read receipts turned off on WhatsApp, we get no read ack. The UI never claims "not read", only "delivered".

## Build status (17 Oct)

Items 5 (missed-call logging) and 8 (read receipts) are built without triggers, behind flags that are off by default. They stay off until the checks in `2026-10-17-calls-receipts-real-device-check.md` pass. Plan: `docs/superpowers/plans/2026-10-17-missed-calls-and-read-receipts.md`.

Items 6 (SMS fallback) and 7 (AI replies) were built on 17 Oct, pending the sandbox:

- **SMS fallback, option A: built.** The `whatsapp_not_on_whatsapp` trigger carries the contact and the unsent text, and "not on WhatsApp" is remembered for 30 days per (location, phone), cleared when that phone messages us one-to-one. STOP still wins. Workflow setup: `docs/GHL-WORKFLOW-TRIGGERS-SETUP.md`.
- **SMS fallback, option B (automatic SMS): built 17 Oct**, after Charlie's answer: "Text should send as replacement if not on WA". The setting ("Send as SMS when a contact isn't on WhatsApp") is on unless a sub-account turns it off, behind the global `GHL_SMS_FALLBACK_ENABLED` (off) until the sandbox check's section D shows which provider sends the SMS. When the SMS is sent, the `whatsapp_not_on_whatsapp` trigger is not fired. A loop guard refuses our own SMS if GHL hands it back to PingWren (PingWren is the sub-account's SMS provider) and turns the fallback off for that sub-account. At most one fallback SMS per contact per 10 minutes. Known limit: until GHL's send returns a message id, the guard matches on the text, so the same text sent to the same contact by hand in that window is treated as the echo, refused, and turns the fallback off. Plan: `docs/superpowers/plans/2026-10-17-sms-fallback-b.md`.
- **AI replies: documented, not built.** Website guide at `/docs/ai-replies`. Pending the live check in `2026-10-17-workflow-triggers-sandbox-check.md` section C.
- The trigger halves of items 5 (missed call) and 8 (read) are built as `whatsapp_missed_call` and `whatsapp_message_read`, pending the same sandbox check.

## Build order

1. **Voice notes** (item 1): small and visible.
2. **Group management** (item 2): spec answered, sandbox script ready.
3. **Missed-call logging** (5, without triggers): small, and every rival has calls.
4. **Read receipts to GHL** (8, without triggers): small, and shows in the GHL inbox.
5. **WhatsApp triggers** (3): after a sandbox test of firing triggers. This unlocks the trigger halves of 5, 6 and 8.
6. **Edits, quoted replies, reactions** (4).
7. **SMS fallback A** (6), then **B** if customers ask.
8. **AI replies** (7): the sandbox test can run any time and costs nothing to build.

## Open questions

1. Does GHL's message status API accept `read`? (Sandbox.)
2. Does GHL's Conversation AI reply through a custom Conversation Provider? (Sandbox.)
3. For the built-in SMS fallback (6B), is per-message SMS cost on the customer's own account acceptable, or should it stay workflow-only? **Answered 17 Oct:** send automatically, on the customer's own SMS provider (built as option B).
4. Should missed-call text-back come with a ready-made workflow template we publish (a GHL snapshot)?
