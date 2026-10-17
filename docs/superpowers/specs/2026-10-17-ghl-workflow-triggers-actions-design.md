# WhatsApp triggers and actions in GHL workflows: design

17 Oct 2026. Roadmap item D (`docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`). Draft for Charlie's review.

**Build status (17 Oct):** built on branch `claude/eloquent-mccarthy-m60n6c`, migrations 0012 and 0013, firing behind `GHL_WORKFLOW_TRIGGERS_ENABLED` (off). Six triggers were built, not three: disconnected, reconnected, message received, missed call, message read and not on WhatsApp. Pending the sandbox check in `2026-10-17-workflow-triggers-sandbox-check.md`; how `targetUrl` is called is still unverified. Portal entries: `docs/GHL-WORKFLOW-TRIGGERS-SETUP.md`.

## What GHL's docs say (checked 17 Oct)

- **Configured in the developer portal** under the app's Modules → Workflow. Each trigger and action has an immutable key, a name, an icon and descriptions. Changes ship as a new app version that goes through GHL review ([custom actions](https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomActions), [custom triggers](https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomTriggers)).
- **Billing:** "Marketplace Workflow Actions/Triggers are part of LC Premium Triggers & Actions and are chargeable per execution", at **$0.01 per execution**, and the sub-account must have LC Premium Triggers & Actions turned on or they don't appear ([source](https://marketplace.gohighlevel.com/docs/marketplace-modules/WorkflowActionsAndTriggers)). The fee-waiver experiment is closed to new apps. Agencies can rebill it.
- **Action call:** GHL POSTs `{ data, extras: { locationId, contactId, workflowId }, meta: { key, version } }` to our "Send Data URL". The only documented auth is static headers we define. Signing, timeouts and retries for action calls are not documented.
- **Trigger subscription:** when a workflow adds, updates or removes our trigger, GHL POSTs `{ triggerData: { id, key, filters, eventType: CREATED|UPDATED|DELETED, targetUrl }, extras: { locationId, workflowId, companyId } }` to our Subscription URL. We store `targetUrl` and fire events to it. **How to call `targetUrl` (method, auth, body) is not documented.** Workflows can run "contactless".
- Scope: `workflows.readonly` must be on.

## The decision this forces

Because every custom execution costs the customer $0.01 and needs LC Premium, the **"Send SMS" step stays the main way to send WhatsApp**. It's free, it works on every plan, and it's what PingWren's provider already handles. A custom "Send WhatsApp" action would only duplicate it at a cost, so it waits until it can do something "Send SMS" can't: choose a specific number (item B), or send to a group (item E).

What GHL can't do without us is react to **WhatsApp-specific events**. Those are the triggers worth building:

| Trigger (key) | Fires when | Contact? | Why it's worth $0.01 |
|---|---|---|---|
| **WhatsApp disconnected** (`whatsapp_disconnected`) | A number's session closes and doesn't recover within 5 minutes, or is logged out or banned | Contactless | Agencies can alert their own staff or client. GoGHL has it; nothing in GHL does this natively |
| **WhatsApp reconnected** (`whatsapp_reconnected`) | A disconnected number comes back | Contactless | Closes the loop on the alert |
| **WhatsApp message received** (`whatsapp_message_received`) | An inbound WhatsApp message is pushed to GHL | Contact | GHL's "Customer replied" already fires, but can't filter by channel or number. This one carries the number and message type (text, voice note, image) for filtering |

Missed-call triggers wait: the bridge doesn't handle call events yet.

**Trigger payloads** (also the sample JSON in the portal, which drives GHL's filters):
- `whatsapp_disconnected`: `{ "number": "+447700900123", "numberLabel": "Sales line", "reason": "logged_out" | "banned" | "connection_lost", "heldMessages": 3, "reconnectUrl": "https://app.pingwren.com/connect/…" }`
- `whatsapp_reconnected`: `{ "number": "+447700900123", "numberLabel": "Sales line", "downMinutes": 42 }`
- `whatsapp_message_received`: `{ "number": "+447700900123", "numberLabel": "Sales line", "messageType": "text" | "voice_note" | "image" | "video" | "document", "contactId": "…" }`. The message text is not included; it's already in the conversation.

`reason` is always one of the fixed values. `reconnectUrl` is a freshly signed connect link (`src/lib/ghl-connect-link.ts`), so the alert can carry a one-tap fix. That link is a bearer credential, so the trigger's description must say it is only for internal alerts, never to send to a contact.

## Data (new migration)

`ghl_workflow_trigger_subscriptions`: `id` (GHL's `triggerData.id`), `location_id` references `ghl_accounts`, `workflow_id`, `trigger_key`, `target_url`, `filters jsonb`, `created_at`, `updated_at`. CREATED and UPDATED upsert; DELETED removes. RLS on, no policies.

## Routes

- `POST /api/webhooks/ghl-trigger-subscription`: checks a shared-secret header (`X-PingWren-Secret`, set in the portal config and the `GHL_WORKFLOW_WEBHOOK_SECRET` env var, compared in constant time), then upserts or deletes. It accepts only `trigger_key` values we define, and only `target_url` hosts under `services.leadconnectorhq.com`, because we'll be POSTing to that URL with a location token. It's idempotent on `triggerData.id`.
- **Firing:** a `fireWorkflowTrigger(locationId, key, payload)` helper in a new `src/lib/ghl-triggers.ts`. It loads that location's subscriptions for the key, refreshes the location token (the existing `src/lib/ghl.ts` token path), and POSTs to each `target_url`. It is best effort: a failed fire is logged with a fixed string and never blocks the message flow or the bridge.
- **Where it fires from:**
  - Disconnected and reconnected: the bridge already reports status changes into `whatsapp_sessions`. The app's cron drain (`/api/cron/drain`) compares each session's status with the last status it fired for (a new column, `whatsapp_sessions.last_fired_status`), and fires on a change that has lasted 5 minutes. The bridge gains no GHL knowledge.
  - Message received: `src/lib/ghl-inbound.ts`, after a successful push.

## Prototype first

Firing `targetUrl` is undocumented. Before planning, test on a sandbox sub-account with LC Premium on:
1. Add the trigger to a workflow and capture the subscription POST.
2. Try POSTing the sample payload to `targetUrl` with `Authorization: Bearer <location token>` and the `Version` header the rest of the API uses.
3. Record what works in this spec, then plan.

If firing isn't possible from outside, fall back to GHL's documented inbound webhook trigger. The agency pastes a URL into their own workflow, which works on any plan but takes manual setup.

## Tests (to be planned)

- Subscription route: rejects a missing or wrong secret, an unknown trigger key, and a `target_url` on another host; CREATED then DELETED leaves nothing; a duplicate CREATED is idempotent.
- Disconnect detection: a 2-minute blip fires nothing; 5+ minutes fires once; recovery fires reconnected once; a ban fires `reason: "banned"`.
- Payloads match the portal sample shapes exactly; no message text in `whatsapp_message_received`.
- A failed fire never throws into the inbound drain.

## Open questions for Charlie

- Should PingWren add its own per-execution price on top of GHL's $0.01? Proposed: no. It's a small cost to customers already, and GoGHL's triggers are part of its plan.
- ~~Is LC Premium acceptable for the launch audience?~~ **Answered 17 Oct:** most FitPro CRM coaches have LC Premium Triggers & Actions on, so these triggers are a coach feature, not only an agency one.
