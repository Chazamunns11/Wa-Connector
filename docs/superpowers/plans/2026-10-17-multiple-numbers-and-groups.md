# Multiple numbers and WhatsApp groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a GHL sub-account connect up to 3 WhatsApp numbers (one default, replies sticky per contact) and sync opted-in WhatsApp groups into GHL Conversations, including sending to them.

**Architecture:** One `whatsapp_tenants` row per number, so the bridge's per-tenant session, pacer, cap and warm-up apply per number unchanged. Numbers are addressed by **slot** (1-3) at every browser-facing surface; the server resolves slot → tenant, so no tenant id is ever client-supplied or returned. Groups are opt-in rows in `whatsapp_groups`; the bridge only accepts and sends group traffic for enabled groups, and the app maps each group to one synthetic GHL contact.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts`), Supabase (Postgres, service-role only), Baileys 7.0.0-rc14 bridge on Node 24, `node:test`.

**Specs:** `docs/superpowers/specs/2026-10-17-multiple-numbers-per-sub-account-design.md`, `docs/superpowers/specs/2026-10-17-whatsapp-groups-design.md`. Where this plan differs from a spec (slots instead of tenant ids at the browser), this plan wins and the spec is updated in Task 1.

## Global Constraints

- Every refusal shown in GHL is a fixed string (existing hard rule). New strings, verbatim:
  - `The WhatsApp number this contact uses is disconnected — reconnect it to reply`
  - `This sub-account already has 3 WhatsApp numbers.`
  - `WhatsApp group sync is turned off for this group`
  - `This WhatsApp number is no longer in that group`
- No tenant id in any request body, response body, URL or token a browser sees. Slots only.
- Bridge hard rule 3 holds: never send to a JID built by string concatenation. Group JIDs come only from Baileys' own group list, stored when the owner enabled the group, and must match `^[0-9]+(-[0-9]+)?@g\.us$`.
- RLS on, no policies, for every new table (service-role only).
- Bridge tests run on Node 24 (`services/whatsapp-bridge`, `npm test`); app checks are `npm run check` at the repo root.
- A group send costs **5** daily-cap units.
- Migrations: `supabase/migrations/0003_ghl_location_numbers.sql`, `0004_whatsapp_groups.sql`. Each is additive and runs after 0002.

## Review Focus

1. **A slot that doesn't exist yet** (slot 2 requested when only slot 1 exists) must 404 with the fixed embed message, never fall through to slot 1. Test in Task 4.
2. **Removing the default number** must promote the lowest remaining slot, and removing the only number must be refused. Test in Task 3.
3. **Inbound rows arriving out of order** must not move stickiness backwards. Test in Task 3.
4. **A group message from a group the owner never enabled** must never be stored, not even with `body = null`. Test in Task 7.
5. **A GHL "Send SMS" to a group contact whose group was disabled** must fail with the fixed string, not fall through to phone normalisation (the group contact has no phone and would otherwise be refused with a misleading reason). Test in Task 9.

---

### Task 1: Schema for numbers and stickiness

**Files:**
- Create: `supabase/migrations/0003_ghl_location_numbers.sql`
- Modify: `docs/superpowers/specs/2026-10-17-multiple-numbers-per-sub-account-design.md` (slots replace tenant ids at the browser)
- Modify: `docs/GO-LIVE-FOUNDATION.md` (migration list mentions 0003, 0004)

**Interfaces:**
- Produces tables:
  - `ghl_location_numbers(tenant_id uuid pk → whatsapp_tenants(id), location_id text not null → ghl_accounts(location_id) on delete cascade, slot smallint not null check (slot between 1 and 3), is_default boolean not null default false, label text null check (char_length(label) <= 40), created_at timestamptz default now())`, `unique (location_id, slot)`, unique partial index `(location_id) where is_default`.
  - `ghl_contact_numbers(location_id text → ghl_accounts on delete cascade, ghl_contact_id text, tenant_id uuid → whatsapp_tenants on delete cascade, last_inbound_at timestamptz not null, primary key (location_id, ghl_contact_id))`.
- Backfill: `insert into ghl_location_numbers (tenant_id, location_id, slot, is_default) select tenant_id, location_id, 1, true from ghl_accounts on conflict do nothing;`

- [ ] **Step 1:** Write the migration with comments in the style of `0001_init.sql` (why each column exists). Enable RLS on both tables.
- [ ] **Step 2:** Update the spec's UI and data sections to say slots, and add the slot column.
- [ ] **Step 3:** Commit `schema: ghl_location_numbers and ghl_contact_numbers`.

### Task 2: Repository methods for numbers

**Files:**
- Modify: `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/lib/types.ts`
- Test: `scripts/test/repository-shape.test.ts`, new `scripts/test/location-numbers.test.ts`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces (on `GhlRepository`):
  - `type LocationNumber = { tenantId: string; slot: 1 | 2 | 3; isDefault: boolean; label: string | null }` (server-only; never serialised to a browser)
  - `listLocationNumbers(locationId: string): Promise<LocationNumber[]>` ordered by slot
  - `getLocationNumberBySlot(locationId: string, slot: number): Promise<LocationNumber | null>`
  - `addLocationNumber(locationId: string, label: string | null): Promise<{ ok: true; number: LocationNumber } | { ok: false; reason: "limit" }>` creates the `whatsapp_tenants` row and the lowest free slot
  - `removeLocationNumber(locationId: string, slot: number): Promise<{ ok: true; removedTenantId: string } | { ok: false; reason: "last_number" | "not_found" }>`, promoting the lowest remaining slot to default when needed
  - `setDefaultLocationNumber(locationId: string, slot: number): Promise<boolean>`
  - `getStickyTenant(locationId: string, ghlContactId: string): Promise<string | null>`
  - `recordInboundForStickiness(locationId: string, ghlContactId: string, tenantId: string, receivedAtIso: string): Promise<void>`, an upsert that only overwrites when `receivedAtIso` is newer
  - `getGhlAccountByTenantId` now resolves through `ghl_location_numbers` (any slot), so inbound rows from any number find their location. Signature unchanged.

- [ ] **Step 1: Failing tests** in `location-numbers.test.ts` for the pure helpers this task adds to `src/lib/location-numbers.ts`: `nextFreeSlot(slots: number[]): 1 | 2 | 3 | null` (`[]→1`, `[1,3]→2`, `[1,2,3]→null`) and `promoteAfterRemoval(numbers, removedSlot): number | null` (removing the default slot 1 from `[1,2,3]` → `2`; removing non-default → `null`; removing the only one → throws or is refused by caller).
- [ ] **Step 2:** Run `npm test`; expect failures for missing exports.
- [ ] **Step 3:** Implement the helpers and the repository methods. Supabase methods follow the existing `mapGhlAccount` / service-role style. `addLocationNumber` uses `nextFreeSlot`; the `unique (location_id, slot)` constraint is the race backstop (on conflict, return `limit` after one retry).
- [ ] **Step 4:** Add the new method names to `METHODS` in `repository-shape.test.ts`. Run `npm run check`; expect pass.
- [ ] **Step 5:** Commit `data: location numbers and per-contact stickiness`.

### Task 3: Outbound picks the number; inbound records stickiness

**Files:**
- Create: `src/lib/sending-number.ts`
- Modify: `src/lib/ghl-provider.ts` (`handleProviderOutboundMessage`), `src/lib/ghl-inbound.ts` (after a successful push)
- Test: new `scripts/test/sending-number.test.ts`, extend `scripts/test/ghl-inbound.test.ts`

**Interfaces:**
- Consumes: Task 2 methods.
- Produces: `resolveSendingTenant(deps: { getStickyTenant; listLocationNumbers }, locationId: string, ghlContactId: string): Promise<{ tenantId: string; slot: number; label: string | null; multi: boolean }>`. Sticky if the sticky tenant is still one of the location's numbers, else the default.

- [ ] **Step 1: Failing tests:**
  - `resolveSendingTenant`: sticky beats default; a sticky tenant that's no longer a number falls back to default; no sticky row → default; `multi` is true only with >1 number.
  - Provider: when the resolved number's bridge session is not `connected`, the outbound is refused with exactly `The WhatsApp number this contact uses is disconnected — reconnect it to reply` and no send is attempted (no fallback to another number).
  - Inbound: after a successful push, `recordInboundForStickiness` is called with the row's tenant and `received_at`. An older row does not overwrite a newer one (Review Focus 3, tested at the repository layer with a fake that applies the "only if newer" rule, plus a SQL comment pinning the `where` clause).
  - Inbound prefix: with `multi`, the GHL body starts `[<label or "Number <slot>">] `; with one number, no prefix.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement. In `handleProviderOutboundMessage`, resolve the tenant before `recordGhlOutboundMessage` and pass it as `tenantId`; everything downstream already uses `row.tenantId`. The disconnected check reuses `deps.getSession` (already used by `hasSufficientOutboundBudget`).
- [ ] **Step 4:** `npm run check`; expect pass.
- [ ] **Step 5:** Commit `provider: default plus sticky sending number`.

### Task 4: Slot-aware embed and connect-link routes

**Files:**
- Modify: `src/lib/bridge-panel-guard.ts`, `src/app/api/crm/embed/guard.ts`, `src/app/api/connect/guard.ts`, the six `whatsapp/{connect,status,logout}/route.ts` files under `src/app/api/crm/embed/` and `src/app/api/connect/`, `src/app/api/crm/embed/session/route.ts`, `src/lib/ghl-connect-link.ts`
- Create: `src/app/api/crm/embed/numbers/route.ts` (POST add, DELETE remove, PATCH make default / label)
- Test: `scripts/test/ghl-embed.test.ts`, `scripts/test/ghl-connect-link.test.ts`, new `scripts/test/embed-numbers.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - Guards accept an optional `slot` (request JSON body `{ slot?: number }`, default 1) and resolve `account.tenantId` via `getLocationNumberBySlot`. A missing slot → 404 `{ code: "unknown_number", message: "That WhatsApp number isn't set up on this sub-account." }`.
  - Session route response gains `numbers: { slot, label, isDefault, summary }[]`, with no tenant ids.
  - Connect-link token data becomes `{ locationId, v, s?: 1|2|3 }`; a token without `s` means slot 1, so existing links keep working.

- [ ] **Step 1: Failing tests:** slot 2 when only slot 1 exists → 404 `unknown_number` (Review Focus 1); slot 0, 4 and `"1"` (a string) → 400; existing slot-less calls still resolve slot 1; no response body contains a tenant id (search the serialised JSON for the fake tenant uuid); add → `limit` gives the fixed `This sub-account already has 3 WhatsApp numbers.`; removing the last number is refused; a legacy connect-link token with no `s` verifies as slot 1.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement. Removing a number calls the bridge logout for that tenant first, then `removeLocationNumber`.
- [ ] **Step 4:** `npm run check`; expect pass.
- [ ] **Step 5:** Commit `embed: numbers addressed by slot`.

### Task 5: Numbers UI in the embed, connect page and admin

**Files:**
- Modify: `src/app/embed/crm/CrmEmbedClient.tsx`, `src/app/connect/[token]/ConnectLinkClient.tsx`, `src/components/owner/GhlAccountsPanel.tsx`
- Test: `npx next build` with placeholder env (as in README) plus a manual run of `/embed/crm` is not possible without GHL; rely on the route tests from Task 4 and a production build.

**Interfaces:**
- Consumes: Task 4's `numbers` array and `slot` parameter. `WhatsappConnectionPanel` is unchanged: each number renders one panel whose `connect`/`poll`/`logout` closures post `{ slot }`.

- [ ] **Step 1:** Embed: one panel per number with its label and a "Default" chip; "Make default", "Rename" (≤40 chars) and "Remove" (with an in-page confirm, never `confirm()`); "Add a number" while fewer than 3.
- [ ] **Step 2:** Connect page: shows the number named by the link's slot ("Connect WhatsApp: Sales line").
- [ ] **Step 3:** Admin panel: shows each location's number count and per-slot status; "Copy connect link" per slot.
- [ ] **Step 4:** `npm run check` and the production build; expect pass.
- [ ] **Step 5:** Commit `ui: several numbers per sub-account`.

### Task 6: Schema for groups

**Files:**
- Create: `supabase/migrations/0004_whatsapp_groups.sql`

**Interfaces:**
- Produces: `whatsapp_groups(id uuid pk, tenant_id uuid not null → whatsapp_tenants on delete cascade, group_jid text not null check (group_jid ~ '^[0-9]+(-[0-9]+)?@g\.us$'), name text not null check (char_length(name) <= 100), enabled boolean not null default false, ghl_contact_id text null, left_at timestamptz null, created_at, updated_at, unique (tenant_id, group_jid))`; `whatsapp_inbound_messages` gains `group_jid text null` and `sender_name text null check (char_length(sender_name) <= 60)`.

- [ ] **Step 1:** Write the migration (RLS on, comments on why opt-in).
- [ ] **Step 2:** Commit `schema: whatsapp_groups`.

### Task 7: Bridge group list, inbound and outbound

**Files:**
- Create: `services/whatsapp-bridge/src/groups.ts`
- Modify: `services/whatsapp-bridge/src/inbound.ts`, `src/sessions.ts`, `src/server.ts`, `src/store.ts`
- Test: new `services/whatsapp-bridge/test/groups.test.ts`, extend `test/inbound.test.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: Task 6 tables.
- Produces:
  - `isGroupJid(jid: string): boolean` (the regex above).
  - Routes (authenticated as today): `GET /sessions/:id/groups` → `{ groups: { jid, name, size }[] }` from `sock.groupFetchAllParticipating()`; `POST /sessions/:id/groups/refresh` reloads the enabled set from `whatsapp_groups`.
  - `classifyInboundMessage` gains an `enabledGroups: ReadonlySet<string>` input: a group JID is accepted only when in the set, and the result carries `groupJid` and `senderName` (`msg.pushName`, trimmed to 60). The sender's E.164 comes from `key.participant` / `participantAlt` through the existing `resolveSenderE164` rules.
  - `POST /sessions/:id/send` accepts exactly one of `to` (E.164) or `groupJid`. `groupJid` must pass `isGroupJid` and be in the enabled set, else 400 `group_not_enabled`. For groups the existence check is replaced by `sock.groupMetadata(jid)` containing our own JID; if not, the row fails with `This WhatsApp number is no longer in that group`, not dispatched. A group send reserves and records **5** cap units.
- [ ] **Step 1: Failing tests:** a message from a group not in the set is dropped with reason `group_not_enabled` and never reaches the store (Review Focus 4); an enabled group's message is stored with `groupJid` and `senderName`; `isGroupJid` accepts `120363418570879210@g.us` and `447700900123-1612345678@g.us` and rejects `447700900123@s.whatsapp.net`, `@g.us`, `abc@g.us`; send with both `to` and `groupJid` → 400; group send consumes 5 units (pacer `recordSend(units)` gains an optional `units` parameter, default 1); a non-participant send fails as not dispatched with the fixed string.
- [ ] **Step 2:** Run on Node 24; expect failures.
- [ ] **Step 3:** Implement. Typing simulation applies to group text sends too.
- [ ] **Step 4:** `npm test` and `npm run typecheck` in the bridge; expect pass.
- [ ] **Step 5:** Commit `bridge: opt-in WhatsApp groups`.

### Task 8: App data and inbound push for groups

**Files:**
- Modify: `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/lib/ghl.ts`, `src/lib/ghl-inbound.ts`, `src/lib/whatsapp-bridge.ts`
- Test: `scripts/test/ghl-inbound.test.ts`, `scripts/test/repository-shape.test.ts`, `scripts/test/ghl.test.ts`

**Interfaces:**
- Produces:
  - Repo: `listWhatsappGroups(tenantId)`, `setWhatsappGroupEnabled(tenantId, groupJid, name, enabled)`, `getWhatsappGroupByContact(locationId, ghlContactId): Promise<{ tenantId; groupJid; enabled } | null>`, `setWhatsappGroupContact(tenantId, groupJid, ghlContactId)`.
  - `upsertGhlGroupContact(accessToken, locationId, input: { name: string; groupKey: string }): Promise<UpsertGhlContactResult>`: name `<group name> (WhatsApp group)`, tag `whatsapp-group`, no phone, placeholder email `group-<groupKey>@groups.pingwren.invalid` where `groupKey` is the JID's digits. The email is there because GHL may refuse a contact with neither phone nor email; confirm against GHL during this task and drop the email if not needed.
  - Bridge client: `listWhatsappGroups(coachId)`, `refreshWhatsappGroups(coachId)`, and `sendWhatsappMessage` accepts `groupJid` instead of `to`.
- [ ] **Step 1: Failing tests:** a group inbound row with no `ghl_contact_id` creates the group contact once and stores it; a second row reuses it; the posted body is `<sender name>: <text>`, falling back to the sender's number; media rows use the existing media path with the same prefix; a group row never calls `upsertGhlContact` for the sender (senders aren't contacts).
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm run check`; expect pass.
- [ ] **Step 5:** Commit `inbound: WhatsApp groups into GHL Conversations`.

### Task 9: Outbound to groups and the groups UI

**Files:**
- Modify: `src/lib/ghl-provider.ts`, `src/app/embed/crm/CrmEmbedClient.tsx`
- Create: `src/app/api/crm/embed/groups/route.ts` (GET list with enabled flags for a slot; POST enable/disable)
- Test: `scripts/test/ghl-provider.test.ts` (or the existing provider test file), new `scripts/test/embed-groups.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 7, 8.
- Produces: in `handleProviderOutboundMessage`, before phone normalisation, `getWhatsappGroupByContact(locationId, contactId)`; if found and enabled, send with `groupJid` on that group's tenant; if found and disabled, refuse with `WhatsApp group sync is turned off for this group` (Review Focus 5).
- [ ] **Step 1: Failing tests:** group contact routes to `groupJid` on the group's own tenant (not the sticky or default number); a disabled group refuses with the fixed string and no send; the groups route lists a slot's groups and never returns a tenant id; enabling a group calls `refreshWhatsappGroups` for that tenant.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement. Embed: a "Groups" section per number listing groups (name, member count) with a toggle each; the first enable shows "Group contacts are tagged whatsapp-group. Exclude that tag from bulk SMS workflows."
- [ ] **Step 4:** `npm run check`, bridge `npm test`, production build; expect pass.
- [ ] **Step 5:** Commit `groups: send from GHL and pick groups to sync`.

### Task 10: Docs

**Files:**
- Modify: `README.md`, `services/whatsapp-bridge/README.md`, `docs/GO-LIVE-FOUNDATION.md`, `docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`

- [ ] **Step 1:** Document migrations 0003 and 0004, the new bridge routes, the 5-unit group cost, and mark B and E as built in the roadmap.
- [ ] **Step 2:** Commit `docs: several numbers and groups`.
