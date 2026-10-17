# WhatsApp workflow triggers, SMS fallback and AI replies guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let GHL workflows react to WhatsApp events (disconnected, reconnected, message received, missed call, message read, contact not on WhatsApp), make "not on WhatsApp" a fast, remembered fallback signal, and publish the AI-replies setup guide.

**Architecture:** GHL calls our subscription webhook when a workflow adds or removes one of our triggers, and we store the `targetUrl`. A single helper fires an event to every matching subscription for a location. The one undocumented step, *how* to call `targetUrl`, sits in one small function so the sandbox result can change it in one place. Firing is behind an app flag that is off by default. Disconnect detection runs in the app, driven by bridge pokes on connection changes, with the hourly cron as a backstop. "Not on WhatsApp" is remembered per (location, phone) for 30 days, so repeat sends fail fast and fire the fallback trigger.

**Tech Stack:** Next.js 16, Supabase (service role), `node:test` in `scripts/test`. Bridge: Node 24 (for the connection-change poke only).

**Spec:** `docs/superpowers/specs/2026-10-17-ghl-workflow-triggers-actions-design.md`, plus `docs/superpowers/specs/2026-10-17-calls-receipts-fallback-ai-design.md` §5–8 (the trigger halves, SMS fallback A and AI replies).

## Global Constraints

- Trigger keys, exactly: `whatsapp_disconnected`, `whatsapp_reconnected`, `whatsapp_message_received`, `whatsapp_missed_call`, `whatsapp_message_read`, `whatsapp_not_on_whatsapp`. Any other key is refused.
- Payloads, exactly. `number` is the sub-account's WhatsApp number in E.164, and `numberLabel` is its label or null.
  - `whatsapp_disconnected`: `{ number, numberLabel, reason: "logged_out" | "banned" | "connection_lost", heldMessages: number, reconnectUrl: string }`
  - `whatsapp_reconnected`: `{ number, numberLabel, downMinutes: number }`
  - `whatsapp_message_received`: `{ number, numberLabel, messageType: "text" | "voice_note" | "image" | "video" | "document" | "other", contactId }`. **No message text.**
  - `whatsapp_missed_call`: `{ number, numberLabel, isVideo: boolean, contactId }`
  - `whatsapp_message_read`: `{ number, numberLabel, contactId, messageId }` (`messageId` is GHL's message id)
  - `whatsapp_not_on_whatsapp`: `{ number, numberLabel, contactId, message: string }` (the text we couldn't send, at most 500 code points)
- Subscription webhook: `POST /api/webhooks/ghl-trigger-subscription`. The secret header is `X-PingWren-Secret`, compared in constant time with `GHL_WORKFLOW_WEBHOOK_SECRET`. An unset secret → 503. Only `target_url` hosts equal to `services.leadconnectorhq.com` or ending `.leadconnectorhq.com`, over https, are accepted.
- Firing flag `GHL_WORKFLOW_TRIGGERS_ENABLED === "true"`, default off. With it off, nothing is ever POSTed to a `targetUrl`. Subscriptions are still stored.
- Firing is best effort. A failed fire is logged with a fixed string and the HTTP status only. It never throws into, delays or changes the outcome of the message flow, the drains or the bridge. Each fire has a 5-second timeout.
- `reconnectUrl` is a freshly minted "send" connect link for that number's slot. The trigger's portal description says: "For internal alerts only. Never send this link to a contact."
- Disconnected fires when a number has been down for 5 minutes, or at once on `logged_out` / `banned`. Reconnected fires once when a number that fired disconnected comes back. A blip under 5 minutes fires nothing.
- "Not on WhatsApp" is remembered per (location, E.164 phone) for 30 days. It is cleared when that phone sends us any one-to-one inbound row (event rows included) on that location. STOP still wins: an opted-out contact gets no fallback trigger.
- Never log phones, contact ids, message text, target URLs or tokens.
- New migration `0012_workflow_triggers.sql`. Apply before deploying.

## Review Focus

1. **A number drops for 2 minutes and comes back.** Nothing fires (Task 6 test `blip under 5 minutes fires nothing`).
2. **A GHL `targetUrl` on another host.** The subscription is refused, and nothing is ever POSTed there (Task 2 test, and a Task 3 re-check at fire time).
3. **The trigger endpoint is slow or down.** The inbound drain still posts and resolves the row, and the fire times out at 5 s (Task 3 test `fire timeout never blocks`).
4. **A contact remembered as not on WhatsApp messages us.** The memory clears, and the next send goes to WhatsApp (Task 5 test).
5. **The flag off.** No HTTP call to any `targetUrl` from any path (Task 3 test, plus one assertion per fire point in Task 4).

---

### Task 1: Migration, types and repo

**Files:**
- Create: `supabase/migrations/0012_workflow_triggers.sql`
- Modify: `src/lib/types.ts`, `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`
- Test: `scripts/test/repository-shape.test.ts`

**Interfaces:**
- SQL:
  - `ghl_workflow_trigger_subscriptions (id text primary key /* GHL triggerData.id */, location_id text not null references ghl_accounts(location_id) on delete cascade, workflow_id text, trigger_key text not null check (trigger_key in (<the six keys>)), target_url text not null, filters jsonb not null default '[]', created_at timestamptz not null default now(), updated_at timestamptz not null default now())`, indexed on `(location_id, trigger_key)`.
  - `whatsapp_sessions.trigger_down_since timestamptz null`, `whatsapp_sessions.trigger_last_fired text null check (trigger_last_fired in ('down','up'))`.
  - `ghl_not_on_whatsapp (location_id text not null references ghl_accounts(location_id) on delete cascade, phone_e164 text not null check (E.164), until timestamptz not null, primary key (location_id, phone_e164))`.
  - RLS on, no policies.
- Repo (types in `types.ts`):
  - `upsertTriggerSubscription(sub: { id; locationId; workflowId: string | null; triggerKey: TriggerKey; targetUrl; filters: unknown }): Promise<void>`;
  - `deleteTriggerSubscription(id: string): Promise<void>`;
  - `listTriggerSubscriptions(locationId: string, key: TriggerKey): Promise<{ id: string; targetUrl: string }[]>`;
  - `listLocationsWithTriggerKeys(keys: TriggerKey[]): Promise<string[]>`;
  - `rememberNotOnWhatsapp(locationId, phoneE164, untilIso): Promise<void>`;
  - `isRememberedNotOnWhatsapp(locationId, phoneE164, nowIso): Promise<boolean>`;
  - `forgetNotOnWhatsapp(locationId, phoneE164): Promise<void>`;
  - `setSessionTriggerState(tenantId, { downSince: string | null; lastFired: "down" | "up" | null }): Promise<void>`;
  - `listSessionsForTriggers(locationIds: string[]): Promise<{ tenantId; locationId; slot; label: string | null; phone: string | null; status; downSince: string | null; lastFired: "down" | "up" | null; lastConnectedAt: string | null }[]>`.
  - Export `TRIGGER_KEYS` (readonly tuple) and `type TriggerKey` from a new `src/lib/ghl-trigger-keys.ts`.
- [ ] **Step 1:** Write the migration in 0011's style. Apply 0001–0012 locally (README "Checking migrations locally").
- [ ] **Step 2:** Add the repo methods and the METHODS list entries.
- [ ] **Step 3: Run** `npm run check`. Expect PASS.
- [ ] **Step 4: Commit** `db: workflow triggers and not-on-WhatsApp memory`.

### Task 2: Subscription webhook

**Files:**
- Create: `src/app/api/webhooks/ghl-trigger-subscription/route.ts`, `src/app/api/webhooks/ghl-trigger-subscription/logic.ts`
- Test: new `scripts/test/ghl-trigger-subscription.test.ts`

**Interfaces:**
- `decideTriggerSubscription(repo, secretHeader: string | null, body: unknown, env: { secret: string | undefined }): Promise<{ status: number; body: Record<string, unknown> }>`.
- Body `{ triggerData: { id, key, filters, eventType: "CREATED" | "UPDATED" | "DELETED", targetUrl }, extras: { locationId, workflowId, companyId } }`. CREATED and UPDATED upsert; DELETED deletes (idempotent).
- The location must be a known `ghl_accounts` row, else 404 `unknown_location`. The route is a thin adapter in the style of `src/app/api/webhooks/crm-outbound-status/route.ts` (read the Next route-handler guide first).
- [ ] **Step 1: Write failing tests:** missing or wrong secret → 401; secret unset → 503; unknown key → 400; `http://…` or another host (including `leadconnectorhq.com.evil.example`) → 400; CREATED then DELETED leaves nothing; a duplicate CREATED → one row; UPDATED changes the target URL; unknown location → 404; a malformed body → 400.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `webhooks: GHL workflow trigger subscriptions`.

### Task 3: The fire helper

**Files:**
- Create: `src/lib/ghl-triggers.ts`
- Test: new `scripts/test/ghl-triggers.test.ts`

**Interfaces:**
- `fireWorkflowTrigger(repo, deps: TriggerDeps, locationId: string, key: TriggerKey, payload: TriggerPayloads[TriggerKey]): Promise<{ fired: number; failed: number }>`. It never throws.
  - Flag off → `{ fired: 0, failed: 0 }` with no reads.
  - Otherwise: list the subscriptions, resolve the location token with the existing `resolveGhlAccessToken` path, re-check each `targetUrl` host, and call `deps.postTriggerEvent`.
- `postTriggerEvent(targetUrl: string, accessToken: string, payload: object): Promise<{ ok: boolean; status: number | null }>`. **The single place the firing method lives:** POST JSON with `Authorization: Bearer <token>`, `Version: <the API version ghl.ts uses>`, `Content-Type: application/json`, and a 5 s `AbortSignal.timeout`. Its JSDoc says it's unverified until the sandbox test in Task 7's checklist.
- `type TriggerPayloads`, one entry per key, with exactly the Global Constraints shapes. Also `toTriggerMessageType(bridgeMessageType: string): TriggerPayloads["whatsapp_message_received"]["messageType"]`: conversation/extendedText → text; audio with ptt → voice_note (and audio without ptt → other); image; video; document; anything else → other.
- [ ] **Step 1: Write failing tests:** `flag off: no fetch, no repo reads`; `fires to every subscription for the key`; `foreign host at fire time is skipped`; `a 500 from one target doesn't stop the others`; `fire timeout never blocks` (a never-resolving fake fetch, with an injectable timeout and a short value in the test); `no token → failed, no throw`; the `toTriggerMessageType` mapping; `payload sent is exactly the given object` (no extra fields).
- [ ] **Step 2–4:** FAIL, implement, `npm run check` PASS.
- [ ] **Step 5: Commit** `triggers: fire WhatsApp events to GHL workflows`.

### Task 4: Fire points

**Files:**
- Modify: `src/lib/ghl-inbound.ts`, `src/lib/ghl-provider.ts`
- Test: `scripts/test/ghl-inbound.test.ts`, `scripts/test/ghl-read-receipts.test.ts`, `scripts/test/ghl.test.ts`

**Interfaces:**
- Inbound drain, after a successful push only:
  - a plain one-to-one row fires `whatsapp_message_received`;
  - a missed-call row fires `whatsapp_missed_call` (`isVideo = messageType === "missedVideoCall"`);
  - group rows, event rows (edit, reaction, delete) and suppressed or stale rows fire nothing.
- Read drain: when a row is marked read-reported after a successful PUT, fire `whatsapp_message_read` with `messageId = row.ghlMessageId`. App-originated rows don't fire.
- Status drain: when a row is reported failed because the bridge said `not_on_whatsapp`, fire `whatsapp_not_on_whatsapp` with the row's `pending_text`, or "" if it isn't stored (check what the row keeps). A row refused for STOP fires nothing.
- Fires are awaited, but behind the helper's never-throw contract and timeout. Add the helper to the drains' deps so tests can fake it.
- [ ] **Step 1: Write failing tests:** one per fire point (key plus exact payload); none for group, event, suppressed or opted-out rows; flag off → the helper is called but posts nothing (or isn't called; pick one and assert it); a throwing fake helper never changes the drain result.
- [ ] **Step 2–4:** FAIL, implement, `npm run check` PASS.
- [ ] **Step 5: Commit** `triggers: fire on received, missed call, read and not on WhatsApp`.

### Task 5: Remember "not on WhatsApp" (SMS fallback A)

**Files:**
- Modify: `src/lib/ghl-provider.ts` (status drain: remember; the text-send path in `continueTextOutbound` or just before it: check), `src/lib/ghl-inbound.ts` (clear)
- Test: `scripts/test/ghl.test.ts`, `scripts/test/ghl-inbound.test.ts`

**Interfaces:**
- When the status drain reports `not_on_whatsapp` for a one-to-one row, call `rememberNotOnWhatsapp(location, toPhone, now + 30 days)`.
- On a new one-to-one text send (GHL or app-originated):
  - the STOP check and the billing gate run first, unchanged;
  - then, if `isRememberedNotOnWhatsapp`, the send is refused with the existing `REASON_NOT_ON_WHATSAPP` string, not sent to the bridge, and fires `whatsapp_not_on_whatsapp`;
  - a read error fails open (sends normally).
- The inbound drain, on any non-group row for (location, `fromPhone`), calls `forgetNotOnWhatsapp`. It is best effort and must not fail the row.
- [ ] **Step 1: Write failing tests:**
  - `not_on_whatsapp is remembered for 30 days`;
  - `remembered contact is refused fast without a bridge call and fires the trigger`;
  - `an expired memory sends normally`;
  - `inbound from the contact clears it` (Review Focus 4);
  - `opted-out contact: STOP refusal wins, no fallback trigger`;
  - `memory read error fails open`;
  - `group sends ignore the memory`.
- [ ] **Step 2–4:** FAIL, implement, `npm run check` PASS.
- [ ] **Step 5: Commit** `fallback: remember contacts who aren't on WhatsApp`.

### Task 6: Disconnected and reconnected

**Files:**
- Create: `src/lib/session-triggers.ts`
- Modify: `src/app/api/cron/drain/route.ts` and `src/app/api/webhooks/whatsapp-replies/route.ts` (run `drainSessionTriggers` after the existing drains, when the flag is on), `services/whatsapp-bridge/src/sessions.ts` (poke the app on every connection open or close, and again 5 minutes 15 seconds after a close if the session is still not open), `services/whatsapp-bridge/README.md`
- Test: new `scripts/test/session-triggers.test.ts`, bridge `test/sessions-*` (a source-text assert for the delayed poke, as earlier tasks did)

**Interfaces:**
- `drainSessionTriggers(repo, deps, now = Date.now()): Promise<{ fired: number }>`. It only looks at sessions of locations that have a `whatsapp_disconnected` or `whatsapp_reconnected` subscription.
- Per session:
  - **Down** (status not `connected`), with `downSince` null → set `downSince = now`. Then:
    - if the status is `logged_out` or `banned`, or `now - downSince >= 5 min`, and `lastFired !== "down"` → fire disconnected and set `lastFired = "down"`.
    - `reason`: `logged_out` → `logged_out`; `banned` → `banned`; otherwise `connection_lost`.
    - `heldMessages`: the count of held outbound rows for that tenant (an existing count if there is one; else add `countHeldOutbound(tenantId)`).
    - `reconnectUrl`: built like `src/lib/account-data/connect-link.ts` does, but for the session's slot (`mintConnectLinkToken(locationId, account.connectLinkVersion, "send", slot)`).
  - **Up** → if `lastFired === "down"`, fire reconnected with `downMinutes = round((now - downSince) / 60000)`. Always clear `downSince` and set `lastFired = "up"` when it was "down".
  - A blip (down, then up before 5 min) fires nothing and clears `downSince`.
- Bridge: the existing `PortalPoke` (`services/whatsapp-bridge/src/poke.ts`) is reused. The delayed poke uses an `unref`'d timer and is cancelled on open.
- [ ] **Step 1: Write failing tests:**
  - `blip under 5 minutes fires nothing`;
  - `down 5+ minutes fires disconnected once` (a second pass doesn't refire);
  - `banned fires at once with reason banned`;
  - `recovery fires reconnected once with downMinutes`;
  - `reconnectUrl uses the session's slot`;
  - `only locations with subscriptions are read`;
  - `flag off: the drain isn't run`;
  - bridge: `close schedules one delayed poke; open cancels it`.
- [ ] **Step 2–4:** FAIL, implement, run `npm run check` and the bridge tests. Expect PASS.
- [ ] **Step 5: Commit** `triggers: WhatsApp disconnected and reconnected`.

### Task 7: Portal setup, AI replies guide and docs

**Files:**
- Create: `docs/GHL-WORKFLOW-TRIGGERS-SETUP.md`, `src/app/(site)/docs/ai-replies/page.tsx` (link it from `src/app/(site)/docs/page.tsx` like the other guides), `docs/superpowers/specs/2026-10-17-workflow-triggers-sandbox-check.md`
- Modify: `docs/GO-LIVE-FOUNDATION.md` (migration 0012, `GHL_WORKFLOW_WEBHOOK_SECRET`, `GHL_WORKFLOW_TRIGGERS_ENABLED`, the `workflows.readonly` scope), the two specs (mark built and pending the sandbox), the roadmap
- [ ] **Step 1:** `GHL-WORKFLOW-TRIGGERS-SETUP.md` gives Charlie the developer-portal entries for each trigger:
  - key, name, description (the reconnect-link warning on `whatsapp_disconnected`), and the sample JSON (the Global Constraints shapes with realistic UK values);
  - the Subscription URL `https://<app>/api/webhooks/ghl-trigger-subscription` and the `X-PingWren-Secret` header;
  - the scope.
- [ ] **Step 2:** The sandbox check:
  - add each trigger to a workflow and confirm the subscription row appears;
  - with the flag on, confirm each event starts the workflow;
  - if `postTriggerEvent`'s method is wrong, record the working method and fix that one function.
  - Also the AI-replies test from the calls spec §7: does Conversation AI reply through PingWren by WhatsApp, with pacing; does it reply in groups (it must not).
- [ ] **Step 3:** The website page "AI replies on WhatsApp with GHL's Conversation AI", in the docs pages' style:
  - what it is;
  - turning Conversation AI on for the channel;
  - that replies go through PingWren's normal sending, so pacing, typing, held messages and STOP all apply;
  - excluding the `whatsapp-group` tag so the AI never answers group messages;
  - that it's pending a live check.
  - Plain words, no hype.
- [ ] **Step 4:** In the SMS fallback docs, say: option A is the `whatsapp_not_on_whatsapp` trigger plus the 30-day memory, built; option B (automatic SMS) waits for customer demand and Charlie's answer on cost (calls spec open question 3).
- [ ] **Step 5:** Run `npm run check` and the production build. **Commit** `docs: workflow triggers, SMS fallback and AI replies`.

## Decisions during the build

- The `target_url` host allow-list is exactly `services.leadconnectorhq.com` or its subdomains. It is https only, with no port, userinfo or empty labels, and the URL is stored normalised. Widen it only if the sandbox shows another host.
- The subscription webhook checks the secret before reading the body, caps body sizes, and ties each subscription to its location (409 `location_mismatch`).
- Fires run in the background with an 8 s cap per drain pass. After the first failure in a pass, further fires are skipped. The session-trigger drain uses one pass per location.
- The send-path "not on WhatsApp" fire uses Next `after()`.
- `pending_text` is now kept on accepted rows until reported (migration 0013, comment-only), so the not-on-WhatsApp trigger carries the unsent text. Accepted rows never reported have it cleared after 7 days.
- STOP/START keyword rows do not fire `whatsapp_message_received`. Plain audio maps to `voice_note`.
- The "not on WhatsApp" memory clears on any one-to-one inbound row, including rows that are not posted.
- Disconnected: a never-linked number never fires. The number survives logout or ban via `whatsapp_sessions.trigger_phone`. The state is compare-and-set, so each alert fires once. Lost fires are not retried.
- Migrations 0001 to 0013 apply on Postgres 16.
- SMS fallback: option A (the trigger plus the 30-day memory) is built. Option B (automatic SMS) waits for customer demand and Charlie's answer on cost (calls spec open question 3).
