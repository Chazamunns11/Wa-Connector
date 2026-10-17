# Quoted replies, edits, reactions and deletes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a contact's quoted replies, edits, reactions and "delete for everyone" in the GHL conversation, without reactions or deletes firing "Customer replied" workflows unless the sub-account turns them on.

**Architecture:** The bridge's inbound classifier stops dropping edits, reactions and revokes. It records them as inbound rows with an `event_kind` and the id of the message they act on, and it renders a quoted reply's prefix into the body. The app's inbound drain renders each event with fixed formats, and suppresses reactions and deletes unless that sub-account's toggles allow them. The toggles live in the GHL embed, scoped to the sub-account.

**Tech Stack:** Bridge: Node 24, Baileys 7.0.0-rc14, `node:test`. App: Next.js 16, Supabase (service role), `node:test` in `scripts/test`.

**Spec:** `docs/superpowers/specs/2026-10-17-voice-notes-and-message-events-design.md` (the voice-note half is already built).

## Global Constraints

- Fixed formats, verbatim. `<…>` marks a substitution.
  - Quoted reply: `↩ "<first 80 characters of the quoted text>"`, then a newline, then the reply.
  - Quoted media: `↩ (photo)`, `↩ (video)`, `↩ (voice note)` (ptt audio), `↩ (audio)`, `↩ (document)`, `↩ (sticker)`, otherwise `↩ (message)`.
  - Edit: `✏️ Edited: <new text>`.
  - Reaction: `<emoji> reacted to "<first 80 characters of the original>"`. For a reaction to one of our messages: `<emoji> reacted to your message`. When the original is no longer stored: `<emoji> reacted to a message`.
  - Delete: `🗑 Deleted a message`.
- "Characters" means code points. The prefix counts toward the 500-character body cap. For a quoted reply, the reply text is truncated first, so the prefix always survives.
- Defaults: quoted replies and edits are posted (they are real replies). Reactions and deletes are **suppressed** unless the sub-account turns them on. A suppressed row is resolved with `event_suppressed` and never posted.
- Embed toggle labels: "Show reactions in GHL" and "Show deleted-message notices in GHL". Under each, the line: "These appear as new messages and can trigger 'Customer replied' workflows." Settings are per sub-account.
- A removed reaction (empty emoji) is ignored. Polls stay dropped. Our own (`fromMe`) edits, reactions and deletes stay dropped.
- The wrapper-depth reasoning in `containsRejectedContentAtAnyDepth` still holds: an event inside any wrapper depth is classified as that event, never as fresh content.
- STOP keywords apply to plain messages and to edits (to the new text). They never apply to reactions or deletes.
- Bridge flag `WA_INBOUND_EVENTS_ENABLED`, default **off**. Off means today's behaviour exactly: events are dropped and quotes are ignored.
- New migration `0011_message_events.sql`. Apply before deploying this bridge and app.
- Never log message text, emoji, ids, phones or JIDs.

## Review Focus

1. **A reaction inside an ephemeral (disappearing-messages) chat.** It is classified as a reaction, not dropped and not treated as fresh text (Task 2 test `reaction inside ephemeralMessage`).
2. **A quoted reply whose reply is 500 characters.** The quote prefix survives, and the body is exactly 500 code points (Task 2 test `quote prefix survives truncation`).
3. **An edit to "STOP".** It opts the contact out the same way a plain STOP does (Task 3 test `edit to STOP opts out`).
4. **A reaction to a message older than the 90-day retention.** Renders `<emoji> reacted to a message`, never an error (Task 3 test).
5. **The flag off.** Every event type is dropped exactly as today, and the existing inbound tests pass unedited (Task 2).

---

### Task 1: Migration and types

**Files:**
- Create: `supabase/migrations/0011_message_events.sql`
- Modify: `src/lib/types.ts` (`WhatsappInboundMessage.eventKind: "missed_call" | "edit" | "reaction" | "delete" | null`, `targetWaMessageId: string | null`, `targetFromMe: boolean | null`; `GhlAccount.showReactions: boolean`, `showDeletes: boolean`), `src/lib/data/supabase.ts` (select and map the new columns)

**Interfaces:**
- Produces (SQL):
  - `whatsapp_inbound_messages.target_wa_message_id text null` and `target_from_me boolean null`.
  - `ghl_accounts.show_reactions boolean not null default false` and `show_deletes boolean not null default false`.
  - Index `whatsapp_inbound_wa_id_idx (coach_id, wa_message_id)` for the reaction target lookup, unless the existing dedupe constraint already serves it (it does, if it's a unique index on that pair: say which in a comment and skip the index).
- [ ] **Step 1:** Write the migration in 0010's style.
- [ ] **Step 2:** Update the types and mappings. Rows without the columns map to null or false.
- [ ] **Step 3:** Apply 0001–0011 to a scratch Postgres 16 (see the README section "Checking migrations locally", which Task 5 writes; until then, any empty Postgres with `auth.users` and `storage.buckets` stubs). Run `npm run check`. Expect PASS.
- [ ] **Step 4: Commit** `db: message events`.

### Task 2: Bridge classifies events and quotes

**Files:**
- Modify: `services/whatsapp-bridge/src/inbound.ts`, `services/whatsapp-bridge/src/store.ts` (`recordInboundMessage` takes `eventKind`, `targetWaMessageId`, `targetFromMe`), `services/whatsapp-bridge/src/config.ts` (`WA_INBOUND_EVENTS_ENABLED`), `services/whatsapp-bridge/src/sessions.ts` (pass the flag), `services/whatsapp-bridge/.env.example`, `services/whatsapp-bridge/README.md`
- Test: `services/whatsapp-bridge/test/inbound.test.ts`

**Interfaces:**
- `classifyInboundMessage(msg, batchType, enabledGroups, options?: { events: boolean })`. With `events: false` (the default), behaviour is unchanged.
- With `events: true`, step 5 finds the event at any wrapper depth and returns a reply whose `InboundReply` gains `eventKind`, `targetWaMessageId` and `targetFromMe`:
  - `reactionMessage { key, text }` → `eventKind "reaction"`, `body = text` (the emoji), `targetWaMessageId = key.id`, `targetFromMe = key.fromMe === true`. An empty `text` is dropped with a new reason `reaction_removed`.
  - `protocolMessage` type `REVOKE` → `eventKind "delete"`, `body = null`, `targetWaMessageId = protocolMessage.key.id`.
  - An edit (`protocolMessage` type `MESSAGE_EDIT` with `editedMessage`, or an `editedMessage` wrapper) → `eventKind "edit"`, `body = sanitizeBody(new text)`, target = the edited message id. An edit with no text (a caption-only edit with no caption) is dropped as `no_content`.
  - Other `protocolMessage` types and polls stay dropped as `edit_reaction_or_system`.
  - `messageType` for event rows is `"event"`. `mediaRef` is always null.
- **Quoted replies** (events on): for a text or media reply whose `contextInfo.quotedMessage` is present, the body becomes `renderQuotePrefix(quoted) + "\n" + text`, built with `export function renderQuotePrefix(quoted: proto.IMessage): string` (formats in Global Constraints). Truncation to 500 code points cuts the reply text, never the prefix. A media reply with no caption keeps `body = null` (media placeholders are unchanged).
- [ ] **Step 1: Write failing tests:**
  - each event at top level and inside `ephemeralMessage` and `viewOnceMessageV2`;
  - `reaction removed (empty text) dropped as reaction_removed`;
  - `reaction to our message sets targetFromMe true`;
  - `revoke → delete with target id`;
  - `edit via protocolMessage MESSAGE_EDIT` and `edit via editedMessage wrapper`;
  - `poll update still dropped`; `fromMe reaction still dropped`;
  - quote prefixes for text and for each media placeholder;
  - `quote prefix survives truncation` (a 500-code-point reply → body exactly 500 code points, starting with the prefix);
  - `events flag off: every event dropped as today` (the existing tests pass unedited).
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** Check Baileys' `proto.Message.ProtocolMessage.Type` for the REVOKE and MESSAGE_EDIT values.
- [ ] **Step 4: Run** `PATH=/root/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH npm test && npm run typecheck` in `services/whatsapp-bridge`. Expect PASS.
- [ ] **Step 5: Commit** `bridge: classify edits, reactions, deletes and quoted replies`.

### Task 3: App renders and suppresses events

**Files:**
- Modify: `src/lib/ghl-inbound.ts`, `src/lib/ghl.ts` (format constants), `src/lib/data/repository.ts` and `src/lib/data/supabase.ts` (`getInboundBodyByWaMessageId(tenantId: string, waMessageId: string): Promise<string | null>`)
- Test: `scripts/test/ghl-inbound.test.ts`, `scripts/test/repository-shape.test.ts`

**Interfaces:**
- `renderInboundEvent(row: WhatsappInboundMessage, originalBody: string | null): string`, a pure function exported from `ghl.ts`:
  - edit → `✏️ Edited: ` + body;
  - delete → `🗑 Deleted a message`;
  - reaction → `targetFromMe` ? `<emoji> reacted to your message` : originalBody ? `<emoji> reacted to "<first 80 code points>"` : `<emoji> reacted to a message`.
  - The result is capped at 500 code points.
- In `processGhlInboundRow`:
  - a reaction or delete on an account with `showReactions` / `showDeletes` false is claimed and resolved `event_suppressed`, with no post;
  - otherwise the body is `renderInboundEvent(...)`, looking up `originalBody` only for reactions with `targetFromMe` false;
  - the number prefix and the group sender label apply as for messages;
  - STOP keyword handling runs for plain messages and edits (on the edit's new text), never for reactions or deletes.
- [ ] **Step 1: Write failing tests:** each format (exact strings); `reaction suppressed by default`, `reaction posted when showReactions`, the same pair for deletes; `edits post by default`; `reaction to an expired message renders "reacted to a message"`; `edit to STOP opts out`; `reaction "STOP" is not a keyword` (the emoji field can't be STOP, but guard by event kind); `missed calls unchanged`.
- [ ] **Step 2: Run** `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `inbound: show edits, reactions and deletes in GHL`.

### Task 4: Embed toggles

**Files:**
- Create: `src/app/api/crm/embed/message-events/route.ts`, `src/app/api/crm/embed/message-events/logic.ts`, `src/app/embed/crm/MessageEventSettings.tsx`
- Modify: `src/app/embed/crm/CrmEmbedClient.tsx` (render the settings once per sub-account, not per number), `src/lib/data/repository.ts`, `src/lib/data/supabase.ts` (`setMessageEventSettings(locationId, { showReactions?: boolean; showDeletes?: boolean }): Promise<void>`, confirming the row exists first)
- Test: new `scripts/test/embed-message-events.test.ts`

**Interfaces:**
- `POST /api/crm/embed/message-events`. An empty body reads, and `{ showReactions?, showDeletes? }` writes. It returns `{ ok, showReactions, showDeletes }`. It is guarded by `authorizeGhlEmbedLocationRequest`, the same as `groups/invite-template/route.ts`. Copy that route's shape. Non-boolean values → 400 `invalid_body` "Malformed request.".
- UI: two switches with the exact labels and the warning line from Global Constraints, saved on change, and disabled while saving.
- [ ] **Step 1: Write failing tests:** read defaults false; write one leaves the other; a non-boolean → 400; one sub-account's settings never change another's; no tenant id in any response.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** Read the Next route-handler guide in `node_modules/next/dist/docs/` first.
- [ ] **Step 4: Run** `npm run check` and the production build (the README's placeholder env). Expect PASS.
- [ ] **Step 5: Commit** `embed: per-sub-account settings for reactions and deletes`.

### Task 5: Docs and checks

**Files:**
- Modify: `README.md` (add a short "Checking migrations locally" section: stub `auth.users` and `storage.buckets`, roles `anon`, `authenticated` and `service_role`, then apply every file with `ON_ERROR_STOP=1`), `services/whatsapp-bridge/README.md`, `docs/GO-LIVE-FOUNDATION.md` (migration 0011, the flag), the spec (mark it built; answer open question 3 "no" as implemented; note open question 1 is still open), `docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`, `docs/superpowers/specs/2026-10-17-voice-notes-real-device-check.md` (add event checks)
- [ ] **Step 1:** Add to the real-device check, with `WA_INBOUND_EVENTS_ENABLED=true`: from the contact's phone, quote one of our messages; edit a message; react; remove the reaction; delete for everyone; do each inside a disappearing-messages chat too. Record what GHL shows.
- [ ] **Step 2: Commit** `docs: message events`.

## Decisions during the build

- Quote prefixes apply to text replies only. A media reply keeps today's placeholder, because captions were never read into the body.
- Newlines in quoted text are collapsed to one space.
- A bare `editedMessage` wrapper without a `MESSAGE_EDIT` inside stays dropped. Baileys only emits that shape on `messages.update`. Real edits arrive as a `MESSAGE_EDIT` protocolMessage, bare or wrapped.
- Edits run the full keyword classifier: STOP opts out and START opts back in.
- Event rows (and missed calls) never count as "has messaged this number" for direct group adds.
- Settings are per sub-account, in the GHL embed, and off by default.
- Migration 0011 applies cleanly with 0001 to 0010 on Postgres 16.
- Open question 1 (a GHL internal comment that doesn't fire triggers) is still open. Reactions and deletes are therefore posted as messages only when switched on.
