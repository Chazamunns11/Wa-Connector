# WhatsApp Group Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PingWren customer creates a WhatsApp group from a connected number, adds people from their GoHighLevel contacts (by search, by tag, or by pasting numbers), shares the invite link, and posts a text into the group, all from the PingWren dashboard, with the same pacing, caps, opt-out and billing rules as 1:1 sends.

**Architecture:** The bridge (Railway, Baileys 7.0.0-rc14) gains one new module, `groups.ts`, and five authenticated routes under `/sessions/:coachId/groups/...`. It stays policy-free: it creates groups, runs paced "add participants" jobs, posts to a group through the existing per-session queue and pacer, and records what WhatsApp answered in two new `whatsapp_group_*` ledger tables. Every decision that needs business context (who owns the location, billing, STOP opt-outs, consent, which contacts to add, what the invite text says, when to send an invite link instead of a direct add) lives in the portal under `src/lib/groups/`, as pure deps-injected functions tested with `node --test`, driven by server actions on `/dashboard/groups`. Group replies do **not** flow into GoHighLevel in v1; the bridge keeps ignoring `@g.us` inbound.

**Tech Stack:** Next.js 16.2.10 (`node_modules/next/dist/docs/01-app/` is the reference; `params`/`searchParams` are Promises, `proxy.ts` not middleware, Server Actions are untrusted POST entry points), `@supabase/supabase-js` service-role repo, `node --test` via `scripts/test/alias-hook.mjs`; bridge: TypeScript, `tsx --test`, Node 24, `@whiskeysockets/baileys` 7.0.0-rc14.

**Spec:** This document's "Design" section is the spec (there is no separate spec file; the owner's brief was "it is a group creator": customers create WhatsApp groups from their own number, add people, and post into them). Codebase context: `docs/GO-LIVE-FOUNDATION.md`, `docs/GO-LIVE-ACCOUNTS.md`, `docs/superpowers/plans/2026-10-16-reliability.md` (held/STOP rules W10/W11), `services/whatsapp-bridge/README.md` "Safety invariants".

## Global Constraints

- Work in `/home/user/pw-groups` on branch `claude/pingwren-groups` (from `main` 7ec85fb). Never edit `/home/user/wa-connector*`, `/home/user/PortalHub`.
- Next.js 16.2.10 conventions: read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `02-guides/server-actions.md` ("Security"), `02-guides/forms.md`, `03-api-reference/03-file-conventions/page.md` before writing any page/action. Route handlers and actions stay thin; logic in `src/lib/groups/*` with no Next imports.
- Every string shown to a customer or stored as a reason is a fixed constant in `src/lib/groups/rules.ts` or `services/whatsapp-bridge/src/groups.ts`; never upstream error text, never a Baileys error message.
- Phone numbers never appear in logs, Slack notifications, or error messages: log counts and ids only (same posture as the bridge's `log.error({ coachId, messageId })` lines). Member phones are stored (the customer's own contacts, needed to act) and shown only on that customer's own dashboard.
- Bridge: every new table name starts with `whatsapp_` (`test/no-hub-tables.test.ts`); every new route is behind the existing bearer gate and `UUID_RE`; group JIDs are validated with `GROUP_JID_RE = /^[0-9]{5,20}(-[0-9]{5,20})?@g\.us$/`; participant phones are strict E.164 (`isE164`), the bridge never normalises.
- Pacing is configuration (`config.ts` + `.env.example`), never literals in logic. New env, with defaults: `WA_GROUPS_ENABLED=false`, `WA_GROUP_ADD_BATCH=5`, `WA_GROUP_ADD_GAP_MS=8000`, `WA_GROUP_ADD_JITTER_MS=4000`, `WA_GROUP_ADDS_DAILY_CAP=50`, `WA_GROUP_CREATES_DAILY_CAP=3`.
- Group posts consume the SAME per-session pacer slot and `WA_DAILY_CAP` budget as 1:1 sends (one WhatsApp frame = one slot). Group adds and creates have their own daily caps above.
- Portal feature gate: `GROUPS_ENABLED` env (server-only, exactly `"true"` enables). Off: `/dashboard/groups/**` returns `notFound()` and every groups action returns `{ ok: false, code: "groups_disabled" }`. The website's `FEATURES_GROUPS_LIVE` flag (other branch) only flips marketing copy; it is not read by the app.
- Billing: groups are included in the per-number price. No Stripe change, no new quantity, no new price. `sendingGate` (activated + billing live) is the gate, plus "number connected".
- STOP (W10, per number): an opted-out phone is never added to a group and never sent an invite link from that number. Checked in the portal at add time and again at invite-send time.
- Member cap per group in v1: `GROUP_MEMBER_CAP = 256` (WhatsApp allows 1024; v1 stays well under). Add batch per action: `ADD_BATCH_MAX = 50` phones. Subject `1..100` chars, description `0..2048` chars (WhatsApp's own limits), post text `1..4096` (bridge `MAX_TEXT_LENGTH`).
- Consent: an add batch is refused unless `consent=on` was posted ("These people have agreed to be in this group"); `consent_confirmed_at` is stored on each member row.
- Migration `supabase/migrations/0005_groups.sql`. Every new table: `enable row level security`, no policies. Columns the bridge writes are only in bridge-owned tables (`whatsapp_group_jobs`, `whatsapp_group_posts`); portal-owned: `whatsapp_groups`, `whatsapp_group_members`.
- No "FitClosers" wording in `src/` or the bridge (`scripts/test/no-fitclosers.test.ts`). Brand name via `brandConfig().name`.
- Acceptance for every portal task: `npm run check` and `NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build` pass. Bridge tasks: `cd services/whatsapp-bridge && source /opt/nvm/nvm.sh && nvm use 24 && npm test` (plus `npm run typecheck`).
- Commit after every task with a one-line conventional message and the trailers below. Do not push.

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8am6JXR8UgvKbeEBPvjuQ
```

## Review Focus

1. A customer pastes 300 numbers (some duplicated, some national format `07700 900123`, some already members, one opted out): the action must normalise with `normalisePhoneE164(raw, "GB")`, de-duplicate, drop existing members, mark the opted-out phone `opted_out` without calling the bridge, and refuse the whole batch over `ADD_BATCH_MAX` with `REASON_BATCH_TOO_LARGE` rather than silently truncating. Pinned in Task 5 (`planAddMembers`).
2. WhatsApp answers `403` for half a batch: those phones become `invite_needed`, the portal sends ONE invite-link text each through the normal 1:1 pipeline (opt-out re-checked, idempotency key `grp-inv-<memberRowId>`), never Baileys' private "invite v4"; a replayed reconcile must not send a second invite. Pinned in Task 5 (`reconcileJob`) and Task 8.
3. The bridge restarts mid add-job: a job still `running` at boot is marked `interrupted` and never resumed; remaining phones are reported `failed` with `REASON_INTERRUPTED` so the customer can retry explicitly. Pinned in Task 3 (`sweepInterruptedGroupJobs`).
4. Two overlapping "post to group" submissions (double click): the hidden form token is the idempotency key, so the second is a 200 replay with the first row, not a second message. Pinned in Task 4 (route replay) and Task 9 (action keeps the token).
5. A location whose billing lapses after the group exists: creating, adding, posting and sending invites must all refuse with the gate's reason; viewing the group and copying the invite link still work. Pinned in Task 5 (`groupGate`) and Task 9.

---

## Gap list — what exists vs what "group creator" needs

| Need | Today | Gap |
|---|---|---|
| Create a group from the customer's number | Bridge has no group routes; `services/whatsapp-bridge/src/server.ts` serves connect/status/logout/send/messages only. Baileys exposes `groupCreate`, `groupUpdateDescription`, `groupInviteCode`, `groupSettingUpdate`, `groupMemberAddMode` (`node_modules/@whiskeysockets/baileys/lib/Socket/groups.d.ts`). | Tasks 2, 3, 4. |
| Add people, with privacy fallback | Nothing. `groupParticipantsUpdate` returns per-participant `status` strings (`'200'` or the `error` attr: `403` privacy, `408` recently left, `409` already member, `419` group full). | Tasks 2, 3, 4 (bridge), 5, 8 (portal). |
| Pace and cap group operations | `SessionPacer` (`pacing.ts`) paces sends only; `whatsapp_messages.to_phone` has an E.164 CHECK so a group JID cannot be ledgered there. | Task 2 (`GroupLimiter`), Task 1 (new ledgers), Task 3 (queue union). |
| Post a message into a group | `drainQueue` (`sessions.ts:1299`) runs `onWhatsApp` first and sends to the JID it returns; a group JID would fail that step. | Task 3 (`group_post` queue item skips the existence check, same pacer slot). |
| Pick GoHighLevel contacts by search or tag | `src/lib/ghl.ts` has `upsertGhlContact` only. GHL documents `GET /contacts/` (`locationId`, `query`, `limit`≤100, `startAfterId`, Version `2021-07-28`); `POST /contacts/search`'s body schema is published empty. | Task 6. |
| Respect STOP, consent, billing | `sendingGate` (`src/lib/billing/gate.ts`), `repo.isOptedOut` exist for 1:1 sends only. | Task 5. |
| Dashboard UI | `/dashboard` lists locations; no groups anywhere; `src/lib/site/routes.ts` has no groups route. | Tasks 7, 9, 10. |
| Audit without phones in logs | Bridge logs ids only; portal `notifyText` is free text. | Tasks 3, 5 (fixed shapes), 11 (docs). |
| Site copy | No feature copy for groups; the site pass (other branch) adds a `FEATURES_GROUPS_LIVE` flag. | Task 12 (`src/lib/site/groups-copy.ts`). |
| Group replies into GoHighLevel | `inbound.ts:427` drops everything not `isPnUser`/`isLidUser`; GHL's provider API has no group concept. | Not in v1 (Design §4). Documented in Task 11. |

---

## Design

### 1. Where it lives: the PingWren dashboard (v1), not a GoHighLevel workflow action

Decision: v1 ships **only** in the PingWren dashboard at `/dashboard/groups`. A GoHighLevel Marketplace workflow action ("Add contact to WhatsApp group") is deferred to v2 behind an owner decision.

Why the dashboard first:
- Marketplace Workflow Actions are real and would fit ("API mode: a POST URL; payload `{ data, extras: { locationId, contactId, workflowId }, meta: { key, version } }`", review per version) — https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomActions/index.html. But they are part of **"LC Premium Triggers & Actions", chargeable per execution to the sub-account**, need the `workflows.readonly` scope added to the app (a re-auth for every installed location), and each version is reviewed before it goes live — https://marketplace.gohighlevel.com/docs/marketplace-modules/WorkflowActionsAndTriggers. The app is currently Private and Free (`GO-LIVE-FOUNDATION.md` 4b) and nothing in it has been through GHL review.
- A workflow action is also the highest-risk shape: a workflow can fire for thousands of contacts with nobody watching, which is exactly the mass-add pattern that gets a number banned. The dashboard flow puts a human, a consent tick and a 50-per-batch cap in front of every add.
- The dashboard already has the pieces: `requireAccountSession`, location ownership (`listGhlAccountsForAccount`), `sendingGate`, `repo.isOptedOut`, the bridge client, GHL tokens per location (`resolveGhlAccessToken`).

What v2 would add (not planned here): one workflow action "Add contact to WhatsApp group" whose POST URL is `<app>/api/crm/group-action` (no "ghl" in the path, trap 3), authenticated by a per-app header the owner configures in the developer portal, that enqueues the contact into an existing group via the same `addMembers` service with the same caps. It is a 2–3 task addition once v1 is live.

### 2. Customer flow (v1)

1. `/dashboard/groups`: all groups across the account's locations (name, number, member count, created). "New group" button.
2. `/dashboard/groups/new`: pick an activated, connected number; subject; optional description; options "Only admins can post" (announcement group) and "Only admins can add members" (default on); first members (search a GoHighLevel contact by name/phone, pick a tag, or paste numbers); consent tick. WhatsApp requires at least one participant at creation, so the form requires ≥1.
3. `/dashboard/groups/[groupId]`: invite link with copy button (and "Make a new link", which revokes the old one), members table with state per person, "Add people" (same three pickers + consent), "Post a message" (text, 4096 max), "Refresh from WhatsApp" (member count, our admin status), last 20 posts (status only, no body).
4. Replies: the customer reads and answers group messages on the phone, as today. The page says so.

### 3. WhatsApp realities (what the plan does about each)

| Reality | Source | v1 behaviour |
|---|---|---|
| "Who can add me to groups" privacy blocks a direct add; WhatsApp's own app offers "invite them privately", valid 3 days | https://blog.whatsapp.com/new-privacy-settings-for-groups ; per-participant `403` | Member becomes `invite_needed`; the portal sends the group's invite link as a normal 1:1 text from the same number (paced, capped, opt-out checked). Never Baileys `groupInviteMessage`/invite v4: one engine reported a device logout right after a 403 add (https://github.com/devlikeapro/waha/issues/2002), so the bridge does the minimum and the portal uses the already-safe path. |
| 1024-member cap | https://support.whapi.cloud/help-desk/faq/why-arent-participants-being-added-to-the-group | v1 cap 256 per group (`GROUP_MEMBER_CAP`), `419` → `group_full`. |
| Recently left can't be re-added for a while (`408`); already a member (`409`) | https://github.com/wwebjs/whatsapp-web.js/pull/2344 (code table) | Fixed member states `recently_left`, `already_member`; never retried automatically. |
| Mass group creation / adding gets numbers banned | bridge README "Safety invariants" | `WA_GROUP_CREATES_DAILY_CAP=3`, `WA_GROUP_ADDS_DAILY_CAP=50` phones/day/number, adds in batches of 5 with 8–12 s gaps, invites and posts go through the 45–75 s pacer and the 150/day cap. Consent tick stored per member. |
| STOP | reliability plan W10 | Opted-out phones are filtered before the bridge is called, and again before an invite text. The group itself is not touched when someone later replies STOP (owner decision 4). |
| Group replies | GHL provider API is 1:1 only; `inbound.ts` drops `@g.us` | Not in GHL. Dashboard copy says "Replies stay in WhatsApp on the phone." |
| Status codes are observed, not documented by WhatsApp | code table above | Unknown code → `failed` with `REASON_WHATSAPP_REFUSED`; the raw code is logged (it is not a phone) and kept in `whatsapp_group_jobs.results[].code`. |

### 4. Data model (migration 0005)

Bridge-owned (bridge writes, portal reads):

- `whatsapp_group_jobs` — one row per add-participants job. `id uuid pk`, `coach_id uuid not null references whatsapp_tenants(id) on delete cascade`, `group_jid text not null`, `kind text not null check (kind in ('add', 'create'))` (a `create` row is inserted already `done` with the creation's participant results, so one query gives both daily counts), `status text not null default 'queued' check (status in ('queued','running','done','interrupted'))`, `requested_count int not null`, `results jsonb not null default '[]'` (array of `{ "phone": "+44…", "code": "200", "outcome": "added" | "invite_needed" | "recently_left" | "already_member" | "not_on_whatsapp" | "group_full" | "failed" }`), `created_at timestamptz not null default now()`, `started_at timestamptz`, `finished_at timestamptz`. Index `(coach_id, created_at desc)`. Phones inside `results` are needed to reconcile; the table is service-role only.
- `whatsapp_group_posts` — the group-send ledger (no body). `id uuid pk`, `coach_id uuid not null references whatsapp_tenants(id) on delete cascade`, `group_jid text not null`, `idempotency_key text not null`, `status text not null default 'accepted' check (status in ('accepted','sending','sent','failed'))`, `wa_message_id text`, `error text`, `dispatch_attempted boolean not null default false`, `created_at timestamptz not null default now()`, `sent_at timestamptz`, `unique (coach_id, idempotency_key)`. Index `(coach_id, created_at desc)`.

Portal-owned:

- `whatsapp_groups` — `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null references whatsapp_tenants(id) on delete cascade`, `location_id text not null references ghl_accounts(location_id) on delete cascade`, `account_id uuid not null references accounts(id) on delete cascade`, `wa_group_jid text not null unique`, `subject text not null check (char_length(subject) between 1 and 100)`, `description text check (description is null or char_length(description) <= 2048)`, `invite_code text`, `announce_only boolean not null default false`, `admin_add_only boolean not null default true`, `participant_count int not null default 1`, `we_are_admin boolean not null default true`, `created_by_profile_id uuid references profiles(id) on delete set null`, `created_at`, `updated_at` + `set_updated_at` trigger. Index `(account_id, created_at desc)`.
- `whatsapp_group_members` — `id uuid pk default gen_random_uuid()`, `group_id uuid not null references whatsapp_groups(id) on delete cascade`, `phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$')`, `ghl_contact_id text`, `display_name text check (display_name is null or char_length(display_name) <= 120)`, `state text not null default 'pending' check (state in ('pending','added','invite_needed','invite_sent','recently_left','already_member','not_on_whatsapp','group_full','opted_out','failed'))`, `job_id uuid`, `invite_idempotency_key text`, `consent_confirmed_at timestamptz not null`, `added_by_profile_id uuid references profiles(id) on delete set null`, `last_reason text`, `created_at`, `updated_at` + trigger, `unique (group_id, phone)`. Index `(group_id, state)`.

### 5. Bridge API (all `Authorization: Bearer <WA_BRIDGE_SECRET>`, `:coachId` strict UUID, 404 `groups_disabled` when `WA_GROUPS_ENABLED` is false)

| Route | Body | Response |
|---|---|---|
| `POST /sessions/:coachId/groups` | `{ subject, description?, participants: string[] (1..5 E.164), announceOnly?: boolean, adminAddOnly?: boolean }` | `201 { ok, group: { jid, subject, inviteCode, participantCount, weAreAdmin }, results: [{ phone, code, outcome }] }` — creates with the resolvable participants; the create response's `participants` decide `added` vs `invite_needed`/others; counts 1 against the create cap |
| `POST /sessions/:coachId/groups/:jid/participants` | `{ add: string[] (1..50 E.164) }` | `202 { ok, job: { id, status: "queued", requestedCount } }`; `429 group_add_cap_reached` when `add.length` exceeds today's remaining add budget |
| `GET /sessions/:coachId/groups/jobs/:jobId` | — | `200 { ok, job: { id, status, requestedCount, results, createdAt, finishedAt } }` |
| `POST /sessions/:coachId/groups/:jid/messages` | `{ text (1..4096), idempotencyKey }` | `202` fresh / `200` replay `{ ok, replay, post: { id, idempotencyKey, status, waMessageId, error, createdAt, sentAt } }` — same contract shape as `/send` |
| `GET /sessions/:coachId/groups/:jid` | — | `200 { ok, group: { jid, subject, participantCount, weAreAdmin, inviteCode } }` (never participant phones) |
| `POST /sessions/:coachId/groups/:jid/invite/revoke` | — | `200 { ok, inviteCode }` |

Error codes added to the uniform `{ ok: false, error: { code, message } }` shape: `groups_disabled`, `invalid_group_jid`, `invalid_subject`, `invalid_description`, `invalid_participants`, `group_create_cap_reached`, `group_add_cap_reached`, `group_not_found` (metadata fetch threw), `not_admin`, plus the existing `session_not_connected`, `daily_cap_reached`, `lease_unavailable`, `idempotency_conflict`.

### 6. Portal

- `src/lib/groups/rules.ts` — pure: constants, validation, `planAddMembers`, `outcomeForCode`, `reconcileJob`, `inviteText`.
- `src/lib/groups/service.ts` — `createGroup`, `addMembers`, `postToGroup`, `refreshGroup`, `reconcileGroupJobs`, `rotateInviteLink`, each `(repo, deps, session, input)` with injected bridge/GHL/clock, never importing Next.
- `src/lib/ghl.ts` — `listGhlContacts` (GET /contacts/), `searchGhlContacts`; `src/lib/groups/contacts.ts` — `contactsByTag` (pages `listGhlContacts` up to 5 pages × 100, filters by tag locally).
- Repo methods on `GhlRepository` (+ `SupabaseGhlRepository`, + `scripts/test/repository-shape.test.ts` METHODS list).
- Bridge client functions in `src/lib/whatsapp-bridge.ts` (same `bridgeFetch` + `toFailure` contract).
- Pages and actions under `src/app/(app)/dashboard/groups/`.
- Reconcile runs on page view (fresh), from the existing `/api/webhooks/crm-outbound-status` poke route and the hourly `/api/cron/drain` (bounded), so invites go out within seconds of the bridge finishing a job.

### 7. Billing

Included in the per-number price. Group posts count toward the number's existing 150/day. No new Stripe objects, no new env for pricing. `docs/GO-LIVE-ACCOUNTS.md` gets one line saying so (Task 11).

---

## File map

New (bridge):
- `services/whatsapp-bridge/src/groups.ts` — pure helpers: `GROUP_JID_RE`, `isGroupJid`, `GroupLimiter`, `outcomeForParticipantStatus`, `inviteLinkFor`, `runAddJob`.
- `services/whatsapp-bridge/test/groups.test.ts`, `test/groups-limiter.test.ts`, `test/server-groups.test.ts`, `test/store-groups.test.ts` (shape only).

Modified (bridge): `src/config.ts` (+6 env), `.env.example`, `src/store.ts` (+ group job/post methods, `getDailyActivity` includes posts), `src/sessions.ts` (`QueueItem` union, `postToGroup`, `createGroup`, `startAddJob`, `getGroup`, `revokeGroupInvite`, boot sweep), `src/server.ts` (+6 routes), `README.md` (routes table, invariants), `test/server.test.ts` (fake manager gains the new methods).

New (portal):
- `supabase/migrations/0005_groups.sql`
- `src/lib/groups/rules.ts`, `src/lib/groups/service.ts`, `src/lib/groups/contacts.ts`, `src/lib/groups/types.ts`
- `src/lib/site/groups-copy.ts`
- `src/app/(app)/dashboard/groups/page.tsx`, `new/page.tsx`, `[groupId]/page.tsx`, `actions.ts`
- `src/components/groups/GroupList.tsx`, `GroupForm.tsx`, `MemberPicker.tsx`, `MemberTable.tsx`, `PostForm.tsx`, `InviteLink.tsx`
- `scripts/test/groups-schema.test.ts`, `groups-rules.test.ts`, `groups-service.test.ts`, `groups-contacts.test.ts`, `groups-repo.test.ts`, `groups-bridge-client.test.ts`, `groups-actions.test.ts`, `site-groups-copy.test.ts`

Modified (portal): `src/lib/types.ts`, `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/lib/whatsapp-bridge.ts`, `src/lib/ghl.ts`, `src/lib/site/routes.ts`, `src/app/(app)/layout.tsx` (nav link), `src/app/api/webhooks/crm-outbound-status/route.ts`, `src/app/api/cron/drain/route.ts`, `scripts/test/repository-shape.test.ts`, `scripts/test/site-routes.test.ts`, `docs/GO-LIVE-FOUNDATION.md`, `docs/GO-LIVE-ACCOUNTS.md`.

## Parallel groups

- **Group A (no dependencies, parallel):** Task 1 (migration + types), Task 2 (bridge pure helpers + config), Task 6 (GHL contacts), Task 12 (site copy).
- **Group B (after A):** Task 3 (bridge store + sessions, needs 1 and 2) → Task 4 (bridge routes, needs 3). In parallel: Task 5 (portal rules, needs 1), Task 7 (repo + bridge client, needs 1).
- **Group C (after B):** Task 8 (service, needs 5, 6, 7) → Task 9 (actions + pages, needs 8) → Task 10 (reconcile hooks + nav, needs 9).
- **Task 11 (docs) last.**

---

### Task 1: Migration 0005 and shared types

**Files:**
- Create: `supabase/migrations/0005_groups.sql`
- Modify: `src/lib/types.ts` (append after `OptOut`)
- Test: `scripts/test/groups-schema.test.ts` (same style as `scripts/test/reliability-schema.test.ts`)

**Interfaces:**
- Produces (in `src/lib/types.ts`):
  ```ts
  export type GroupMemberState = "pending" | "added" | "invite_needed" | "invite_sent" | "recently_left" | "already_member" | "not_on_whatsapp" | "group_full" | "opted_out" | "failed";
  export type GroupJobOutcome = Exclude<GroupMemberState, "pending" | "invite_sent" | "opted_out">;
  export type GroupJobStatus = "queued" | "running" | "done" | "interrupted";
  export interface WhatsappGroup { id: string; tenantId: string; locationId: string; accountId: string; waGroupJid: string; subject: string; description: string | null; inviteCode: string | null; announceOnly: boolean; adminAddOnly: boolean; participantCount: number; weAreAdmin: boolean; createdByProfileId: string | null; createdAt: string; updatedAt: string }
  export interface WhatsappGroupDraft { tenantId: string; locationId: string; accountId: string; waGroupJid: string; subject: string; description: string | null; inviteCode: string | null; announceOnly: boolean; adminAddOnly: boolean; participantCount: number; weAreAdmin: boolean; createdByProfileId: string | null }
  export interface WhatsappGroupMember { id: string; groupId: string; phone: string; ghlContactId: string | null; displayName: string | null; state: GroupMemberState; jobId: string | null; inviteIdempotencyKey: string | null; consentConfirmedAt: string; addedByProfileId: string | null; lastReason: string | null; createdAt: string; updatedAt: string }
  export interface WhatsappGroupMemberDraft { groupId: string; phone: string; ghlContactId: string | null; displayName: string | null; state: GroupMemberState; jobId: string | null; consentConfirmedAt: string; addedByProfileId: string | null; lastReason: string | null }
  export interface WhatsappGroupJob { id: string; coachId: string; groupJid: string; status: GroupJobStatus; requestedCount: number; results: { phone: string; code: string; outcome: GroupJobOutcome }[]; createdAt: string; finishedAt: string | null }
  export interface WhatsappGroupPost { id: string; coachId: string; groupJid: string; idempotencyKey: string; status: "accepted" | "sending" | "sent" | "failed"; waMessageId: string | null; error: string | null; createdAt: string; sentAt: string | null }
  ```

- [ ] **Step 1: Write the failing schema test**

```ts
const sql = readFileSync(join(process.cwd(), "supabase/migrations/0005_groups.sql"), "utf8");
test("bridge-owned ledgers", () => {
  assert.match(sql, /create table public\.whatsapp_group_jobs/);
  assert.match(sql, /kind\s+text not null check \(kind in \('add', 'create'\)\)/);
  assert.match(sql, /status\s+text not null default 'queued'\s+check \(status in \('queued', 'running', 'done', 'interrupted'\)\)/);
  assert.match(sql, /results\s+jsonb not null default '\[\]'/);
  assert.match(sql, /create table public\.whatsapp_group_posts/);
  assert.match(sql, /constraint whatsapp_group_posts_idempotency unique \(coach_id, idempotency_key\)/);
  assert.match(sql, /check \(status in \('accepted', 'sending', 'sent', 'failed'\)\)/);
});
test("portal-owned groups and members", () => {
  assert.match(sql, /create table public\.whatsapp_groups/);
  assert.match(sql, /wa_group_jid\s+text not null unique/);
  assert.match(sql, /subject\s+text not null check \(char_length\(subject\) between 1 and 100\)/);
  assert.match(sql, /admin_add_only\s+boolean not null default true/);
  assert.match(sql, /create table public\.whatsapp_group_members/);
  assert.match(sql, /phone ~ '\^\\\+\[1-9\]\[0-9\]\{6,14\}\$'/);
  assert.match(sql, /state in \('pending', 'added', 'invite_needed', 'invite_sent', 'recently_left', 'already_member', 'not_on_whatsapp', 'group_full', 'opted_out', 'failed'\)/);
  assert.match(sql, /consent_confirmed_at\s+timestamptz not null/);
  assert.match(sql, /unique \(group_id, phone\)/);
});
test("rls on every table, no policies, no bodies", () => {
  for (const t of ["whatsapp_group_jobs", "whatsapp_group_posts", "whatsapp_groups", "whatsapp_group_members"])
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
  assert.doesNotMatch(sql, /create policy/);
  assert.doesNotMatch(sql, /\bbody\s+text/);
});
```

- [ ] **Step 2: Run it** — `npm test -- --test-name-pattern "bridge-owned ledgers"` → FAIL (file missing).
- [ ] **Step 3: Write the migration** per Design §4, with a header comment stating ownership (bridge writes jobs/posts; portal writes groups/members), that no message body is stored, that `results[].phone` exists only to reconcile member rows, and `comment on table` for each table.
- [ ] **Step 4: Add the types** from Interfaces to `src/lib/types.ts`.
- [ ] **Step 5: `npm run check`** → PASS. Commit: `feat(db): 0005 WhatsApp group tables and types`.

---

### Task 2: Bridge pure helpers, limiter and config

**Files:**
- Create: `services/whatsapp-bridge/src/groups.ts`, `test/groups.test.ts`, `test/groups-limiter.test.ts`
- Modify: `services/whatsapp-bridge/src/config.ts` (`BridgeConfig` + `loadConfig`), `services/whatsapp-bridge/.env.example`, `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GROUP_JID_RE = /^[0-9]{5,20}(-[0-9]{5,20})?@g\.us$/;
  export function isGroupJid(value: string): boolean;
  export type ParticipantOutcome = "added" | "invite_needed" | "recently_left" | "already_member" | "not_on_whatsapp" | "group_full" | "failed";
  /** '200'→added, '403'→invite_needed, '408'→recently_left, '409'→already_member, '404'→not_on_whatsapp, '419'→group_full, anything else→failed */
  export function outcomeForParticipantStatus(status: string): ParticipantOutcome;
  export function inviteLinkFor(code: string): string; // `https://chat.whatsapp.com/${code}`
  export interface GroupLimiterConfig { addBatch: number; addGapMs: number; addJitterMs: number; addsDailyCap: number; createsDailyCap: number }
  export class GroupLimiter {
    constructor(config: GroupLimiterConfig, seed: { addsToday: number; createsToday: number }, now?: () => number, random?: () => number);
    remainingAddsToday(): number; reserveAdds(n: number): boolean; // false when n > remaining; reserves on true
    remainingCreatesToday(): number; reserveCreate(): boolean;
    batchGapMs(): number; // addGapMs + floor(random()*(addJitterMs+1))
    batches<T>(items: T[]): T[][]; // chunks of addBatch
  }
  export interface AddJobSocket { onWhatsApp(...phones: string[]): Promise<{ jid: string; exists: boolean }[] | undefined>; groupParticipantsUpdate(jid: string, participants: string[], action: "add"): Promise<{ status: string; jid: string | undefined }[]> }
  export interface AddJobResult { phone: string; code: string; outcome: ParticipantOutcome }
  export async function runAddJob(sock: AddJobSocket, limiter: GroupLimiter, groupJid: string, phones: string[], sleep: (ms: number) => Promise<void>, isConnected: () => boolean): Promise<{ results: AddJobResult[]; interrupted: boolean }>;
  ```
  `BridgeConfig` gains `groupsEnabled: boolean; groupAddBatch: number; groupAddGapMs: number; groupAddJitterMs: number; groupAddsDailyCap: number; groupCreatesDailyCap: number` read from `WA_GROUPS_ENABLED` (default `false`), `WA_GROUP_ADD_BATCH` (5, 1..10), `WA_GROUP_ADD_GAP_MS` (8000, ≥2000), `WA_GROUP_ADD_JITTER_MS` (4000, ≥0), `WA_GROUP_ADDS_DAILY_CAP` (50, 1..500), `WA_GROUP_CREATES_DAILY_CAP` (3, 1..20); out-of-range values throw at boot like the existing pacing checks.

- [ ] **Step 1: Write the failing tests**

```ts
test("group jid shape", () => {
  for (const ok of ["120363401234567890@g.us", "447700900123-1612345678@g.us"]) assert.equal(isGroupJid(ok), true);
  for (const bad of ["447700900123@s.whatsapp.net", "@g.us", "abc@g.us", "120363401234567890@g.us/../x", "120363401234567890@G.US"]) assert.equal(isGroupJid(bad), false);
});
test("participant status mapping is fixed", () => {
  assert.deepEqual(["200","403","408","409","404","419","500",""].map(outcomeForParticipantStatus),
    ["added","invite_needed","recently_left","already_member","not_on_whatsapp","group_full","failed","failed"]);
});
test("limiter reserves adds and creates per UTC day and rolls at midnight", () => {
  let t = Date.parse("2026-10-17T23:59:00Z");
  const l = new GroupLimiter({ addBatch: 5, addGapMs: 8000, addJitterMs: 4000, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 48, createsToday: 3 }, () => t, () => 0.5);
  assert.equal(l.reserveAdds(3), false); assert.equal(l.reserveAdds(2), true); assert.equal(l.remainingAddsToday(), 0);
  assert.equal(l.reserveCreate(), false);
  t += 120_000; assert.equal(l.remainingAddsToday(), 50); assert.equal(l.reserveCreate(), true);
  assert.equal(l.batchGapMs(), 10000); assert.deepEqual(l.batches([1,2,3,4,5,6,7]), [[1,2,3,4,5],[6,7]]);
});
test("runAddJob: resolves jids, batches, maps codes, keeps request order, stops when disconnected", async () => {
  const calls: string[][] = []; const sleeps: number[] = [];
  const sock = {
    onWhatsApp: async (...p: string[]) => p.map((ph) => ({ jid: `${ph.slice(1)}@s.whatsapp.net`, exists: ph !== "+447700900199" })),
    groupParticipantsUpdate: async (_j: string, parts: string[]) => { calls.push(parts); return parts.map((jid, i) => ({ status: i === 0 ? "403" : "200", jid })); },
  };
  const l = new GroupLimiter({ addBatch: 2, addGapMs: 1000, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 }, () => 0, () => 0);
  const r = await runAddJob(sock, l, "1@g.us", ["+447700900101","+447700900199","+447700900102","+447700900103"], async (ms) => { sleeps.push(ms); }, () => true);
  assert.deepEqual(r.results.map((x) => x.outcome), ["invite_needed","not_on_whatsapp","added","invite_needed"]);
  assert.deepEqual(calls.map((c) => c.length), [2, 1]); assert.deepEqual(sleeps, [1000]); assert.equal(r.interrupted, false);
  const r2 = await runAddJob(sock, l, "1@g.us", ["+447700900101","+447700900102","+447700900103"], async () => {}, (() => { let n = 0; return () => n++ < 1; })());
  assert.equal(r2.interrupted, true); assert.equal(r2.results.length, 2);
});
test("config: groups env defaults and bounds", () => { /* WA_GROUPS_ENABLED unset → groupsEnabled false; WA_GROUP_ADD_BATCH=11 → throws naming the variable; defaults 5/8000/4000/50/3 */ });
```

- [ ] **Step 2: Run** — `npm test -- --test-name-pattern "group jid shape"` → FAIL (module missing).
- [ ] **Step 3: Implement `groups.ts`** per Interfaces. `runAddJob`: for each batch, `isConnected()` false → return `{ results so far, interrupted: true }`; `onWhatsApp` the batch's phones, mark `exists === false` or missing as `not_on_whatsapp` without sending; call `groupParticipantsUpdate` with the resolved jids; map each returned `jid` back to its phone (by the onWhatsApp pairing, never by string-building); any requested phone absent from the response → `failed` with code `"missing"`; `sleep(limiter.batchGapMs())` between batches only. Never log phones.
- [ ] **Step 4: Extend `config.ts`** and `.env.example` (documented defaults and the "safety, not throughput" note).
- [ ] **Step 5: `npm test && npm run typecheck`** → PASS. Commit: `feat(bridge): group helpers, add-job runner and limiter config`.

---

### Task 3: Bridge store and session manager for groups

**Files:**
- Modify: `services/whatsapp-bridge/src/store.ts`, `services/whatsapp-bridge/src/sessions.ts`
- Test: `services/whatsapp-bridge/test/store-groups.test.ts` (method presence + `getDailyActivity` sum shape via a fake supabase builder, same approach as any existing store test), `test/sessions-groups.test.ts` (pure exported helpers)

**Interfaces:**
- Consumes: Task 2's `groups.ts`.
- Produces (store):
  ```ts
  export interface GroupJobRecord { id: string; coachId: string; groupJid: string; status: "queued"|"running"|"done"|"interrupted"; requestedCount: number; results: AddJobResult[]; createdAt: string; startedAt: string | null; finishedAt: string | null }
  export interface GroupPostRecord { id: string; coachId: string; groupJid: string; idempotencyKey: string; status: "accepted"|"sending"|"sent"|"failed"; waMessageId: string | null; error: string | null; dispatchAttempted: boolean; createdAt: string; sentAt: string | null }
  createGroupJob(coachId, groupJid, requestedCount, kind: "add" | "create" = "add", initial?: { results: AddJobResult[]; status: "done" }): Promise<GroupJobRecord>;
  markGroupJobRunning(id): Promise<boolean>;            // queued→running, row-count tells who won
  finishGroupJob(id, results, status: "done"|"interrupted"): Promise<void>;
  getGroupJob(coachId, id): Promise<GroupJobRecord | null>;
  sweepInterruptedGroupJobs(coachId): Promise<void>;     // running→interrupted at boot
  countGroupActivityToday(coachId): Promise<{ addsToday: number; createsToday: number }>; // one query over today's whatsapp_group_jobs: addsToday = Σ requested_count where kind='add'; createsToday = count where kind='create' (a create is inserted already done — Design §4)
  acceptGroupPost(coachId, idempotencyKey, groupJid): Promise<{ record: GroupPostRecord; fresh: boolean }>;
  getGroupPost(coachId, idempotencyKey): Promise<GroupPostRecord | null>;
  claimGroupPost(id): Promise<boolean>; markGroupPostSent(id, waMessageId): Promise<void>; markGroupPostFailed(id, error, dispatchAttempted): Promise<void>;
  ```
- Produces (sessions):
  ```ts
  type QueueItem = { kind: "message"; record: MessageRecord; payload: QueuePayload } | { kind: "group_post"; post: GroupPostRecord; text: string };
  export type GroupCreateOutcome = { kind: "created"; group: { jid: string; subject: string; inviteCode: string | null; participantCount: number; weAreAdmin: boolean }; results: AddJobResult[] } | { kind: "session_not_connected"; status: SessionStatus } | { kind: "group_create_cap_reached"; cap: number } | { kind: "lease_unavailable" } | { kind: "whatsapp_refused" };
  export type GroupAddOutcome = { kind: "queued"; job: GroupJobRecord } | { kind: "session_not_connected"; status: SessionStatus } | { kind: "group_add_cap_reached"; remaining: number } | { kind: "lease_unavailable" };
  export type GroupPostOutcome = { kind: "accepted"; post: GroupPostRecord; fresh: boolean } | { kind: "idempotency_conflict"; existing: GroupPostRecord } | { kind: "session_not_connected"; status: SessionStatus } | { kind: "daily_cap_reached"; cap: number } | { kind: "lease_unavailable" };
  export type GroupInfoOutcome = { kind: "ok"; group: { jid; subject; participantCount; weAreAdmin; inviteCode: string | null } } | { kind: "session_not_connected"; status } | { kind: "group_not_found" };
  SessionManager.createGroup(coachId, input: { subject; description?: string; participants: string[]; announceOnly: boolean; adminAddOnly: boolean }): Promise<GroupCreateOutcome>
  SessionManager.startAddJob(coachId, groupJid, phones: string[]): Promise<GroupAddOutcome>
  SessionManager.postToGroup(coachId, groupJid, text, idempotencyKey): Promise<GroupPostOutcome>
  SessionManager.getGroup(coachId, groupJid): Promise<GroupInfoOutcome>
  SessionManager.revokeGroupInvite(coachId, groupJid): Promise<{ kind: "ok"; inviteCode: string } | { kind: "session_not_connected"; status } | { kind: "group_not_found" }>
  export function weAreAdminIn(meta: { participants: { id: string; admin?: string | null }[] }, ourJids: string[]): boolean; // pure, exported for tests
  export function participantResultsFromCreate(meta: { participants: { id: string }[] }, requested: { phone: string; jid: string | null }[]): AddJobResult[]; // in meta→added; jid null→not_on_whatsapp; else invite_needed
  ```
  `Session` gains `groupLimiter: GroupLimiter` (built once in `doStartSession`, seeded from `countGroupActivityToday`, survives socket bounces like `pacer`) and `groupJobRunning: boolean`.

- [ ] **Step 1: Write the failing tests** — `weAreAdminIn` (our id with `:device` suffix normalised via `jidNormalizedUser` matches `admin: 'superadmin'`), `participantResultsFromCreate` (three branches), and a `drainQueue`-level test is NOT required (it needs a socket); instead pin the queue-item branch with a small exported pure `contentForQueueItem(item)` returning `buildOutboundTextContent(text)` for `group_post`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement store methods** against the 0005 tables; `getDailyActivity` adds today's `whatsapp_group_posts` attempts (`status in ('sent','failed') and dispatch_attempted` or sent) so the pacer's seed counts group frames.
- [ ] **Step 4: Implement `SessionManager` methods.**
  - `createGroup`: connected check → `groupLimiter.reserveCreate()` → `onWhatsApp(...participants)` → `sock.groupCreate(subject, jids)` → if `description` `sock.groupUpdateDescription(jid, description)`; if `announceOnly` `sock.groupSettingUpdate(jid, "announcement")`; if `adminAddOnly` `sock.groupMemberAddMode(jid, "admin_add")`; `inviteCode = await sock.groupInviteCode(jid)` (null on throw); insert a `create` job row `done` with `participantResultsFromCreate`; any throw from `groupCreate` → `whatsapp_refused` (log `err.message` + coachId only, no subject, no phones).
  - `startAddJob`: connected → `reserveAdds(phones.length)` → `createGroupJob` → `void this.runGroupJob(session, job, phones)` which does `markGroupJobRunning`, sets `session.groupJobRunning = true`, runs `runAddJob(sock, limiter, jid, phones, sleep, () => session.status === "connected" && session.sock === sock)`, then `finishGroupJob(id, results, interrupted ? "interrupted" : "done")` and `this.outboundPoke?.schedule()` so the portal reconciles within seconds. One job at a time per session: a second `startAddJob` while `groupJobRunning` still queues (jobs run sequentially via a tiny promise chain on the session).
  - `postToGroup`: mirrors `acceptAndEnqueue` (idempotency first via `getGroupPost`; mismatch on `groupJid` → conflict; connected; `pacer.atDailyCap() || sentTodayCount() + queue.length >= dailyCap`); pushes `{ kind: "group_post" }`.
  - `drainQueue`: branch on `item.kind`; `group_post` skips `onWhatsApp`, claims via `claimGroupPost`, `pacer.recordSend()`, `sock.sendMessage(post.groupJid, buildOutboundTextContent(text))`, `markGroupPostSent`/`markGroupPostFailed(…, mapSendErrorReason("send"), true)`; no poke (the portal reads the ledger on view).
  - `getGroup`/`revokeGroupInvite`: `sock.groupMetadata(jid)` (throw → `group_not_found`), `weAreAdminIn(meta, [sock.user.id, sock.user.lid].filter(Boolean))`, `sock.groupRevokeInvite(jid)`.
  - Boot: in `doStartSession` after the interrupted-message sweep, `await this.store.sweepInterruptedGroupJobs(coachId)`.
- [ ] **Step 5: `npm test && npm run typecheck`** → PASS. Commit: `feat(bridge): group create, paced add jobs and group posts in the session queue`.

---

### Task 4: Bridge routes

**Files:**
- Modify: `services/whatsapp-bridge/src/server.ts`, `services/whatsapp-bridge/README.md` (routes table + "Safety invariants" bullet for groups), `test/server.test.ts` (fake manager gains no-op group methods so existing tests compile)
- Test: `services/whatsapp-bridge/test/server-groups.test.ts` (real server, fake manager/store, like `server.test.ts`)

**Interfaces:**
- Consumes: Task 3's `SessionManager` methods and outcomes; `ServerDeps` gains `groupsEnabled?: boolean` (default `false`), wired from `config.groupsEnabled` in `main.ts`.
- Produces: the six routes in Design §5. Validation constants in `server.ts`: `MAX_GROUP_SUBJECT_LENGTH = 100`, `MAX_GROUP_DESCRIPTION_LENGTH = 2048`, `MAX_GROUP_CREATE_PARTICIPANTS = 5`, `MAX_GROUP_ADD_PARTICIPANTS = 50`.

- [ ] **Step 1: Write the failing route tests**

```ts
test("groups routes are 404 groups_disabled when the flag is off, and all require auth", …); // flag off: POST /groups → 404 {code:"groups_disabled"}; flag on, no bearer → 401
test("POST /groups validates and forwards exactly the path coach id", …); // subject "" → 422 invalid_subject; 101 chars → 422; participants [] or 6 → 422 invalid_participants; a non-E.164 entry → 422 invalid_participants; valid → 201 and fake manager saw coachId === path id, body coachId ignored
test("POST /groups/:jid/participants", …); // bad jid → 422 invalid_group_jid; 51 phones → 422; cap outcome → 429 group_add_cap_reached; queued → 202 with job id
test("POST /groups/:jid/messages replays like /send", …); // fresh → 202 replay:false; replay → 200 replay:true; conflict → 422 idempotency_conflict; text 4097 → 422 invalid_text; bad key → 422 invalid_idempotency_key
test("GET /groups/jobs/:jobId", …); // non-uuid → 400; unknown → 404; found → 200 with results array (phones present: this is the authenticated bridge contract, not a log)
test("GET /groups/:jid and POST /groups/:jid/invite/revoke", …); // group_not_found → 404; ok → 200 without any participant phones
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement the routes** after the existing `send`/`messages` branches; fixed messages only; the `groups_disabled` check runs before any body parsing.
- [ ] **Step 4: README** routes table + invariant: "Group adds are batched (`WA_GROUP_ADD_BATCH`) with a paced gap, capped per day, and the bridge never sends private group invites; the portal sends invite links as ordinary paced 1:1 texts."
- [ ] **Step 5: `npm test && npm run typecheck && npm run build`** → PASS. Commit: `feat(bridge): authenticated group routes behind WA_GROUPS_ENABLED`.

---

### Task 5: Portal pure rules

**Files:**
- Create: `src/lib/groups/rules.ts`, `src/lib/groups/types.ts`, `scripts/test/groups-rules.test.ts`

**Interfaces:**
- Consumes: `normalisePhoneE164`, `isE164` (`src/lib/phone.ts`); `sendingGate` (`src/lib/billing/gate.ts`); types from Task 1.
- Produces:
  ```ts
  export const GROUP_MEMBER_CAP = 256; export const ADD_BATCH_MAX = 50; export const CREATE_PARTICIPANTS_MAX = 5; export const SUBJECT_MAX = 100; export const DESCRIPTION_MAX = 2048; export const POST_TEXT_MAX = 4096;
  export const REASON_GROUPS_DISABLED = "WhatsApp groups aren't switched on for this deployment yet";
  export const REASON_NOT_CONNECTED = "This number isn't connected to WhatsApp. Connect it from the dashboard first";
  export const REASON_CONSENT_REQUIRED = "Tick the box to confirm these people have agreed to be in this group";
  export const REASON_BATCH_TOO_LARGE = `Add up to ${ADD_BATCH_MAX} people at a time`;
  export const REASON_MEMBER_CAP = `A group can have up to ${GROUP_MEMBER_CAP} people in ${brand}`; // function reasonMemberCap(brandName)
  export const REASON_NO_VALID_NUMBERS = "None of those numbers could be read as a phone number";
  export const REASON_OPTED_OUT = "replied STOP to this number — not added";
  export const REASON_INVITE_NEEDED = "their privacy settings only allow invites — invite link sent";
  export const REASON_RECENTLY_LEFT = "left this group recently — WhatsApp won't let them be re-added yet";
  export const REASON_ALREADY_MEMBER = "already in the group";
  export const REASON_NOT_ON_WHATSAPP = "no WhatsApp account on this number";
  export const REASON_GROUP_FULL = "the group is full";
  export const REASON_WHATSAPP_REFUSED = "WhatsApp refused this add";
  export const REASON_INTERRUPTED = "the add was interrupted — try again";
  export const REASON_INVITE_SKIPPED_OPT_OUT = "replied STOP before the invite went out — not invited";
  export type GateInput = { groupsEnabled: boolean; location: { accountId: string | null; activatedAt: string | null } | null; billingStatus: BillingStatus | null; sessionStatus: WhatsappSessionStatus | null; brandName: string };
  export function groupGate(i: GateInput): string | null; // disabled → REASON_GROUPS_DISABLED; location null → sendingGate's REASON_NOT_ACTIVATED; sendingGate reason; sessionStatus !== "connected" → REASON_NOT_CONNECTED; else null
  export function validateSubject(raw: string): { ok: true; value: string } | { ok: false; reason: string };       // trim, 1..100
  export function validateDescription(raw: string): { ok: true; value: string | null } | { ok: false; reason: string }; // trim, "" → null, ≤2048
  export function validatePostText(raw: string): { ok: true; value: string } | { ok: false; reason: string };     // trim, 1..4096
  export interface CandidateMember { phone: string; ghlContactId: string | null; displayName: string | null }
  export function parsePastedNumbers(raw: string): { phone: string }[]; // split on newlines/commas/semicolons, normalisePhoneE164(x, "GB"), drop nulls, dedupe
  export interface AddPlan { toAdd: CandidateMember[]; skippedExisting: number; optedOut: CandidateMember[]; refusal: string | null }
  export function planAddMembers(i: { candidates: CandidateMember[]; existingPhones: Set<string>; optedOutPhones: Set<string>; currentCount: number; consent: boolean; brandName: string }): AddPlan;
  // order: consent → dedupe by phone (first wins) → drop invalid (!isE164) → drop existing → split optedOut → if toAdd.length === 0 && optedOut.length === 0 → REASON_NO_VALID_NUMBERS → toAdd.length > ADD_BATCH_MAX → REASON_BATCH_TOO_LARGE → currentCount + toAdd.length > GROUP_MEMBER_CAP → reasonMemberCap
  export function memberStateForOutcome(o: GroupJobOutcome): { state: GroupMemberState; reason: string | null };
  export function inviteText(brandless: { subject: string; inviteCode: string }): string; // `You're invited to the WhatsApp group "${subject}". Tap to join: https://chat.whatsapp.com/${code}` — ≤ 4096 guaranteed by SUBJECT_MAX
  export function inviteIdempotencyKey(memberId: string): string; // `grp-inv-${memberId}` (uuid chars match the bridge's key regex)
  export interface ReconcilePlan { updates: { memberId: string; state: GroupMemberState; reason: string | null }[]; invites: { memberId: string; phone: string }[] }
  export function reconcileJob(job: WhatsappGroupJob, members: WhatsappGroupMember[], optedOutPhones: Set<string>): ReconcilePlan;
  // for each result: member by phone with jobId === job.id and state 'pending' → state per memberStateForOutcome; outcome invite_needed → if optedOut → state 'opted_out' with REASON_INVITE_SKIPPED_OPT_OUT, else push to invites (state stays 'invite_needed' until the send is accepted — Task 8 flips to 'invite_sent'); job 'interrupted' → every remaining 'pending' member of that job → 'failed' + REASON_INTERRUPTED; members already past 'pending' are never touched (replay safety)
  ```

- [ ] **Step 1: Write the failing tests** covering: `groupGate` precedence (disabled beats everything; billing reason verbatim from `sendingGate`; not connected), `parsePastedNumbers("07700 900123, +447700900123\n00447700900124;rubbish")` → two unique E.164 (Review Focus 1), `planAddMembers` each refusal in order and the opted-out split, `reconcileJob` for a job with results `[200, 403, 403(opted out), 408, 409, 404, 419, 500]` plus an interrupted job, replay (running `reconcileJob` twice over already-updated members yields no updates and no invites), `inviteText` length with a 100-char subject.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: `npm run check`** → PASS. Commit: `feat(groups): pure rules — gate, add planning, reconcile, invite text`.

---

### Task 6: GoHighLevel contacts read

**Files:**
- Modify: `src/lib/ghl.ts` (append), `scripts/test/ghl.test.ts` (or new `scripts/test/groups-contacts.test.ts`)
- Create: `src/lib/groups/contacts.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GhlContactLite { id: string; name: string; phone: string | null; tags: string[] }
  export type ListGhlContactsResult = { ok: true; contacts: GhlContactLite[]; nextStartAfterId: string | null } | { ok: false; kind: "rejected" | "rate_limited" | "unreachable"; error: string };
  /** GET /contacts/?locationId=&limit=100[&query=][&startAfterId=] with Version 2021-07-28 (documented; marked deprecated by GHL, still served). Phones normalised with normalisePhoneE164(raw, "GB"); contacts without a usable phone keep phone: null. */
  export async function listGhlContacts(accessToken: string, locationId: string, opts: { query?: string; startAfterId?: string; limit?: number }): Promise<ListGhlContactsResult>;
  // src/lib/groups/contacts.ts
  export const TAG_SCAN_MAX_PAGES = 5;
  export async function searchContacts(list: typeof listGhlContacts, token: string, locationId: string, query: string): Promise<GhlContactLite[]>; // query trimmed, 2..64 chars else []
  export async function contactsByTag(list: typeof listGhlContacts, token: string, locationId: string, tag: string): Promise<{ contacts: GhlContactLite[]; truncated: boolean }>; // case-insensitive tag match, pages until nextStartAfterId null or TAG_SCAN_MAX_PAGES
  export function tagsFrom(contacts: GhlContactLite[]): string[]; // unique, sorted, for the tag dropdown
  ```
  Response reading is defensive (same posture as `upsertGhlContact`): `contacts[]` with `id`, `phone`, `contactName` or `firstName`+`lastName`, `tags[]`; `meta.startAfterId` or the last contact's id as `nextStartAfterId` when `contacts.length === limit`, else null.

- [ ] **Step 1: Write failing tests** with a scripted `globalThis.fetch` (pattern in `scripts/test/opt-out-repo.test.ts`): URL and headers exact (`Version: 2021-07-28`, bearer), national phone normalised, missing phone → null, 429 → `rate_limited`, `contactsByTag` stops at 5 pages and reports `truncated: true`, tag match is case-insensitive.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: `npm run check`** → PASS. Commit: `feat(ghl): list and search contacts for group membership`.

---

### Task 7: Repository methods and bridge client

**Files:**
- Modify: `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `scripts/test/repository-shape.test.ts` (METHODS), `src/lib/whatsapp-bridge.ts`
- Test: `scripts/test/groups-repo.test.ts` (scripted fetch, as `opt-out-repo.test.ts`), `scripts/test/groups-bridge-client.test.ts`

**Interfaces:**
- Produces (repo):
  ```ts
  createWhatsappGroup(draft: WhatsappGroupDraft): Promise<WhatsappGroup>;
  getWhatsappGroup(id: string): Promise<WhatsappGroup | null>;
  listWhatsappGroupsForAccount(accountId: string): Promise<WhatsappGroup[]>;
  updateWhatsappGroup(id: string, patch: { inviteCode?: string | null; participantCount?: number; weAreAdmin?: boolean; subject?: string; description?: string | null }): Promise<void>;
  insertWhatsappGroupMembers(drafts: WhatsappGroupMemberDraft[]): Promise<WhatsappGroupMember[]>; // on conflict (group_id, phone) do nothing; returns inserted rows
  listWhatsappGroupMembers(groupId: string): Promise<WhatsappGroupMember[]>;
  updateWhatsappGroupMember(id: string, patch: { state: GroupMemberState; lastReason: string | null; inviteIdempotencyKey?: string }): Promise<void>;
  listPendingGroupJobIds(accountId: string): Promise<{ jobId: string; groupId: string }[]>; // distinct job_id of members in state 'pending' for this account's groups
  listAccountsWithPendingGroupMembers(limit?: number): Promise<string[]>; // for the cron/poke reconcile
  getWhatsappGroupJob(id: string): Promise<WhatsappGroupJob | null>;     // reads the bridge-owned table
  listWhatsappGroupPosts(tenantId: string, groupJid: string, limit?: number): Promise<WhatsappGroupPost[]>;
  ```
- Produces (bridge client, same `bridgeFetch`/`toFailure`/validators pattern, exported free functions):
  ```ts
  export interface BridgeGroup { jid: string; subject: string; inviteCode: string | null; participantCount: number; weAreAdmin: boolean }
  export interface BridgeGroupJob { id: string; status: GroupJobStatus; requestedCount: number; results: { phone: string; code: string; outcome: GroupJobOutcome }[]; createdAt: string; finishedAt: string | null }
  export interface BridgeGroupPost { id: string; idempotencyKey: string; status: "accepted"|"sending"|"sent"|"failed"; waMessageId: string | null; error: string | null; createdAt: string; sentAt: string | null }
  export function createWhatsappGroup(coachId, input: { subject; description?: string; participants: string[]; announceOnly: boolean; adminAddOnly: boolean }): Promise<{ ok: true; group: BridgeGroup; results: BridgeGroupJob["results"] } | BridgeFailure>;
  export function addWhatsappGroupParticipants(coachId, groupJid, phones: string[]): Promise<{ ok: true; job: { id: string; status: GroupJobStatus; requestedCount: number } } | BridgeFailure>;
  export function getWhatsappGroupJob(coachId, jobId): Promise<{ ok: true; job: BridgeGroupJob } | BridgeFailure>;
  export function postToWhatsappGroup(coachId, groupJid, text, idempotencyKey): Promise<{ ok: true; replay: boolean; post: BridgeGroupPost } | BridgeFailure>;
  export function getWhatsappGroup(coachId, groupJid): Promise<{ ok: true; group: BridgeGroup } | BridgeFailure>;
  export function revokeWhatsappGroupInvite(coachId, groupJid): Promise<{ ok: true; inviteCode: string } | BridgeFailure>;
  ```
  These are deliberately NOT added to `WhatsappTransport` (a Cloud API transport has no linked-device groups); they are a separate `WhatsappGroupsTransport` interface implemented by the same bridge module, with its own `activeGroupsTransport` const.

- [ ] **Step 1: Failing tests** — repo: exact PostgREST paths/bodies for `insertWhatsappGroupMembers` (`Prefer: resolution=ignore-duplicates,return=representation`, `on_conflict=group_id,phone`), `listPendingGroupJobIds` filter, `updateWhatsappGroupMember`; client: each function's path, body, 2xx mapping, malformed-body → `internal`, `unconfigured` without env; METHODS list updated.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: `npm run check`** → PASS. Commit: `feat(groups): repository methods and bridge groups client`.

---

### Task 8: Groups service

**Files:**
- Create: `src/lib/groups/service.ts`, `scripts/test/groups-service.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, 7; `resolveGhlAccessToken` + `GhlTokenRefreshDeps` (`src/lib/ghl-provider.ts`); `sendWhatsappMessage`.
- Produces:
  ```ts
  export type GroupsRepo = Pick<GhlRepository, "listGhlAccountsForAccount" | "getGhlAccountByLocationId" | "getAccountById" | "getWhatsappSessionSummary" | "isOptedOut" | "createWhatsappGroup" | "getWhatsappGroup" | "listWhatsappGroupsForAccount" | "updateWhatsappGroup" | "insertWhatsappGroupMembers" | "listWhatsappGroupMembers" | "updateWhatsappGroupMember" | "listPendingGroupJobIds" | "getWhatsappGroupJob" | "listWhatsappGroupPosts" | "claimGhlTokenRefresh" | "saveGhlTokens" | "markGhlNeedsReauth">;
  export interface GroupsDeps { groupsEnabled: boolean; brandName: string; now: () => Date; bridge: { createGroup: typeof createWhatsappGroup; addParticipants: typeof addWhatsappGroupParticipants; getJob: typeof getWhatsappGroupJob; post: typeof postToWhatsappGroup; getGroup: typeof getWhatsappGroup; revokeInvite: typeof revokeWhatsappGroupInvite; sendText: typeof sendWhatsappMessage }; ghl: { listContacts: typeof listGhlContacts; token: GhlTokenRefreshDeps }; notify: (text: string) => void }
  export type ServiceResult<T> = { ok: true; value: T } | { ok: false; reason: string };
  export async function createGroup(repo, deps, session: { accountId: string; profileId: string }, input: { locationId: string; subject: string; description: string; announceOnly: boolean; adminAddOnly: boolean; candidates: CandidateMember[]; consent: boolean }): Promise<ServiceResult<{ groupId: string }>>;
  // ownership (location in listGhlAccountsForAccount) → groupGate → validate → planAddMembers(currentCount 1, existing ∅) → first CREATE_PARTICIPANTS_MAX of toAdd go to bridge.createGroup; the rest → addMembers after creation → insert group + members (consent now) → apply create results like a job (reconcile path, invites sent) → notify(`[groups] created: 1 group, ${n} members, ${k} invites`) — never the subject or phones
  export async function addMembers(repo, deps, session, input: { groupId: string; candidates: CandidateMember[]; consent: boolean }): Promise<ServiceResult<{ queued: number; optedOut: number; skippedExisting: number }>>;
  export async function postToGroup(repo, deps, session, input: { groupId: string; text: string; token: string }): Promise<ServiceResult<{ replay: boolean }>>; // idempotencyKey = `grp-post-${token}`; token must match /^[A-Za-z0-9_-]{8,64}$/
  export async function refreshGroup(repo, deps, session, groupId): Promise<ServiceResult<void>>; // bridge.getGroup → updateWhatsappGroup(participantCount, weAreAdmin, inviteCode)
  export async function rotateInviteLink(repo, deps, session, groupId): Promise<ServiceResult<{ inviteCode: string }>>;
  export async function reconcileGroupJobs(repo, deps, accountId: string): Promise<{ jobs: number; invitesSent: number }>; // for each pending job: getWhatsappGroupJob (DB read, no bridge call); status done/interrupted → reconcileJob → updates; invites: re-check isOptedOut, sendText({ coachId: tenantId, to, text: inviteText, idempotencyKey: inviteIdempotencyKey(memberId) }) → ok → state 'invite_sent' + inviteIdempotencyKey; bridge failure → leave 'invite_needed' (retried next pass); session_not_connected → leave; daily_cap_reached → leave
  export async function loadGroupView(repo, deps, session, groupId): Promise<{ group: WhatsappGroup; members: WhatsappGroupMember[]; posts: WhatsappGroupPost[]; locationName: string; gateReason: string | null } | null>; // null when not owned
  export async function contactPickerData(repo, deps, session, locationId, q: { query?: string; tag?: string }): Promise<{ contacts: GhlContactLite[]; tags: string[]; truncated: boolean } | { error: string }>;
  ```
  Ownership rule: every function starts by resolving `groupId` → `getWhatsappGroup` → `group.accountId === session.accountId`, else `{ ok: false, reason: "not_found" }`; tenant/location ids come from that row, never from input.

- [ ] **Step 1: Failing tests** with fakes (shape of `scripts/test/dashboard-row-action.test.ts`'s harness): create happy path (6 candidates → 5 in create call + 1 add job), create with opted-out candidate (never reaches bridge, member row `opted_out`), gate refusals (disabled, billing `paused`, not connected) for create/add/post/rotate while `loadGroupView` still returns the group (Review Focus 5), `postToGroup` same token twice → second `replay: true` and one bridge call (Review Focus 4), `reconcileGroupJobs` sends exactly one invite per `invite_needed` member across two passes (Review Focus 2) and skips an opted-out one, `addMembers` 51 candidates → `REASON_BATCH_TOO_LARGE` with no bridge call, no phone or subject in `notify` text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: `npm run check`** → PASS. Commit: `feat(groups): service — create, add, post, refresh, reconcile`.

---

### Task 9: Server actions and pages

**Files:**
- Create: `src/app/(app)/dashboard/groups/actions.ts`, `page.tsx`, `new/page.tsx`, `[groupId]/page.tsx`; `src/components/groups/{GroupList,GroupForm,MemberPicker,MemberTable,PostForm,InviteLink}.tsx`
- Modify: `src/lib/site/routes.ts` (`groups: "/dashboard/groups"`, `newGroup: "/dashboard/groups/new"`, `groupHref(id)`; add to `NOINDEX_ROUTES`), `scripts/test/site-routes.test.ts`
- Test: `scripts/test/groups-actions.test.ts` (the pure form parsers), `scripts/test/site-routes.test.ts`

**Interfaces:**
- Consumes: Task 8; `requireAccountSession`; `brandConfig`; Next: `notFound`, `redirect`, `revalidatePath` from `next/navigation`/`next/cache` (read `02-guides/server-actions.md` "Choosing a cache update" and `redirecting.md`).
- Produces (`actions.ts`, each `"use server"`, each starts with `requireAccountSession()` and `groupsDeps()`):
  ```ts
  export async function createGroupAction(formData: FormData): Promise<void>;        // fields: location, subject, description, announceOnly, adminAddOnly, consent, pasted, contact (repeated: `${id}|${phone}|${name}`), tag → redirect(groupHref(id)) or redirect(`${SITE_ROUTES.newGroup}?error=<fixed code>`)
  export async function addMembersAction(formData: FormData): Promise<void>;         // group, consent, pasted, contact[], tag → redirect(groupHref(id, { result: "added" | error }))
  export async function postToGroupAction(formData: FormData): Promise<void>;        // group, text, token
  export async function refreshGroupAction(formData: FormData): Promise<void>;
  export async function rotateInviteAction(formData: FormData): Promise<void>;
  export async function searchContactsAction(locationId: string, query: string, tag: string): Promise<{ contacts: GhlContactLite[]; tags: string[]; truncated: boolean } | { error: string }>; // called from the client MemberPicker
  // pure, exported for tests (no Next imports): parseCandidates(formData): CandidateMember[]  — merges contact[] + pasted; parseGroupResult(v): GroupResult | null; GROUP_RESULT_COPY: Record<GroupResult, string>
  ```
  Page rules: all three pages `export const dynamic = "force-dynamic"`, `generateMetadata` with `robots: { index: false }`; `params`/`searchParams` awaited; `GROUPS_ENABLED !== "true"` → `notFound()`. `[groupId]/page.tsx` renders `loadGroupView` (null → `notFound()`), a `gateReason` banner that disables the add/post forms, the invite link (`https://chat.whatsapp.com/<code>` with copy button) and the fixed line "Replies stay in WhatsApp on the phone; they don't appear in GoHighLevel." `PostForm` renders `<input type="hidden" name="token" value={crypto.randomUUID()}>` server-side. `MemberPicker` is a client component: search box + tag select calling `searchContactsAction`, checkboxes producing `contact` inputs, a textarea `pasted`, and the consent checkbox with the exact label "These people have agreed to be in this group".

- [ ] **Step 1: Failing tests** — `parseCandidates` (contact lines with a missing phone are dropped; pasted numbers normalised; duplicates merged, contact wins over pasted for the same phone), `parseGroupResult`, `SITE_ROUTES.groups` in `NOINDEX_ROUTES` and not in `PUBLIC_ROUTES`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** actions, pages and components using existing `Button`, `Card`, `Chip`, `EmptyState`, `Container`. Keep every component under ~150 lines.
- [ ] **Step 4: `npm run check` and `NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`** → PASS (the build is the route/`params` conformance check). Commit: `feat(groups): dashboard pages and actions`.

---

### Task 10: Reconcile hooks, nav link, Slack

**Files:**
- Modify: `src/app/(app)/layout.tsx` (nav "Groups" link only when `process.env.GROUPS_ENABLED === "true"`), `src/app/api/webhooks/crm-outbound-status/route.ts`, `src/app/api/cron/drain/route.ts`
- Test: `scripts/test/groups-service.test.ts` (add: `reconcileAllPendingGroupAccounts` bounds)

**Interfaces:**
- Produces: `export async function reconcileAllPendingGroupAccounts(repo, deps, limit = 20): Promise<{ accounts: number; invitesSent: number }>` in `service.ts`, called after the existing drains in both routes, wrapped so a throw is logged (`[groups] reconcile failed`, no ids beyond the account) and never fails the route. Skipped entirely when `groupsEnabled` is false.

- [ ] **Step 1: Failing test** — with 25 accounts pending, one pass handles 20; a throwing account does not stop the others.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: `npm run check` + build** → PASS. Commit: `feat(groups): reconcile on poke and cron, nav link`.

---

### Task 11: Docs and env tables

**Files:**
- Modify: `docs/GO-LIVE-FOUNDATION.md` (bridge env table: the six `WA_GROUP*` vars; a "Groups first light" checklist under Part 5), `docs/GO-LIVE-ACCOUNTS.md` (web env `GROUPS_ENABLED`; "Known limitations" bullets below; billing line "Groups are included in the per-number price"), `services/whatsapp-bridge/.env.example` (if not done in Task 2)

Known limitations to write verbatim:
- Group replies do not appear in GoHighLevel. Customers read and answer them on the phone.
- Someone with "who can add me to groups" set to My Contacts gets an invite link by WhatsApp message instead of being added. The link is live until "Make a new link" is pressed.
- A person who replies STOP after joining stays in the group (the bridge never removes people in v1).
- Status codes from WhatsApp for adds are observed behaviour, not a published API. An unknown code shows as "WhatsApp refused this add".
- Caps per number per day: 3 groups created, 50 people added, and group posts and invite links count toward the 150 messages.

- [ ] **Step 1:** Write the sections. **Step 2:** `npm test -- --test-name-pattern no-fitclosers` → PASS. Commit: `docs: WhatsApp groups go-live, env and limits`.

---

### Task 12: Site copy for the features section

**Files:**
- Create: `src/lib/site/groups-copy.ts`, `scripts/test/site-groups-copy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GROUPS_FEATURE = {
    title: "WhatsApp groups",
    comingSoonBadge: "Coming soon",
    summary: "Create a WhatsApp group from your own number, add people from your GoHighLevel contacts, share the invite link and post updates, all from your dashboard.",
    points: [
      "Groups are created from the number you've connected, so they show your business name.",
      "Add people by searching your GoHighLevel contacts, picking a tag, or pasting numbers. Anyone whose privacy settings block adds gets the invite link by message instead.",
      "Posts to a group go out with the same pacing and daily limit as your other messages, and people who reply STOP are never added.",
    ],
    honest: "Replies in a group stay in WhatsApp on the phone; they don't appear in GoHighLevel.",
    included: "Included with every connected number. No extra charge.",
  } as const;
  export function groupsFeatureCopy(live: boolean): { badge: string | null } & typeof GROUPS_FEATURE; // badge null when live (FEATURES_GROUPS_LIVE is read by the site branch, which calls this)
  ```

- [ ] **Step 1: Failing test** — copy contains "GoHighLevel" and "invite link", does not contain "unlimited", "instantly", "broadcast", "bulk" or "replies in GoHighLevel"; `groupsFeatureCopy(false).badge === "Coming soon"`, `groupsFeatureCopy(true).badge === null`; no "FitClosers".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: `npm run check`** → PASS. Commit: `site: WhatsApp groups feature copy behind a live flag`.

---

## Owner-only decisions (defaults the plan assumes, flip before execution if wrong)

1. **Dashboard-only v1; GoHighLevel workflow action deferred.** Assumed yes. The workflow action needs the `workflows.readonly` scope (every location re-authorises), per-version GHL review, and the sub-account to pay for "LC Premium Triggers & Actions".
2. **Caps:** 3 groups/day, 50 adds/day per number, 256 members per group, batches of 5 with 8–12 s gaps; posts and invite links share the 150/day. Assumed. These are deliberately tighter than WhatsApp's own limits.
3. **Billing:** included in the per-number price, no add-on. Assumed.
4. **STOP after joining:** the person stays in the group; we only stop adding/inviting them. Alternative: auto-remove (`groupParticipantsUpdate(..., "remove")`) on STOP — not planned.
5. **Invite fallback:** a 1:1 text with the `chat.whatsapp.com` link from the same number (counts toward 150/day), not Baileys' private invite. Assumed.
6. **Group replies:** stay on the phone in v1. Routing group messages into a GoHighLevel conversation (which contact? a group is not a contact) is a separate design.
7. **Flags:** app gate `GROUPS_ENABLED` (server env) and the bridge's `WA_GROUPS_ENABLED`, both default off; the site's `FEATURES_GROUPS_LIVE` only changes the "Coming soon" badge. Deploy order: migration 0005 → bridge with flag off → portal with flag off → flip bridge → flip portal → flip site.
8. **Who can create groups:** any signed-in account user for any of the account's activated, connected numbers (no per-user role). Assumed.
9. **Default group settings:** "only admins can add members" on, "only admins can post" off. Assumed.
10. **"Leave group" / delete from the dashboard:** not in v1 (do it on the phone). Assumed.

## Self-review notes

- Spec coverage: create / name / description / pick contacts by tag or search / add participants / invite link / post a message → Tasks 2–9; WhatsApp realities → Design §3 + Tasks 2, 5, 8; data model 0005 → Task 1; bridge endpoints → Task 4; portal API → Tasks 7–9; gate + billing → Task 5/8 + docs; audit without phones → every task's logging rule + Task 11; site copy + flag → Task 12.
- Type consistency: `GroupJobOutcome`/`GroupMemberState` (Task 1) are what `outcomeForParticipantStatus` (Task 2, bridge-local `ParticipantOutcome` with identical literals), `memberStateForOutcome`/`reconcileJob` (Task 5) and the bridge client (Task 7) use; `AddJobResult` shape `{ phone, code, outcome }` is the same on both sides.
- Review Focus 1–5 each name their pinning task.
