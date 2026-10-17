# GHL developer portal: WhatsApp workflow triggers

A checklist for Charlie. Do this in the GHL developer portal, in the PingWren app under **Modules → Workflow → Triggers**. Spec: `docs/superpowers/specs/2026-10-17-ghl-workflow-triggers-actions-design.md`.

Changes to Modules ship as a new app version and go through GHL review. Do all six triggers in one version.

## Before you start

- [ ] Migrations 0001 to 0013 are applied (they apply cleanly on Postgres 16).
- [ ] `GHL_WORKFLOW_WEBHOOK_SECRET` is set on Vercel to a long random value. Without it the subscription route answers 503. Keep a copy: you paste the same value into the portal below.
- [ ] `GHL_WORKFLOW_TRIGGERS_ENABLED` stays unset (off) until the sandbox check passes. With it off, subscriptions are stored but nothing is ever sent to GHL.
- [ ] Scopes (Advanced Settings → Auth): add `workflows.readonly` to the six already ticked. Do this **before** setting `GHL_WORKFLOW_TRIGGERS_ENABLED=true`: the app only asks for the scope once that flag is on, and asking for a scope the portal hasn't enabled breaks the install. Existing installs must re-authorise to pick it up.

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
- Description: `Fires when a WhatsApp number has been offline for 5 minutes, or at once if it is logged out or banned. Includes a link to reconnect it. For internal alerts only. Never send this link to a contact.`

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

`message` is the unsent text, cut to 500 characters. It can be empty for messages sent before migration 0013.

## After you submit

- [ ] Install the new version on the sandbox sub-account, turn on LC Premium Triggers & Actions, then run `docs/superpowers/specs/2026-10-17-workflow-triggers-sandbox-check.md`.
- [ ] Only after that check, set `GHL_WORKFLOW_TRIGGERS_ENABLED=true` on Vercel.
