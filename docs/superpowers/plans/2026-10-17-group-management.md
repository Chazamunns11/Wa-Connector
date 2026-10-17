# Create and manage WhatsApp groups from GHL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the in-GHL page, a coach can create a WhatsApp group on any connected number, invite contacts (picked, or by GHL tag) with an editable invite message, and manage groups the number is an admin of: rename, settings, members, invite link, leave.

**Architecture:** The bridge gets authenticated group-management routes. A new `src/group-management.ts` holds the Baileys calls and safety rules. A per-session `GroupActionLimits` counter (`src/group-limits.ts`) is seeded from the new `whatsapp_group_actions` table, the same way the pacer is seeded from the ledger, and enforces the daily create/add limits and the warm-up refusal at the transport. The app adds a slot-guarded `groups/manage` embed route. Invites are **normal outbound sends**: each one is recorded in `ghl_outbound_messages` on the group's own number and goes through the same intake as a GHL message (billing gate, location-wide STOP check, hold-when-offline, pacing, typing, daily cap). Only the GHL status report is skipped, because there is no GHL message to report on.

**Tech Stack:** Next.js 16 (App Router), Supabase (service-role only), Baileys 7.0.0-rc14 bridge on Node 24, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-17-group-creation-and-management-design.md` (its Decisions log wins over the rest of the spec). It builds on `docs/superpowers/plans/2026-10-17-multiple-numbers-and-groups.md`. Workflow actions (spec "phase 2") are **out of scope**.

## Global Constraints

- Fixed strings, verbatim (shown in GHL as-is):
  - `Add at least one person who has messaged this number before, then invite the rest by link.`
  - `This number has created its 3 groups for today. Try again tomorrow.`
  - `This number has reached today's limit for adding people. Invite the rest by link.`
  - `The invite message must include {link}.`
  - `New numbers can't create groups during their first 14 days.`
  - `This number isn't an admin of that group.`
  - `You can't remove the group's last admin.`
- Default invite message: `Hi {first_name}, {coach_name} invited you to join {group_name} on WhatsApp: {link}`. Placeholders `{first_name}`, `{group_name}`, `{coach_name}` and a required `{link}`. Template up to **500** characters, stored **per sub-account** in `ghl_accounts.group_invite_template text null` (Charlie, 17 Oct: each sub-account has its own wording, edited inside GHL).
- Limits per number per day (UTC day, like the pacer): **3** groups created (`WA_GROUP_CREATE_DAILY`, default 3) and **50** direct adds (`WA_GROUP_ADD_DAILY`, default 50). Invite messages count as normal sends against the daily cap (1 unit each).
- Create: **try `groupCreate(subject, [])` first**. If WhatsApp refuses, retry with the first contact eligible for a direct add. If there is none, refuse with the first fixed string.
- **Invite link by default.** Direct add only for a contact who has **messaged that number before** (a non-group row for them in `whatsapp_inbound_messages` on that tenant). If WhatsApp refuses the add (privacy), fall back to the invite link.
- Warm-up (`WA_WARMUP_ENABLED`, first 14 days): group creation and direct adds are refused.
- Management only for groups where our number is an admin; the buttons don't show otherwise. Never remove the coach's own number. Never remove (or demote) the last admin.
- Names up to **100** characters, descriptions up to **512**. Both are checked in code points (`[...s].length`), matching Postgres `char_length`.
- Bridge routes: only for a connected session. Each one validates the group JID with `isGroupJid` and refuses a group that isn't enabled for this tenant (except create). Participants go through `onWhatsApp` and use the JID WhatsApp returns (hard rule 3). The invite link is `https://chat.whatsapp.com/<code>`.
- **Never logged:** group names, descriptions, invite codes or links, member numbers, member ids. Tenant ids, message ids and error *names* only (same rule as `src/groups.ts`).
- No tenant id in any browser-facing request or response. Slots only (existing hard rule).
- Migration `supabase/migrations/0009_group_management.sql` (the next free number after 0008), additive, RLS on and no policies for the new table.
- App checks: `npm run check` at the repo root. Bridge: `PATH=/root/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH npm test` and `npm run typecheck` in `services/whatsapp-bridge`.
- Another stream is editing billing code and site copy. Don't change `Account`/`sendingGate` shapes. Add new repo methods rather than widening `Account`.

## Review Focus

1. **A contact who replied STOP (on any of the location's numbers) is picked, or carries the tag.** They must get no invite, must not be direct-added, and must not be used as the create fallback member. Direct adds don't go through the outbound pipeline, so the STOP check has to be explicit there. Tests in Tasks 6 and 7.
2. **A double-clicked or retried "Create"** (the embed request timed out after WhatsApp had already made the group) must not create two groups or use two of the 3 daily creates. Test in Task 3 (`requestId` replay).
3. **Members WhatsApp lists only by LID** (Baileys 7 often has no phone number for them) must still be removable and promotable. Members are addressed by the `memberId` the detail route returned, never by a JID built from a phone number. Test in Task 3.
4. **A tag that pulls in group contacts (`whatsapp-group` tag, no phone), contacts with no phone, and two contacts sharing one phone.** These are skipped or deduplicated and reported as skipped. Nothing ever sends an invite to a group contact. Test in Task 7.
5. **The number is offline when the invites go out, or drops part-way through a batch.** Those invites are *held* and released on reconnect like any send (with STOP re-checked on release), and reported to the coach as "held", not "failed". Test in Task 6.

---

### Task 1: Schema 0009

**Files:**
- Create: `supabase/migrations/0009_group_management.sql`
- Test: `scripts/test/group-management-schema.test.ts` (same style as `scripts/test/reliability-schema.test.ts`)

**Interfaces:**
- Produces:
  - `alter table public.whatsapp_groups add column created_by_us boolean not null default false;`
  - `create index whatsapp_groups_ghl_contact_idx on public.whatsapp_groups (ghl_contact_id) where ghl_contact_id is not null;` (backs `getWhatsappGroupByContact`, deferred from the last review).
  - `whatsapp_group_actions(id uuid pk default gen_random_uuid(), tenant_id uuid not null references public.whatsapp_tenants (id) on delete cascade, group_jid text null check (group_jid is null or group_jid ~ '^[0-9]+(-[0-9]+)?@g\.us$'), action text not null check (action in ('create','add','remove','promote','demote','update','invite_reset','leave')), count int not null check (count between 1 and 50), created_at timestamptz not null default now())`, plus `create index whatsapp_group_actions_tenant_created_idx on public.whatsapp_group_actions (tenant_id, created_at)`. RLS on, no policies. Only `create`/`add` rows count towards limits. The rest is an audit trail for a later owner view.
  - `alter table public.ghl_accounts add column group_invite_template text check (group_invite_template is null or (char_length(group_invite_template) between 1 and 500 and strpos(group_invite_template, '{link}') > 0));` (per sub-account; `ghl_accounts` is defined in `0001_init.sql`).
- [ ] **Step 1: Write the failing schema test.** Assert each statement above by regex, plus `enable row level security` and `assert.doesNotMatch(sql, /create policy/)`.
- [ ] **Step 2: Run** `npm test`. Expect FAIL (file missing).
- [ ] **Step 3: Write the migration**, with comments in the style of `0007_whatsapp_groups.sql` explaining why each column exists.
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `schema: group management (0009)`.

### Task 2: Bridge limits, warm-up and store reads

**Files:**
- Create: `services/whatsapp-bridge/src/group-limits.ts`
- Modify: `services/whatsapp-bridge/src/pacing.ts` (`isInWarmup`), `services/whatsapp-bridge/src/store.ts`, `services/whatsapp-bridge/src/config.ts`, `services/whatsapp-bridge/.env.example`
- Test: new `services/whatsapp-bridge/test/group-limits.test.ts`, `services/whatsapp-bridge/test/pacing.test.ts`, `services/whatsapp-bridge/test/config.test.ts`

**Interfaces:**
- Consumes: Task 1 table.
- Produces:
  - `SessionPacer.isInWarmup(): boolean`: `linkedAtMs !== null && warmupCapForAgeDays(age) !== null`. This is only ever true with `WA_WARMUP_ENABLED`, because `setLinkedAt` is only called then.
  - `BridgeConfig.groupCreateDaily` ← `intWithDefault("WA_GROUP_CREATE_DAILY", 3)`, and `groupAddDaily` ← `intWithDefault("WA_GROUP_ADD_DAILY", 50)`.
  - Store: `countGroupActionsToday(tenantId: string): Promise<{ creates: number; adds: number }>` (sums `count` since UTC midnight for `create`/`add`); `recordGroupAction(tenantId: string, action: GroupActionKind, count: number, groupJid: string | null): Promise<void>`; `hasInboundFromPhone(tenantId: string, phoneE164: string): Promise<boolean>` (`coach_id = tenantId and from_phone = phone and group_jid is null`, limit 1).
  - `class GroupActionLimits { constructor(store: Pick<BridgeStore, "countGroupActionsToday" | "recordGroupAction">, limits: { createDaily: number; addDaily: number }, now?: () => number); reserveCreate(tenantId: string): Promise<"ok" | "limit" | "unavailable">; reserveAdds(tenantId: string, wanted: number, groupJid: string): Promise<{ granted: number } | { unavailable: true }> }`. It seeds lazily from `countGroupActionsToday` on first use and after a UTC day roll. It writes the `whatsapp_group_actions` row **before** granting, so an attempt counts even if Baileys then fails (same "count the attempt" rule as the pacer). A failed seed or write returns `unavailable` (fail closed).
- [ ] **Step 1: Write failing tests** in `group-limits.test.ts`, with a fake store:
  - `limits: the 4th create of the day is refused`: three `reserveCreate` → `"ok"`, the fourth → `"limit"`.
  - `limits: adds are granted up to 50 then partially`: `reserveAdds(t, 48)` → 48, then `reserveAdds(t, 5)` → 2, then → 0.
  - `limits: survive a restart`: a fresh `GroupActionLimits` whose store reports `{ creates: 3, adds: 50 }` → `"limit"` and `{ granted: 0 }`.
  - `limits: roll at UTC midnight`: with an injected `now` crossing midnight, a reseed happens and creates are allowed again.
  - `limits: a failed record write refuses rather than grants`.
  - In `pacing.test.ts`: `isInWarmup` is false with no `setLinkedAt`, true at 13.9 days, false at 14.
  - In `config.test.ts`: defaults 3 and 50.
- [ ] **Step 2: Run** the bridge tests. Expect FAIL.
- [ ] **Step 3: Implement.** Add both vars to `.env.example` next to `WA_DAILY_CAP`, with a one-line note on why they exist (mass creates and adds are ban triggers).
- [ ] **Step 4: Run** the bridge tests and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `bridge: daily group create/add limits and warm-up check`.

### Task 3: Bridge group-management operations

**Files:**
- Create: `services/whatsapp-bridge/src/group-management.ts`
- Modify: `services/whatsapp-bridge/src/sessions.ts` (`Session.groupLimits`, built in `doStartSession` beside `mediaAbuseGate`, and the public methods below), `services/whatsapp-bridge/src/groups.ts` (fixed strings, `toMemberView`)
- Test: new `services/whatsapp-bridge/test/group-management.test.ts` (reusing `test/groups.test.ts`'s harness pattern: a fake session in the manager's private map and a fake socket)

**Interfaces:**
- Consumes: Task 2; `isGroupJid`, `isOwnNumberAParticipant`, `checkGroupMembership` from `src/groups.ts`.
- Produces:
  - Constants in `groups.ts`: the seven fixed strings from Global Constraints as `GROUP_NEEDS_MEMBER_REASON`, `GROUP_CREATE_LIMIT_REASON` (built from `config.groupCreateDaily`, so it reads verbatim at the default 3), `GROUP_ADD_LIMIT_REASON`, `GROUP_WARMUP_REASON`, `GROUP_NOT_ADMIN_REASON`, `GROUP_LAST_ADMIN_REASON`, plus `GROUP_SELF_REMOVAL_REASON = "You can't remove this WhatsApp number from the group. Use Leave instead."` (not in the spec, see the handback).
  - `MEMBER_ID_RE = /^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/`.
  - `type MemberView = { memberId: string; phone: string | null; admin: "admin" | "superadmin" | null; isUs: boolean }`.
  - `type GroupDetail = { jid: string; name: string; description: string | null; announcement: boolean; approval: boolean; weAreAdmin: boolean; members: MemberView[] }`.
  - `type ParticipantResult = { phone?: string; memberId?: string; result: "ok" | "invite_required" | "not_eligible" | "not_on_whatsapp" | "already_member" | "limit_reached" | "warmup" | "self" | "last_admin" | "not_member" | "failed" }`.
  - `type GroupOpOutcome<T> = { kind: "ok"; value: T } | { kind: "session_not_connected" } | { kind: "group_not_enabled" } | { kind: "refused"; code: "create_limit" | "add_limit" | "warmup" | "needs_member" | "not_admin" | "limits_unavailable"; message: string } | { kind: "failed" }`.
  - SessionManager:
    - `createGroup(coachId, input: { requestId: string; name: string; description?: string; participants: string[] /* E.164 fallback candidates */ }): Promise<GroupOpOutcome<{ jid: string; name: string; addedPhone: string | null; path: "empty" | "with_member" }>>`. Order: warm-up → `reserveCreate` → `groupCreate(name, [])`. If that throws, take the first `participants` entry passing `hasInboundFromPhone` and `onWhatsApp`, then `reserveAdds(1)` → `groupCreate(name, [jid])`, or refuse with `needs_member`. Then `groupUpdateDescription` when a description is given. Then add the new JID to `session.enabledGroups`, so management works before the app's refresh lands. A `requestId` seen in the last 10 minutes on this session returns the first call's outcome (Review Focus 2).
    - `getGroupDetail(coachId, jid): Promise<GroupOpOutcome<GroupDetail>>`.
    - `updateGroup(coachId, jid, patch: { name?: string; description?: string; announcement?: boolean; approval?: boolean })` → admin check, then `groupUpdateSubject` / `groupUpdateDescription` / `groupSettingUpdate("announcement" | "not_announcement")` / `groupJoinApprovalMode("on" | "off")`.
    - `updateGroupParticipants(coachId, jid, req: { action: "add"; phones: string[] } | { action: "remove" | "promote" | "demote"; memberIds: string[] }): Promise<GroupOpOutcome<ParticipantResult[]>>`, at most 50 per call. For adds: per phone, `hasInboundFromPhone` (else `not_eligible`) → `onWhatsApp` → warm-up (`warmup`) → `reserveAdds` (`limit_reached` beyond the grant) → `groupParticipantsUpdate`. Status `"403"` maps to `invite_required`, `"409"` to `already_member`, `"200"` to `ok`, anything else to `failed`. Remove/promote/demote targets must be in the current `groupMetadata` participants by exact `memberId` (else `not_member`). Our own identity → `self` for remove. A demote that would leave zero admins → `last_admin`.
    - `getGroupInviteLink(coachId, jid)` / `resetGroupInviteLink(coachId, jid)` → `GroupOpOutcome<{ link: string }>`, with an admin check.
    - `leaveGroup(coachId, jid)` → `groupLeave`, then remove the JID from `session.enabledGroups`.
    - Every op except create: `isGroupJid(jid) && session.enabledGroups.has(jid)`, else `group_not_enabled`. Every mutating op except leave: admin check from fresh `groupMetadata` (`not_admin`). Every op writes a `whatsapp_group_actions` row (create/add rows through `GroupActionLimits`).
- [ ] **Step 1: Write failing tests** in `group-management.test.ts`:
  - `create: an empty create succeeds and uses no add`: `groupCreate` called with `[]`, `path: "empty"`, the fake store's add total stays 0.
  - `create: empty refused, falls back to the first eligible contact`: `groupCreate` throws once. `participants: [a, b]`, with only `b` having inbound → the second `groupCreate` gets `b`'s `onWhatsApp` JID, `addedPhone === b`, `path: "with_member"`.
  - `create: empty refused, nobody eligible`: `refused` with the message exactly `Add at least one person who has messaged this number before, then invite the rest by link.`
  - `create: the 4th of the day`: the message is exactly `This number has created its 3 groups for today. Try again tomorrow.`, and `groupCreate` is not called.
  - `create: warm-up refuses before anything is counted`: `pacer.setLinkedAt(Date.now())` → `New numbers can't create groups during their first 14 days.`, no `whatsapp_group_actions` write.
  - `create: the same requestId twice makes one group` (Review Focus 2): `groupCreate` call count 1, both outcomes equal.
  - `add: a privacy refusal comes back as invite_required`: the fake returns `[{ status: "403", jid }]`.
  - `add: a phone with no inbound row is not_eligible and never reaches onWhatsApp`.
  - `add: past the daily grant the rest are limit_reached`.
  - `remove: a LID-only member is removed by memberId` (Review Focus 3): metadata participant `{ id: "123456789012345@lid" }` → `groupParticipantsUpdate(jid, ["123456789012345@lid"], "remove")`.
  - `remove: a memberId not in the group is not_member and nothing is sent`.
  - `remove: our own number is refused as self`. `demote: the only admin demoting themselves is last_admin`.
  - `update: not an admin` → message exactly `This number isn't an admin of that group.`, no Baileys mutation.
  - `every op: a disabled or malformed JID is group_not_enabled` (loop over the ops with `"abc@g.us"` and an enabled-set miss).
  - `invite link: returns https://chat.whatsapp.com/<code>`.
  - `logs: no name, description, link, phone or memberId reaches the logger`: a capturing pino stream over a full create+add+invite run → assert none of the fixture strings appear.
- [ ] **Step 2: Run** the bridge tests. Expect FAIL.
- [ ] **Step 3: Implement.** Keep Baileys calls and rules in `group-management.ts`, taking a narrow socket interface so tests fake it. SessionManager methods only resolve the session and delegate. Any other Baileys throw → `{ kind: "failed" }`, logging only `err.name`. A failed create still counts against the day's creates, because the attempt reached WhatsApp.
- [ ] **Step 4: Run** the bridge tests and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `bridge: create and manage groups`.

### Task 4: Bridge routes

**Files:**
- Create: `services/whatsapp-bridge/src/group-routes.ts` (`handleGroupManagementRoute(req, res, parts, manager): Promise<boolean>`; `true` means handled), so `server.ts` stays a router
- Modify: `services/whatsapp-bridge/src/server.ts` (call it before the final 404; add the routes to the file-header contract)
- Test: new `services/whatsapp-bridge/test/group-routes.test.ts` (a fake manager, the same pattern as `test/server.test.ts`)

**Interfaces:**
- Consumes: Task 3 manager methods.
- Produces (all bearer-authenticated, `:jid` URL-decoded then `isGroupJid`-checked before the manager is called):
  - `POST /sessions/:id/groups` `{ requestId, name, description?, participants }` → 200 `{ ok, jid, name, addedPhone, path }`
  - `GET /sessions/:id/groups/:jid` → `{ ok, group: GroupDetail }`
  - `PATCH /sessions/:id/groups/:jid` `{ name?, description?, announcement?, approval? }` (at least one field)
  - `POST /sessions/:id/groups/:jid/participants` `{ action, phones | memberIds }` → `{ ok, results: ParticipantResult[] }`
  - `GET /sessions/:id/groups/:jid/invite`, `POST /sessions/:id/groups/:jid/invite/reset` → `{ ok, link }`
  - `POST /sessions/:id/groups/:jid/leave` → `{ ok }`
  - Errors: 400 `invalid_body` / `invalid_group_jid`, 400 `group_not_enabled`, 409 `session_not_connected`, 403 `not_admin`, 422 `create_limit` | `add_limit` | `warmup` | `needs_member` with the fixed string as `message`, 503 `limits_unavailable`, 502 `group_action_failed`.
- [ ] **Step 1: Write failing tests:** a malformed `:jid` (`"abc"`, `"447700900123@s.whatsapp.net"`, a percent-encoded `../`) → 400 `invalid_group_jid`, manager never called. Name of 101 code points or empty after trim → 400. Description of 513 → 400. `participants` with a non-E.164 entry → 400. `memberIds` with an entry failing `MEMBER_ID_RE` → 400. Both `phones` and `memberIds` → 400. More than 50 → 400. Each refused outcome maps to its status and code with the manager's fixed message passed through unchanged. No auth → 401. `POST /sessions/:id/groups/refresh` still reaches `refreshEnabledGroups` (no route shadowing).
- [ ] **Step 2: Run**. Expect FAIL.
- [ ] **Step 3: Implement.** Body validation lives here. The manager trusts its inputs.
- [ ] **Step 4: Run** the bridge tests and typecheck. Expect PASS. Add the routes table to `services/whatsapp-bridge/README.md` under "Routes added for groups".
- [ ] **Step 5: Commit** `bridge: group management routes`.

### Task 5: App data and bridge client

**Files:**
- Modify: `src/lib/types.ts` (`WhatsappGroup.createdByUs: boolean`), `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/lib/whatsapp-bridge.ts`
- Test: `scripts/test/repository-shape.test.ts`, new `scripts/test/whatsapp-bridge-groups.test.ts`

**Interfaces:**
- Consumes: Task 1 columns, Task 4 routes.
- Produces:
  - Repo: `recordCreatedWhatsappGroup(tenantId: string, groupJid: string, name: string): Promise<void>` (upsert `enabled = true, created_by_us = true, left_at = null`); `renameWhatsappGroup(tenantId: string, groupJid: string, name: string): Promise<void>`; `getGroupInviteTemplate(locationId: string): Promise<string | null>`; `setGroupInviteTemplate(locationId: string, template: string | null): Promise<void>`; `hasInboundFromPhone(tenantId: string, phoneE164: string): Promise<boolean>` (the same query as the bridge's, used to label contacts "can be added directly" in the UI). `listWhatsappGroups` maps `created_by_us`.
  - Bridge client functions (same `bridgeFetch` / validator style as `listWhatsappGroups`): `createWhatsappGroup(coachId, input)`, `getWhatsappGroupDetail(coachId, jid)`, `updateWhatsappGroup(coachId, jid, patch)`, `updateWhatsappGroupParticipants(coachId, jid, req)`, `getWhatsappGroupInvite(coachId, jid)`, `resetWhatsappGroupInvite(coachId, jid)`, `leaveWhatsappGroup(coachId, jid)`. Types `BridgeGroupDetail`, `BridgeMemberView`, `BridgeParticipantResult` mirror Task 3. Exported pure validators `isValidGroupDetail(v): v is BridgeGroupDetail` and `isValidInviteLink(v): v is string` (must match `^https://chat\.whatsapp\.com/[A-Za-z0-9]{10,32}$`). The JID is `encodeURIComponent`'d into the path.
- [ ] **Step 1: Write failing tests:** the new method names are in `METHODS` of `repository-shape.test.ts`. `isValidGroupDetail` rejects a member without `memberId` or with `admin: "owner"`. `isValidInviteLink` rejects `http://chat.whatsapp.com/x` and `https://evil.example/abc`.
- [ ] **Step 2: Run** `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `data: group management repo methods and bridge client`.

### Task 6: Invites as normal outbound sends (STOP, hold, pacing)

**Files:**
- Modify: `src/lib/ghl-provider.ts`
- Test: `scripts/test/ghl.test.ts` (provider tests live here), `scripts/test/ghl-held.test.ts`

**Interfaces:**
- Consumes: the existing `optedOutReason`, `sendingGate`, `holdBehindHeldRows`, `resolveNotConnected`, `groupSendingNumber`, `reportGhlOutcome`.
- Produces:
  - `APP_MESSAGE_ID_PREFIX = "pwapp_"` and `isAppOriginatedMessageId(id: string): boolean`.
  - `continueTextOutbound(repo, deps, ctx: { account: GhlAccount; row: GhlOutboundMessage; target: OutboundTarget; text: string; sendingNumber: OutboundNumber; toPhone: string | null }): Promise<HandleProviderOutboundOutcome>`. This is the text-path block of `handleProviderOutboundMessage` after `!isNew`, extracted unchanged (gate → STOP → reauth/disabled → hold-behind → send → hold/refuse). `handleProviderOutboundMessage` calls it. The media split, group refusal and invalid-target branches stay where they are.
  - `sendAppOriginatedText(repo, deps, input: { account: GhlAccount; tenantId: string; ghlContactId: string; toPhone: string; text: string }): Promise<HandleProviderOutboundOutcome>`. It records a row with `ghlMessageId = APP_MESSAGE_ID_PREFIX + randomUUID().replaceAll("-", "")` on `input.tenantId` (via `groupSendingNumber`), then calls `continueTextOutbound`.
  - `reportGhlOutcome`: for `isAppOriginatedMessageId(row.ghlMessageId)`, mark the row reported (`reportedStatus: status, reportError: null`) **without** calling GHL. This covers the status drain and the held-release pass, which both report through it.
- [ ] **Step 1: Write failing tests:**
  - `app-originated: a STOP on another of the location's numbers refuses the invite` (Review Focus 1): `isOptedOut` is true for number 2 only, and the invite is sent on number 1 → `{ kind: "refused", reason: <REASON_OPTED_OUT_OTHER_NUMBER> }`, `sendWhatsapp` not called.
  - `app-originated: sent from the given tenant, not the sticky or default number`: `sendWhatsapp` gets `coachId === input.tenantId`.
  - `app-originated: number offline (linked before) → held` (Review Focus 5): bridge `session_not_connected` → `{ kind: "held" }`, the row's `sendState` is `held`.
  - `app-originated: never PUTs a status to GHL`: `deps.updateStatus` call count 0 through refusal, delivery and the held-release paths (`ghl-held.test.ts`: release a held `pwapp_` row whose contact has since sent STOP → refused, reported locally, `updateStatus` not called).
  - `app-originated: billing gate applies`: a cancelled account → refused with the existing gate string.
  - All existing `handleProviderOutboundMessage` tests still pass unchanged (this proves the extraction is a pure refactor).
- [ ] **Step 2: Run** `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.** Make the extraction its own commit-sized diff, and keep `handleProviderOutboundMessage`'s outcomes byte-identical.
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `provider: app-originated sends through the normal outbound path`.

### Task 7: Invite resolution and the invite message

**Files:**
- Create: `src/lib/group-invites.ts`
- Modify: `src/lib/ghl.ts` (contacts reads)
- Test: new `scripts/test/group-invites.test.ts`, `scripts/test/ghl.test.ts`

**Interfaces:**
- Consumes: Task 5 (`getGroupInviteTemplate`, `hasInboundFromPhone`, bridge client), Task 6 (`sendAppOriginatedText`, `optedOutReason`).
- Produces:
  - `ghl.ts`: `type GhlContactLite = { id: string; firstName: string | null; name: string | null; phone: string | null; tags: string[] }`; `getGhlContact(accessToken, contactId): Promise<{ ok: true; contact: GhlContactLite } | { ok: false; error: string }>`; `searchGhlContacts(accessToken, locationId, query: { text?: string; tag?: string }, limit: number): Promise<{ ok: true; contacts: GhlContactLite[]; truncated: boolean } | { ok: false; error: string }>`. This is `POST /contacts/search` with a `tags` filter or a query string, paged up to `limit`, using the same headers and version as `postGhlContactUpsert`. Tag match is case-insensitive.
  - `DEFAULT_GROUP_INVITE_TEMPLATE` (the Global Constraints string), `INVITE_TEMPLATE_MISSING_LINK = "The invite message must include {link}."`, `MAX_INVITE_TEMPLATE = 500`, `MAX_INVITEES_PER_REQUEST = 100`.
  - `validateInviteTemplate(raw: unknown): { ok: true; template: string } | { ok: false; message: string }`: trims, 1–500 code points, must contain `{link}`.
  - `renderInviteMessage(template: string, vars: { firstName: string | null; groupName: string; coachName: string; link: string }): string`. Replaces every occurrence. A missing first name becomes `there`. Other `{…}` text is left as is.
  - `type Invitee = { contactId: string; firstName: string | null; phone: string }`; `type SkippedInvitee = { contactId: string; name: string | null; reason: "no_phone" | "group_contact" | "duplicate_phone" | "opted_out" }`.
  - `resolveInvitees(deps, input: { accessToken; locationId; tenantId; contactIds?: string[]; tag?: string }): Promise<{ ok: true; invitees: Invitee[]; skipped: SkippedInvitee[]; truncated: boolean } | { ok: false; message: string }>`. GHL lookup → drop contacts tagged `whatsapp-group` (`GHL_GROUP_CONTACT_TAG`) or without a phone → `normalisePhoneE164(phone, "GB")` → dedupe by E.164 (first wins) → drop anyone `optedOutReason(...) !== null` (location-wide). Capped at `MAX_INVITEES_PER_REQUEST`.
  - `sendGroupInvites(deps, input: { account; tenantId; group: { jid; name }; invitees: Invitee[]; directAdd: boolean; coachName: string }): Promise<{ added: string[]; sent: number; held: number; refused: { contactId: string; reason: string }[] }>`. Gets the link from the bridge once. With `directAdd`, it asks the bridge to add the invitees whose `hasInboundFromPhone` is true. Anyone whose result is not `ok` / `already_member` gets the link message instead. Everyone else gets `renderInviteMessage(...)` through `sendAppOriginatedText`, one at a time and in order.
  - `coachName` is decided by the caller (Task 8): the number's label, else `ghl_accounts.label`.
- [ ] **Step 1: Write failing tests** in `group-invites.test.ts`, with fake deps:
  - `template: saving without {link} is refused` with exactly `The invite message must include {link}.`; 501 code points refused; the default renders to `Hi Sam, Coach Jo invited you to join Spring Cohort on WhatsApp: https://chat.whatsapp.com/AbC123xyz0`.
  - `render: no first name → "Hi there"`; `{link}` twice → both replaced.
  - `resolve: tag pulls in a group contact, a phoneless contact and two contacts sharing a phone` (Review Focus 4): one invitee, three skipped with reasons `group_contact`, `no_phone`, `duplicate_phone`.
  - `resolve: an opted-out contact is skipped as opted_out and never reaches sendGroupInvites or the bridge add` (Review Focus 1).
  - `send: each invite goes through sendAppOriginatedText on the group's tenant, in order` (this is the spec's "tag → contacts → invites goes through normal outbound with pacing" test: pacing and the cap are the bridge's, reached through the normal path).
  - `send: a direct add refused for privacy falls back to the link message`; `send: add limit reached → the rest get links`; `send: a held invite is counted in held, not refused`.
  - `ghl.test.ts`: `searchGhlContacts` sends the tag filter and maps a GHL response fixture; a non-2xx → `{ ok: false }` without the body.
- [ ] **Step 2: Run** `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `groups: invite contacts by link with an editable message`.

### Task 8: Embed routes

**Files:**
- Create: `src/app/api/crm/embed/groups/manage/route.ts`, `src/app/api/crm/embed/groups/manage/logic.ts`, `src/app/api/crm/embed/groups/invite-template/route.ts`, `src/app/api/crm/embed/groups/invite-template/logic.ts`
- Modify: `src/app/api/crm/embed/groups/logic.ts` (`EmbedGroupView` gains `createdByUs`)
- Test: new `scripts/test/embed-group-manage.test.ts`, `scripts/test/embed-groups.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7; `authorizeGhlEmbedRequest` + `requestedSlotFromBody` (slot guard) for `manage`, and `authorizeGhlEmbedLocationRequest` for `invite-template` (the template is per sub-account, not per number).
- Produces:
  - `POST /api/crm/embed/groups/manage`, body `{ slot?, action, ... }`, where `action` is one of:
    - `create` `{ requestId, name, description?, contactIds? | tag?, directAdd? }`: `resolveInvitees` → bridge `createWhatsappGroup` (participants = invitees' phones, as fallback candidates) → `recordCreatedWhatsappGroup` → `refreshWhatsappGroups` → `sendGroupInvites` (excluding `addedPhone`) → `{ ok, group: { jid, name }, invites: { added, sent, held, refused, skipped } }`.
    - `search_contacts` `{ text?, tag? }` → `{ ok, contacts: { id, name, hasPhone, canAddDirectly }[] }`
    - `detail`, `update`, `participants`, `invite_link`, `invite_reset`, `leave` `{ groupJid, ... }`: the group must be in this tenant's `listWhatsappGroups` and enabled, else 404 `unknown_group`. A successful `update` with a name also calls `renameWhatsappGroup`. `leave` calls `markWhatsappGroupLeft` then `refreshWhatsappGroups`.
    - `invite` `{ groupJid, contactIds? | tag?, directAdd? }`: invite more people to an existing group.
  - `decideGroupManageRequest(repo, deps, ctx: { tenantId: string /* from the slot guard */; account: GhlAccount /* route loads it with getGhlAccountByLocationId */; slotLabel: string | null }, body): Promise<{ status: number; body: Record<string, unknown> }>`. Each response is built by listing its fields (never a spread), as in `groups/logic.ts`.
  - `POST /api/crm/embed/groups/invite-template` `{ template: string | null }` (null resets to default) → `{ ok, template, isDefault }`; an empty body reads it.
  - Validation: name/description limits in code points, `requestId` matches `^[A-Za-z0-9_-]{8,64}$`, `contactIds` ≤ 100.
- [ ] **Step 1: Write failing tests** in `embed-group-manage.test.ts`:
  - `no tenant id anywhere`: the serialised JSON of every action's response does not contain the fake tenant uuid.
  - `create: the group is enabled and synced`: `recordCreatedWhatsappGroup` then `refreshWhatsappGroups` are called for the slot's tenant, and the response has no tenant id.
  - `create: limit/warm-up/needs_member messages are passed through verbatim` with status 422.
  - `manage: a group not enabled on this number is 404 unknown_group and the bridge is never called` (another number's enabled group, same location).
  - `manage: not_admin → 403 with "This number isn't an admin of that group."`
  - `participants: self and last-admin results surface as the fixed strings` (`You can't remove the group's last admin.`, and the self string).
  - `leave: marks left and refreshes`.
  - `invite-template: missing {link} refused verbatim; null resets; one sub-account's template never changes another's`.
  - `embed-groups.test.ts`: the list includes `createdByUs`.
- [ ] **Step 2: Run** `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.** The routes are thin adapters (the same shape as `groups/route.ts`). Failures are fixed sentences, and bridge messages are passed through only for the 422/403 codes, whose messages are the spec's fixed strings.
- [ ] **Step 4: Run** `npm run check`. Expect PASS.
- [ ] **Step 5: Commit** `embed: create, invite and manage groups`.

### Task 9: Embed UI

**Files:**
- Create: `src/app/embed/crm/CreateGroupForm.tsx`, `src/app/embed/crm/GroupManagePanel.tsx`
- Modify: `src/app/embed/crm/CrmEmbedClient.tsx` (`GroupsSection`, about line 756: a "Create group" button, and a "Manage" button per group with `enabled && weAreAdmin`, the latter known after `detail`)
- Test: `npm run check` plus a production build (`npx next build` with the README's placeholder env). There's no GHL in CI. Behaviour is covered by Task 8's route tests.

**Interfaces:**
- Consumes: Task 8 actions. All calls go through `callEmbedApi("/api/crm/embed/groups/manage", "POST", { slot, action, ... })`.

- [ ] **Step 1: CreateGroupForm.** Name (counter /100), optional description (/512), invitees: "Pick contacts" (a search box over `search_contacts`, chips) or "Everyone with tag". "Add people who've messaged this number directly" checkbox (off by default). An invite message editor showing the template, Save/Reset via `invite-template`, and the line "Applies to this sub-account." `requestId` is minted once per open form (`crypto.randomUUID()` without dashes), and the button is disabled while in flight. The result summary lists added, sent, held ("will send when the number reconnects"), refused (with reason) and skipped (with reason).
- [ ] **Step 2: GroupManagePanel** (opened from a group row, loads `detail`): rename, description, "Only admins can send", "Approve new members" toggles, a members list (name or phone, else "WhatsApp member") with Remove / Make admin / Remove admin, hidden for our own row. The invite link with Copy and Reset (reset asks for confirmation in the page). "Invite more" (reuses the invitee picker) and Leave (in-page confirmation, never `confirm()`). With `weAreAdmin === false`, it shows only "This number isn't an admin of that group." and Leave.
- [ ] **Step 3: Run** `npm run check` and the production build. Expect PASS.
- [ ] **Step 4: Commit** `ui: create and manage WhatsApp groups`.

### Task 10: Docs

**Files:**
- Modify: `README.md`, `services/whatsapp-bridge/README.md`, `docs/GO-LIVE-FOUNDATION.md` (migration 0009, the two new Railway vars), `docs/superpowers/specs/2026-10-17-group-creation-and-management-design.md` (correct "20 adds" to 50 in Tests; add the self-removal string, the `memberId` addressing and the app-originated invite rows), `docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`

- [ ] **Step 1:** Document migration 0009 (apply before deploying this bridge and app), `WA_GROUP_CREATE_DAILY` / `WA_GROUP_ADD_DAILY`, the new routes, that invites are normal sends (cap, STOP, hold), and that `scripts/group-sandbox.ts` should be run on a spare number before go-live, with its result for the empty create recorded in the spec's Decisions log.
- [ ] **Step 2: Commit** `docs: group creation and management`.


## Decisions after planning (Charlie, 17 Oct 2026)

- **Invites appear in GHL.** Each invite sent by WhatsApp is also posted into the contact's GHL conversation as an outbound message (GHL Conversations API, the location token), after the bridge accepts it, so the coach sees it went out. Task 8 owns this: post once per invite, never block or fail the invite if the GHL post fails (log with a fixed string), and never post for refused or skipped invitees. Add tests for: posted after acceptance; GHL failure doesn't fail the invite; no post for refused/skipped.
- **Invite template per sub-account** (edited inside GHL, applies to that sub-account only). Applied in Global Constraints, Task 1 (migration), Task 5 (repo), Task 8 (route) and Task 9 (UI copy) above.
- **Controller rulings on the planner's questions:** 50 direct adds a day (the spec's Tests line saying 20 is outdated); the create-limit message fills in the configured number; warm-up refusals follow `WA_WARMUP_ENABLED` (off by default, so re-scanned established numbers aren't blocked); during warm-up direct adds quietly become invite links; removing our own number → "You can't remove this WhatsApp number from the group. Use Leave instead."; members are managed by their WhatsApp member id from group details, phone numbers only for adds; explicit STOP check before direct adds and the create fallback member; `{coach_name}` = the number's label, else the sub-account label; "has messaged this number" means within the 90-day inbound retention; 100 invitees per request; managing requires the group to be synced.
