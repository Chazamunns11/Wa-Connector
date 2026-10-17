# GHL developer portal: WhatsApp workflow triggers

A checklist for Charlie. Do this in the GHL developer portal, in the PingWren app under **Modules → Workflow → Triggers**. Spec: `docs/superpowers/specs/2026-10-17-ghl-workflow-triggers-actions-design.md`.

Changes to Modules ship as a new app version and go through GHL review. Do all six triggers in one version.

## Before you start

- [ ] Migrations 0001 to 0013 are applied (they apply cleanly on Postgres 16).
- [ ] `GHL_WORKFLOW_WEBHOOK_SECRET` is set on Vercel to a long random value. Without it the subscription route answers 503. Keep a copy: you paste the same value into the portal below.
- [ ] `GHL_WORKFLOW_TRIGGERS_ENABLED` stays unset (off) until the sandbox check passes. With it off, subscriptions are stored but nothing is ever sent to GHL.

## Turning it on, in this order

The scope and the firing flag are two separate settings. The scope has to be granted first, because firing needs it, and the app must not ask for a scope the portal hasn't enabled (that breaks the install).

1. [ ] In the portal (Advanced Settings → Auth), add `workflows.readonly` to the six scopes already ticked.
2. [ ] On Vercel, set `GHL_REQUEST_WORKFLOWS_SCOPE=true`. From then on the install asks for `workflows.readonly`. It does not turn firing on.
3. [ ] Re-authorise each existing install (new installs get the scope at once).
4. [ ] Run the sandbox check, section A (subscriptions, firing flag still off): `docs/superpowers/specs/2026-10-17-workflow-triggers-sandbox-check.md`.
5. [ ] Only then set `GHL_WORKFLOW_TRIGGERS_ENABLED=true` and run section B.

## What it costs the customer

- Every trigger execution costs the customer **$0.01**, charged by GHL.
- The sub-account needs **LC Premium Triggers & Actions** turned on, or the triggers do not appear in its workflow builder.
- Agencies can rebill it. Say so in the app listing.

## Subscription URL and header (same for all six triggers)

- Subscription URL: `https://<app domain>/api/webhooks/ghl-trigger-subscription`
- Static header: name `X-PingWren-Secret`, value = the value of `GHL_WORKFLOW_WEBHOOK_SECRET`.

Notes: GHL calls this URL when a workflow adds, updates or removes one of our triggers. We only accept a `targetUrl` whose host is `services.leadconnectorhq.com` or a subdomain of it, over https, with no port or userinfo. Any other host is refused (400).

## The six triggers

Keys are immutable once the version is published. Type them exactly. The sample JSON drives GHL's filter builder, so paste it as written.

### 1. `whatsapp_disconnected`

- Name: WhatsApp disconnected
- Description: `Fires when PingWren's connection to a WhatsApp number has been down for 5 minutes, or at once if it is logged out or banned. Includes a link to reconnect it. For internal alerts only. Never send this link to a contact.`

```json
{
  "number": "+447700900123",
  "numberLabel": "Sales line",
  "reason": "connection_lost",
  "heldMessages": 3,
  "reconnectUrl": "https://app.example.com/connect/abc123"
}
```

`reason` is `logged_out`, `banned` or `connection_lost`. `numberLabel` can be null.

"Down" means PingWren's own connection to the number (the linked device) has been down for 5 minutes. A phone that is switched off or offline does not drop a linked device, so it does not fire this. To test it, stop the number's bridge session.

### 2. `whatsapp_reconnected`

- Name: WhatsApp reconnected
- Description: `Fires once when a number that sent a disconnected alert is back online. Includes how long it was down.`

```json
{
  "number": "+447700900123",
  "numberLabel": "Sales line",
  "downMinutes": 42
}
```

### 3. `whatsapp_message_received`

- Name: WhatsApp message received
- Description: `Fires when a one-to-one WhatsApp message reaches the contact's conversation. Carries the number and message type so you can filter by either. The message text is not included.`

```json
{
  "number": "+447700900123",
  "numberLabel": "Sales line",
  "messageType": "voice_note",
  "contactId": "9NkB3sQw2TjYxPz7LmAe"
}
```

`messageType` is `text`, `voice_note`, `image`, `video`, `document` or `other`. Group messages, reactions, edits, deletes and STOP/START keyword messages do not fire it.

### 4. `whatsapp_missed_call`

- Name: WhatsApp missed call
- Description: `Fires when someone rings the WhatsApp number and nobody answers. Use it for a text-back.`

```json
{
  "number": "+447700900123",
  "numberLabel": "Sales line",
  "isVideo": false,
  "contactId": "9NkB3sQw2TjYxPz7LmAe"
}
```

### 5. `whatsapp_message_read`

- Name: WhatsApp message read
- Description: `Fires when a contact reads a message sent from GHL. Use it for read-but-no-reply follow-ups. Does not fire if the contact has read receipts switched off.`

```json
{
  "number": "+447700900123",
  "numberLabel": "Sales line",
  "contactId": "9NkB3sQw2TjYxPz7LmAe",
  "messageId": "Tq4Hn8VdRz1CwXy0KsJb"
}
```

`messageId` is GHL's message id.

It only fires when read receipts are on: `GHL_READ_RECEIPTS_ENABLED=true` (Vercel) and `WA_READ_RECEIPTS_ENABLED=true` (bridge). It fires from the hourly cron, so it can arrive up to an hour after the contact read the message.

### 6. `whatsapp_not_on_whatsapp`

- Name: Contact not on WhatsApp
- Description: `Fires when a message could not be sent because the contact's number is not on WhatsApp. Carries the unsent text so a workflow can send it by SMS instead. Not fired for contacts who have sent STOP.`

```json
{
  "number": "+447700900123",
  "numberLabel": "Sales line",
  "contactId": "9NkB3sQw2TjYxPz7LmAe",
  "message": "Hi Sam, are you free for a quick call tomorrow at 10?"
}
```

`message` is the unsent text, cut to 500 characters. It can be empty: for an attachment-only send (no text), for a message whose kept text was cleared because it was not reported within 7 days, for a message accepted while both `GHL_WORKFLOW_TRIGGERS_ENABLED` and `GHL_SMS_FALLBACK_ENABLED` were off (the text is only kept while one of them is on), and for messages sent before migration 0013.

Not fired when PingWren's own SMS fallback sent the text as an SMS (`GHL_SMS_FALLBACK_ENABLED=true` and the sub-account's "Send as SMS when a contact isn't on WhatsApp" switch on), so a workflow doesn't send a second SMS. GHL then shows the message as failed with `Not on WhatsApp — sent as SMS instead`. When the fallback is off, switched off, blocked by the loop guard, or the SMS call failed, the trigger fires as above. See "SMS fallback (GHL)" in `docs/GO-LIVE-FOUNDATION.md`.

### The 30-day "not on WhatsApp" memory

When a send fails because the contact is not on WhatsApp, PingWren remembers that contact (per sub-account and phone number) for 30 days, and refuses further sends to them at once, without trying WhatsApp.

- The memory is used even while `GHL_WORKFLOW_TRIGGERS_ENABLED` is off. The flag only controls whether the trigger fires.
- A contact who joins WhatsApp later stays refused until they message the number (any one-to-one message clears the memory) or the 30 days pass.
- A contact who sent STOP never gets the fallback trigger.

## After you submit

- [ ] Install the new version on the sandbox sub-account and turn on LC Premium Triggers & Actions.
- [ ] Follow "Turning it on, in this order" above: scope in the portal, `GHL_REQUEST_WORKFLOWS_SCOPE=true`, re-authorise, sandbox check section A, then `GHL_WORKFLOW_TRIGGERS_ENABLED=true` on Vercel and section B.
