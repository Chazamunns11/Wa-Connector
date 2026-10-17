# Missed calls and read receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post a missed WhatsApp call into the contact's GHL conversation, and show sent WhatsApp messages as **read** in GHL when the contact reads them. Both work without the custom-trigger work (item 3).

**Architecture:** The bridge observes Baileys' `call` and `messages.update` events. A missed call becomes an ordinary `whatsapp_inbound_messages` row with `event_kind = 'missed_call'`, and the existing inbound drain posts it with a fixed string. Receipts set `delivered_at` / `read_at` on the bridge ledger (`whatsapp_messages`), and a new app drain sends GHL a second status, `read`, after the existing `delivered` report.

**Tech Stack:** Bridge: Node 24, Baileys 7.0.0-rc14, `node:test`. App: Next.js 16, Supabase (service role), `node:test` in `scripts/test`.

**Spec:** `docs/superpowers/specs/2026-10-17-calls-receipts-fallback-ai-design.md`, sections 5 and 8 (trigger halves out of scope).

## Global Constraints

- Fixed strings, verbatim: `📞 Missed WhatsApp call`, `📞 Missed WhatsApp video call`.
- The bridge never answers, rejects or otherwise acts on a call. It only observes.
- Group calls (`isGroup`) and calls from our own number are ignored.
- A missed call goes through the same sender resolution as messages (PN, or a LID that `lidMapping.getPNForLID` resolves). Unresolvable callers are dropped.
- One missed-call row per (number, caller) per 10 minutes.
- `delivered_at` and `read_at` are set once and never move backwards. Setting `read_at` also sets `delivered_at` if it is null.
- Receipts are tracked for one-to-one messages only. Group messages record no receipts (Baileys sends group receipts through a different event).
- The UI and GHL never claim "not read". Absence of a read ack means nothing.
- Flags, all default **off**: bridge `WA_MISSED_CALLS_ENABLED`, bridge `WA_READ_RECEIPTS_ENABLED`, app `GHL_READ_RECEIPTS_ENABLED`. They stay off until the real-device / sandbox checks in Task 6 pass.
- App-originated rows (`isAppOriginatedMessageId`) never PUT a status to GHL, `read` included.
- Never log phones, JIDs, call ids, message ids or text. Log fixed strings, error names and counts only.
- Never expose tenant ids to browsers. (No browser surface changes here.)
- New migration is `0010_missed_calls_and_receipts.sql`. Apply before deploying this bridge and app.

## Review Focus

1. **A caller rings five times in three minutes.** Exactly one missed-call row and one GHL post (Task 2 test `rate limit: second missed call within 10 minutes is not recorded`).
2. **The coach answers on the phone.** An `accept` from any device means no row (Task 2 test `accepted call is never missed`).
3. **A receipt arrives before the ledger row has its `wa_message_id`.** The ack is applied once `markMessageSent` runs (Task 3 test `early receipt is applied after markMessageSent`).
4. **Acks out of order or repeated** (read before delivered, a second delivered after read). Timestamps never go backwards and read implies delivered (Task 3 tests `read before delivered sets both`, `delivered after read changes nothing`).
5. **GHL rejects `read` with a 4xx.** That row is not retried, its `delivered` status in GHL is untouched, and the drain moves on (Task 5 test `4xx on read is final`).

---

### Task 1: Migration and shared types

**Files:**
- Create: `supabase/migrations/0010_missed_calls_and_receipts.sql`
- Modify: `src/lib/types.ts` (`WhatsappInboundMessage.eventKind: "missed_call" | null`), `src/lib/data/supabase.ts` (select and map `event_kind` wherever inbound rows are read)
- Test: `scripts/test/repository-shape.test.ts` (if it pins column lists), an existing inbound-row mapping test

**Interfaces:**
- Produces (SQL):
  - `whatsapp_inbound_messages.event_kind text null`, CHECK `event_kind is null or event_kind in ('missed_call','edit','reaction','delete')` (the last three reserved for the item 4 spec, so it needs no second migration). A missed call has `body = null` and `message_type in ('missedVoiceCall','missedVideoCall')`.
  - Index `whatsapp_inbound_missed_call_idx (coach_id, from_phone, received_at desc) where event_kind = 'missed_call'`.
  - `whatsapp_messages.delivered_at timestamptz null`, `whatsapp_messages.read_at timestamptz null`, and index `whatsapp_messages_wa_id_idx (coach_id, wa_message_id) where wa_message_id is not null`.
  - `ghl_outbound_messages.read_reported_at timestamptz null`, `ghl_outbound_messages.read_report_error text null`, and partial index `ghl_outbound_read_pending_idx (created_at) where reported_status = 'delivered' and read_reported_at is null`.
  - RLS stays on, with no new policies, as in earlier migrations.
- [ ] **Step 1:** Write the migration. Follow 0009's style (comments explaining each column, `if not exists`).
- [ ] **Step 2:** Add `eventKind` to the type and the Supabase mapping (null-safe for rows before 0010).
- [ ] **Step 3: Run** `npm run check`. Expect PASS.
- [ ] **Step 4: Commit** `db: missed calls and read receipts`.

### Task 2: Bridge missed calls

**Files:**
- Create: `services/whatsapp-bridge/src/calls.ts`
- Modify: `services/whatsapp-bridge/src/store.ts`, `services/whatsapp-bridge/src/sessions.ts` (subscribe `sock.ev.on("call", …)` only when `config.missedCallsEnabled`), `services/whatsapp-bridge/src/config.ts` (`WA_MISSED_CALLS_ENABLED`, default false), `services/whatsapp-bridge/README.md`
- Test: new `services/whatsapp-bridge/test/calls.test.ts`

**Interfaces:**
- Consumes: `resolveSenderE164` and `pnJidToE164` from `inbound.ts` (export them if needed), `BridgeStore.recordInboundMessage`, `schedulePoke`.
- Produces:
  - `class MissedCallTracker { constructor(deps: MissedCallDeps, now?: () => number); handle(coachId: string, events: WACallEvent[]): Promise<void> }`.
    - It keeps per-call state in memory, keyed by `${coachId}:${call.id}`: seen `offer`, seen `accept`.
    - On a terminal status (`timeout`, `reject`, `terminate`) without a prior `accept`, the call is missed. `accept` marks the call answered. Entries are dropped on a terminal status and swept after 10 minutes.
    - It ignores `isGroup`, and calls whose `from` decodes to our own number.
  - `MissedCallDeps = { resolvePnForLid(lidJid: string): Promise<string | null>; hasRecentMissedCall(coachId: string, phoneE164: string, sinceIso: string): Promise<boolean>; recordInboundMessage(input: RecordInboundInput & { eventKind: "missed_call" }): Promise<{ fresh: boolean }>; schedulePoke(): void; ownPhone(coachId: string): string | null; log }`.
  - Row values: `waMessageId = "call:" + call.id`, `body = null`, `messageType = call.isVideo ? "missedVideoCall" : "missedVoiceCall"`, `receivedAt = call.date.toISOString()`, `groupJid = null`, `eventKind = "missed_call"`.
  - Sender: `resolveSenderE164(call.from, call.callerPn)`. For `unresolved_lid`, use `resolvePnForLid`. Otherwise drop.
  - `BridgeStore.recordInboundMessage` accepts optional `eventKind`. New `BridgeStore.hasRecentMissedCall(coachId, phoneE164, sinceIso): Promise<boolean>` (one indexed query; on a DB error return false and log a fixed string, so a call is never silently lost because the check failed).
  - Each event is handled in its own try/catch. A failure never throws into Baileys.
- [ ] **Step 1: Write failing tests** with fake deps:
  - `offer then timeout → one missed voice-call row`, with exact field values (waMessageId `call:<id>`, body null, messageType `missedVoiceCall`, eventKind `missed_call`), and `schedulePoke` called once.
  - `video call missed → missedVideoCall`.
  - `accepted call is never missed`: offer, accept, terminate → no row.
  - `reject without accept is missed`.
  - `group call ignored`; `call from our own number ignored`.
  - `LID caller resolved via lidMapping`; `unresolvable LID dropped, no row`.
  - `rate limit: second missed call within 10 minutes is not recorded` (`hasRecentMissedCall` true → no row, no poke).
  - `duplicate terminal events for one call → one row` (the second `recordInboundMessage` returns `{ fresh: false }` and no poke).
  - `a thrown store error doesn't throw out of handle`.
  - `wiring`: sessions.ts subscribes `call` only when the flag is on (a source-text assert, in the style of `sessions-text-content.test.ts`).
- [ ] **Step 2: Run** the bridge tests. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `PATH=/root/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH npm test && npm run typecheck` in `services/whatsapp-bridge`. Expect PASS.
- [ ] **Step 5: Commit** `bridge: log missed calls`.

### Task 3: Bridge receipts

**Files:**
- Create: `services/whatsapp-bridge/src/receipts.ts`
- Modify: `services/whatsapp-bridge/src/store.ts`, `services/whatsapp-bridge/src/sessions.ts` (subscribe `messages.update` when `config.readReceiptsEnabled`; apply pending acks after `markMessageSent`), `services/whatsapp-bridge/src/config.ts` (`WA_READ_RECEIPTS_ENABLED`, default false), `services/whatsapp-bridge/README.md`
- Test: new `services/whatsapp-bridge/test/receipts.test.ts`

**Interfaces:**
- Produces:
  - `receiptFromUpdate(u: WAMessageUpdate): { waMessageId: string; level: "delivered" | "read"; isGroup: boolean } | null`. It handles only `u.key.fromMe === true` with a numeric `u.update.status`: `DELIVERY_ACK (3)` → delivered; `READ (4)` and `PLAYED (5)` → read. Anything else → null. `isGroup` comes from the remote JID.
  - `BridgeStore.markMessageReceipt(coachId: string, waMessageId: string, level: "delivered" | "read", atIso: string): Promise<"applied" | "no_row">`. It is two guarded updates: `delivered_at = coalesce(delivered_at, at)`, and for read also `read_at = coalesce(read_at, at)`. It filters `coach_id`, `wa_message_id` and `status = 'sent'`. It returns `no_row` when nothing matched.
  - `class ReceiptApplier { constructor(store, now?); handle(coachId, updates: WAMessageUpdate[]): Promise<void>; afterSent(coachId, waMessageId): Promise<void> }`.
    - A `no_row` result is kept in memory for 60 seconds (max 1,000 entries, oldest dropped), keyed by `${coachId}:${waMessageId}`, holding the highest level seen.
    - `afterSent`, called by sessions right after `markMessageSent` succeeds, re-applies any pending entry.
    - For a group message, a read is applied as delivered only.
- [ ] **Step 1: Write failing tests:**
  - `receiptFromUpdate`: status 3 → delivered; 4 and 5 → read; `fromMe: false` → null; no status → null; status 2 (server ack) → null.
  - `read before delivered sets both`; `delivered after read changes nothing` (a fake store that implements the coalesce semantics, plus an assert on the update calls' shape).
  - `group read is recorded as delivered only`.
  - `early receipt is applied after markMessageSent`: `no_row`, then `afterSent` → applied once. An entry older than 60 s is not applied.
  - `pending map is bounded at 1,000`.
  - `a store error never throws out of handle`.
  - `wiring`: the `messages.update` subscription is behind the flag, and `afterSent` is called after `markMessageSent` (source-text asserts).
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the bridge tests and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `bridge: record delivered and read receipts`.

### Task 4: App posts missed calls to GHL

**Files:**
- Modify: `src/lib/ghl-inbound.ts` (body selection at ~:645), `src/lib/ghl.ts` (constants)
- Test: `scripts/test/ghl-inbound.test.ts`

**Interfaces:**
- Consumes: `WhatsappInboundMessage.eventKind` (Task 1).
- Produces: `MISSED_VOICE_CALL_TEXT = "📞 Missed WhatsApp call"`, `MISSED_VIDEO_CALL_TEXT = "📞 Missed WhatsApp video call"`, and `describeMissedCall(messageType: string): string` (`missedVideoCall` → video text, anything else → voice text), exported from `ghl.ts`.
  - In `processGhlInboundRow`, when `row.eventKind === "missed_call"`, the body is `describeMissedCall(row.messageType)` with no attachments. It never goes through `resolveMediaAttachment` or the STOP keyword handling. The usual number prefix still applies. Contact upsert, sticky-number recording and the claim/resolve flow are unchanged, so it posts as a normal inbound message (firing "Customer replied" is intended).
- [ ] **Step 1: Write failing tests:** `missed voice call posts "📞 Missed WhatsApp call"` (exact body, with and without a number prefix on a multi-number location); `missed video call posts the video string`; `missed call skips media resolution` (the media dep is not called); `missed call is not treated as a STOP keyword`; `a row with eventKind null is unchanged` (existing tests pass unedited).
- [ ] **Step 2: Run** `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `inbound: post missed WhatsApp calls to GHL`.

### Task 5: App reports `read` to GHL

**Files:**
- Modify: `src/lib/ghl-provider.ts` (new drain), `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/app/api/cron/drain/route.ts` (call the new drain after `drainGhlOutboundStatuses`, only when `GHL_READ_RECEIPTS_ENABLED === "true"`), `src/lib/types.ts`
- Test: new `scripts/test/ghl-read-receipts.test.ts`, `scripts/test/repository-shape.test.ts`

**Interfaces:**
- Consumes: Task 1 columns, the existing `reportGhlOutcome` token resolution, `deps.updateStatus`, `isAppOriginatedMessageId`.
- Produces:
  - Repo:
    - `listGhlOutboundAwaitingRead(limit: number, sinceIso: string): Promise<GhlOutboundMessage[]>`: `reported_status = 'delivered'`, `read_reported_at is null`, `created_at >= sinceIso`, oldest first.
    - `getWhatsappReadTimes(pairs: { tenantId: string; idempotencyKey: string }[]): Promise<Map<string, string>>`: key `${tenantId}:${idempotencyKey}` → `read_at`, only rows with `read_at` not null.
    - `markGhlOutboundReadReported(id: string, result: { readReportError: string | null }): Promise<void>`: sets `read_reported_at = now()` and `read_report_error`.
  - `drainGhlReadReceipts(repo, deps = defaultGhlProviderDeps): Promise<{ examined: number; reported: number; failed: number }>`.
    - Window: 7 days. Batch cap: the existing `DRAIN_BATCH_CAP`.
    - App-originated rows are marked read-reported locally (error null) without a PUT.
    - For a row with a `read_at`, PUT `status: "read"` via `deps.updateStatus`. Success → `markGhlOutboundReadReported(id, { readReportError: null })`.
    - A 4xx (detect it the way `reportGhlOutcome` classifies PUT errors; add a status to the `updateGhlMessageStatus` error if needed) → mark reported with the fixed error `"GHL refused read status"`. It's final and never retried.
    - A 5xx, network error or token failure → leave it for the next pass.
    - It never touches `reported_status`.
  - The cron response gains `ghlReadReceipts` (counts only).
- [ ] **Step 1: Write failing tests:** `read row → PUT "read" once and marked`; `no read_at → no PUT`; `app-originated row → marked, no PUT`; `4xx on read is final` (marked with the fixed error, not listed again, `reported_status` untouched); `5xx is retried next pass` (not marked); `rows older than 7 days aren't listed` (repo query test or shape test); `flag off → the cron route doesn't call the drain`.
- [ ] **Step 2: Run** `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `provider: report read receipts to GHL`.

### Task 6: Docs and checks

**Files:**
- Create: `docs/superpowers/specs/2026-10-17-calls-receipts-real-device-check.md`
- Modify: `README.md`, `services/whatsapp-bridge/README.md`, `docs/GO-LIVE-FOUNDATION.md` (migration 0010, the three flags), `docs/superpowers/specs/2026-10-17-calls-receipts-fallback-ai-design.md` (mark 5 and 8 built, without triggers), `docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`

- [ ] **Step 1:** Write the real-device checklist. On a spare number with `WA_MISSED_CALLS_ENABLED=true`:
  - Ring and don't answer → one GHL message.
  - Ring and answer on the phone → none.
  - Decline → one.
  - Ring five times → one.
  - Video call → the video string.
  - Ring while the bridge is offline, then reconnect → record what happens (Baileys' `offline: true` path).

  With `WA_READ_RECEIPTS_ENABLED=true` and `GHL_READ_RECEIPTS_ENABLED=true` in a sandbox sub-account:
  - Send from GHL and read on the contact's phone → GHL shows read.
  - Record whether GHL accepts `read` (spec open question 1). If it doesn't, leave the app flag off.
  - A contact with read receipts turned off → delivered only.
- [ ] **Step 2:** Document migration 0010, the flags and their defaults, and that the flags stay off until the checklist passes.
- [ ] **Step 3: Run** `npm run check`. **Commit** `docs: missed calls and read receipts`.

## Decisions during the build

- Receipts are tracked for one-to-one messages only. Group messages record no receipts, because Baileys sends group receipts through a different event.
- A call counts as missed only if the bridge saw the ring (`offer`) for it. A call ringing during a bridge restart, or one answered and longer than 10 minutes, is never logged as missed.
- Migration 0010 also holds the SQL function `ghl_outbound_awaiting_read` (service_role only). Migrations 0001 to 0010 were all applied successfully to a local Postgres 16.
- A 401 from GHL on a read status is retried. Other 4xx responses are final ("GHL refused read status").
