# Reliability (Held Messages + STOP Opt-outs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close go-live gates (a) and (b) in `docs/GO-LIVE-FOUNDATION.md`: messages for a disconnected number are held and sent in order when it reconnects (failed honestly after a maximum hold), and a contact who replies STOP gets nothing more from that number until they reply START.

**Architecture:** Both features live in the portal (Next app) on top of the existing `ghl_outbound_messages` ledger: a new `send_state = 'held'` keeps the row (with its `pending_text`) out of the normal drain until a separate release pass finds the number connected again; a new `whatsapp_opt_outs` table, written by the inbound drain and read before every bridge send, makes STOP per (number, contact). The bridge changes in exactly one place: it pokes the portal when a session reconnects. All decision logic is pure and deps-injected (same shape as `src/lib/ghl-provider.ts`), so `node --test` covers every branch with fakes.

**Tech Stack:** Next.js 16.2.10 (read `node_modules/next/dist/docs/` before touching routes), `@supabase/supabase-js` service-role repo, `node --test` via `scripts/test/alias-hook.mjs`; bridge: TypeScript, `tsx --test`, Node 24.

**Spec:** `docs/GO-LIVE-FOUNDATION.md` "Go-live gates" (a) and (b); the website's promises in `src/lib/site/faq.ts:59-67`, `src/lib/site/sales-copy.ts:59-67`, `src/lib/site/setup-steps.ts:179-184`, `src/lib/site/connect-sheet.ts:63`; rulings W10 (STOP applies per number) and W11 (over-cap messages are reported as not sent, never held).

## Global Constraints

- Work in `/home/user/wa-connector-accounts` on branch `claude/adoring-brown-hvwuyz-accounts`. Never touch `/home/user/wa-connector`, `/home/user/wa-connector-site` or `/home/user/PortalHub`.
- Next.js 16.2.10 conventions (`node_modules/next/dist/docs/`); route handlers stay thin, logic in `src/lib/*` with no Next imports.
- Every string that reaches GoHighLevel's status endpoint is a fixed constant (never upstream text). New constants are added to `GHL_PROVIDER_REASONS` in `src/lib/ghl-provider.ts`.
- W11: a message refused by the bridge with `daily_cap_reached` is reported to GoHighLevel as failed with `REASON_CAP_REACHED`, including during a held release. Never held.
- W10: an opt-out is keyed `(tenant_id, phone)` — one number only. Other numbers in the same account are unaffected.
- Max hold: `OUTBOUND_HOLD_MAX_HOURS` env, integer 1..168, default `24`. Hold is measured from the row's `created_at` (when GoHighLevel asked).
- Idempotency: every resend uses the row's existing `idempotency_key` and `pending_text`; the bridge's replay path makes double sends structurally impossible. No new counters.
- Migration `supabase/migrations/0004_reliability.sql` (renumber to 0005 if a 0004 lands in the merge). Every new table: `enable row level security`, no policies.
- No "FitClosers" wording in `src/` (`scripts/test/no-fitclosers.test.ts`). Brand name via `brandConfig().name`.
- Acceptance for every portal task: `npm run check` and `NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build` pass. Bridge task: `cd services/whatsapp-bridge && npm test` (Node 24; `nvm use 24` if the shell is on 22).
- Commit after every task with a one-line conventional message. Do not push.

## Review Focus

1. A number reconnects while a release pass is mid-flight and drops again: the row must stay `held` (not refused) and the pass must stop sending for that tenant. Pinned in Task 8 (`session_not_connected during release leaves the row held`).
2. STOP arrives after a message for that contact is already `held`: the release must refuse it with `REASON_OPTED_OUT`, never send it. Pinned in Task 8.
3. A contact replies "STOP" then "START" then "stop" within one drain pass: final state opted out; each inbound row still reaches the GHL conversation. Pinned in Task 9.
4. Hold expiry racing a release: the expiry write is guarded `WHERE send_state = 'held'` so a row a concurrent pass just released to `accepted` is never flipped to `refused`. Pinned in Task 5 (repo guard) and Task 8 (expiry test uses the guard).
5. A location with 300 held rows must not starve other locations: `listUnreportedGhlOutboundMessages` excludes `held` rows entirely, and the release lists per tenant. Pinned in Task 5.

---

## Gap table — what the site promises vs what exists

| Promise (file:line) | Today (file:line) | Gap |
|---|---|---|
| "That number's messages are held … send when the phone reconnects" (`faq.ts:62`, `sales-copy.ts:63`, `setup-steps.ts:182-183`, `connect-sheet.ts:63`) | `session_not_connected` is in `TERMINAL_BRIDGE_FAILURE_CODES` (`src/lib/ghl-provider.ts:357-371`); the webhook refuses with `REASON_NOT_CONNECTED` and reports failed (`:732-735`); the drain's retry does the same (`:1559-1567`). The bridge itself refuses at accept time (`services/whatsapp-bridge/src/sessions.ts:1251-1253`). | No hold state at all. Tasks 1, 3, 5, 7, 8. |
| "the dashboard shows … how many messages are waiting" (`faq.ts:62`, `sales-copy.ts:63`) | `LocationRow.heldMessages`/`state.waiting` exist (`src/lib/account-data/types.ts:17-30`, `map.ts:17,43`) but count only `send_state = 'pending_send'` (`src/lib/data/supabase.ts:1287`), i.e. bridge-unreachable retries, never a disconnected phone. Rendered at `LocationTable.tsx:16`, `LocationRowDetail.tsx:41`. | Count must include `held`. Task 5, 11. |
| In-GHL page shows waiting count | `WhatsappConnectionPanel.tsx:755-771` (disconnected branch) shows the reason and Reconnect only; `GhlEmbedWhatsappSummary` has no count (`types.ts:83`, `crm/embed/session/route.ts:146-149`, `connect/session/logic.ts:126-129`). | Task 11. |
| "Reconnect … and the held messages send" (`setup-steps.ts:183`) | Bridge `connection === "open"` handler (`sessions.ts:1001-1010`) drains its own in-memory queue; it never pokes the portal, so held rows would wait for the hourly cron. | Task 4 (poke on open) + Task 8 (release pass on poke). |
| Over-cap messages "reported back to GoHighLevel as not sent" (`faq.ts:71`, `sales-copy.ts:59`, `setup-steps.ts:184`; W11) | Already true for the webhook/drain paths (`daily_cap_reached` terminal, `REASON_CAP_REACHED` `ghl-provider.ts:271`). | Keep true during release. Task 8. |
| "If someone replies STOP, they get no more messages from that number" (`faq.ts:66`, `sales-copy.ts:67`; W10) | Inbound drain pushes every reply to GHL (`src/lib/ghl-inbound.ts:366-497`); no keyword handling anywhere (`inbound.ts` bridge side is pure classify; `ghl-provider.ts` never checks the recipient). | Tasks 1, 2, 6, 7, 9. |
| "Opt-outs (STOP) from this number" stat (`LocationRowDetail.tsx:53`) | Hard-coded `optOuts: 0` (`map.ts:43-44`). | Task 6, 11. |
| "They're opted out straight away" (`faq.ts:66`) | — | Effective once the inbound poke drains (seconds; hourly cron backstop). A message already queued inside the bridge's paced queue still goes out. Documented in Task 12, not engineered around. |

## File map

New:
- `supabase/migrations/0004_reliability.sql` — `held` send state, held index, `whatsapp_opt_outs`.
- `src/lib/opt-out.ts` — pure STOP/START keyword classifier.
- `src/lib/ghl-held-rules.ts` — pure hold/expiry decisions + env.
- `src/lib/ghl-held.ts` — `releaseHeldOutboundMessages` pass.
- `scripts/test/opt-out.test.ts`, `scripts/test/ghl-held-rules.test.ts`, `scripts/test/ghl-held.test.ts`, `scripts/test/reliability-schema.test.ts`.

Modified:
- `src/lib/types.ts` — `GhlOutboundSendState` gains `"held"`; `WhatsappSessionSummary.heldMessages`; `OptOut` type.
- `src/lib/data/repository.ts`, `src/lib/data/supabase.ts` — held + opt-out methods; `listUnreportedGhlOutboundMessages` excludes held; `getLocationStats` counts held; summaries carry `heldMessages`.
- `src/lib/ghl-provider.ts` — hold on `session_not_connected`, opt-out refusal, exports for the release pass.
- `src/lib/ghl-inbound.ts` — STOP/START detection and persistence.
- `src/lib/ghl.ts` — optional `setGhlContactDnd` (Task 10).
- `src/app/api/cron/drain/route.ts`, `src/app/api/webhooks/crm-outbound-status/route.ts` — call the release pass.
- `src/app/api/crm/embed/session/route.ts`, `src/app/api/connect/session/logic.ts`, `src/components/whatsapp/WhatsappConnectionPanel.tsx`, `src/lib/account-data/map.ts`, `src/lib/account-data/supabase.ts` — waiting + opt-out counts.
- `services/whatsapp-bridge/src/sessions.ts`, `services/whatsapp-bridge/test/sessions-poke.test.ts` — poke on open.
- `scripts/test/repository-shape.test.ts`, `scripts/test/ghl.test.ts`, `scripts/test/ghl-inbound.test.ts`, `scripts/test/account-data-map.test.ts` — extended.
- `docs/GO-LIVE-FOUNDATION.md` — gates (a)(b) and the two new env vars.

## Parallel groups

- **Group A (parallel, no dependencies):** Task 1, Task 2, Task 3, Task 4.
- **Group B (after A):** Task 5, Task 6 (parallel with each other).
- **Group C (after B):** Task 7 → Task 8 (sequential: 8 uses 7's exports); Task 9 (parallel with 7/8); Task 10 after 9 (owner-gated).
- **Group D (after B, parallel with C):** Task 11.
- **Task 12 last.**

---

### Task 1: Migration 0004 and shared types

**Files:**
- Create: `supabase/migrations/0004_reliability.sql`
- Modify: `src/lib/types.ts:220` (`GhlOutboundSendState`), `src/lib/types.ts:44-62` (`WhatsappSessionSummary`), add `OptOut` interface near `WhatsappInboundMessage`.
- Test: `scripts/test/reliability-schema.test.ts` (same style as `scripts/test/accounts-schema.test.ts`: read the SQL, regex-assert).

**Interfaces:**
- Produces: `GhlOutboundSendState = "pending_send" | "held" | "accepted" | "refused"`; `WhatsappSessionSummary.heldMessages: number`; `interface OptOut { tenantId: string; phone: string; optedOutAt: string; keyword: string; ghlContactId: string | null }`.

- [ ] **Step 1: Write the failing schema test**

```ts
const sql = readFileSync(join(process.cwd(), "supabase/migrations/0004_reliability.sql"), "utf8");
test("held send_state", () => {
  assert.match(sql, /alter table public\.ghl_outbound_messages drop constraint ghl_outbound_messages_send_state_check/);
  assert.match(sql, /check \(send_state in \('pending_send', 'held', 'accepted', 'refused'\)\)/);
  assert.match(sql, /create index ghl_outbound_held_idx on public\.ghl_outbound_messages \(tenant_id, created_at\)\s+where send_state = 'held'/);
});
test("whatsapp_opt_outs", () => {
  assert.match(sql, /create table public\.whatsapp_opt_outs/);
  assert.match(sql, /tenant_id\s+uuid not null references public\.whatsapp_tenants \(id\) on delete cascade/);
  assert.match(sql, /phone\s+text not null[\s\S]*phone ~ '\^\\\+\[1-9\]\[0-9\]\{6,14\}\$'/);
  assert.match(sql, /keyword\s+text not null check \(char_length\(keyword\) <= 16\)/);
  assert.match(sql, /ghl_contact_id\s+text/);
  assert.match(sql, /primary key \(tenant_id, phone\)/);
  assert.match(sql, /alter table public\.whatsapp_opt_outs enable row level security/);
  assert.doesNotMatch(sql, /create policy/);
});
```

- [ ] **Step 2: Run it** — `npm test -- --test-name-pattern "held send_state"` → FAIL (file missing).
- [ ] **Step 3: Write the migration** with a header comment stating: `held` keeps `pending_text` (0070's clear-on-leave rule now reads "cleared when leaving `pending_send`/`held`"); the opt-out table is per (tenant, phone) = per number (W10); `opted_out_at timestamptz not null default now()`; `keyword` is the canonical matched word (`STOP`, `UNSUBSCRIBE`, …); comment on table.
- [ ] **Step 4: Update types** as in Interfaces. Fix the compile errors in `mapWhatsappSessionSummary` by adding a `heldMessages` parameter defaulting to `0` (Task 5 computes it).
- [ ] **Step 5: `npm run check`** → PASS. Commit: `feat(db): 0004 held send state and whatsapp_opt_outs`.

---

### Task 2: Pure STOP/START classifier

**Files:**
- Create: `src/lib/opt-out.ts`, `scripts/test/opt-out.test.ts`

**Interfaces:**
- Produces: `export type OptOutDecision = { kind: "opt_out"; keyword: string } | { kind: "opt_in"; keyword: string } | null;` `export function classifyOptOutMessage(body: string | null): OptOutDecision;` `export const OPT_OUT_KEYWORDS = ["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "END", "QUIT", "OPT OUT", "OPTOUT"] as const;` `export const OPT_IN_KEYWORDS = ["START", "UNSTOP", "SUBSCRIBE", "OPT IN", "OPTIN"] as const;` `export const MAX_KEYWORD_BODY_LENGTH = 32;`

- [ ] **Step 1: Write the failing tests**

```ts
test("whole-message STOP variants, case-insensitive, trailing punctuation ignored", () => {
  for (const b of ["STOP", "stop", " Stop ", "STOP.", "stop!!", "Stop all", "STOPALL", "unsubscribe", "Cancel", "END", "quit", "opt out", "OPTOUT", "stop\n"])
    assert.deepEqual(classifyOptOutMessage(b), { kind: "opt_out", keyword: expectedKeywordFor(b) }); // e.g. "stop!!" -> "STOP", "Stop all" -> "STOP ALL"
});
test("START variants opt back in", () => {
  for (const b of ["START", "start", "Unstop", "SUBSCRIBE", "opt in", "OPTIN"]) assert.equal(classifyOptOutMessage(b)?.kind, "opt_in");
});
test("not whole-message: null", () => {
  for (const b of ["please stop", "stop sending me this", "I want to stop", "stop. thanks", "yes", "", "   ", null, "x".repeat(33)]) assert.equal(classifyOptOutMessage(b), null);
});
test("internal whitespace collapses: 'STOP   ALL' -> STOP ALL; NBSP is whitespace", () => {
  assert.deepEqual(classifyOptOutMessage("STOP  ALL"), { kind: "opt_out", keyword: "STOP ALL" });
});
```

- [ ] **Step 2: Run** `npm test -- --test-name-pattern "whole-message STOP"` → FAIL (module missing).
- [ ] **Step 3: Implement** — normalise: return `null` if `body === null` or `body.length > MAX_KEYWORD_BODY_LENGTH`; `body.trim().replace(/[\s ]+/g, " ").replace(/[.!?,;:]+$/, "").trim().toUpperCase()`; exact match against the two lists.
- [ ] **Step 4: Run** → PASS. Commit: `feat: STOP/START keyword classifier`.

---

### Task 3: Pure hold rules

**Files:**
- Create: `src/lib/ghl-held-rules.ts`, `scripts/test/ghl-held-rules.test.ts`

**Interfaces:**
- Produces:
  - `export const DEFAULT_HOLD_MAX_HOURS = 24;`
  - `export function holdMaxHours(env: NodeJS.ProcessEnv = process.env): number` — `OUTBOUND_HOLD_MAX_HOURS` parsed as integer, accepted only in 1..168, else default.
  - `export function heldExpiredReason(hours: number): string` → `` `phone was disconnected for more than ${hours} hours — message not sent` ``.
  - `export const REASON_NUMBER_BANNED = "this WhatsApp number has been banned by WhatsApp — message not sent";`
  - `export type NotConnectedDecision = { kind: "hold" } | { kind: "refuse"; reason: string };`
  - `export function decideNotConnected(summary: WhatsappSessionSummary | null, notConnectedReason: string): NotConnectedDecision` — hold iff `summary !== null && summary.lastConnectedAt !== null && status ∈ {"disconnected","waiting_qr","logged_out"}`; `"banned"` → refuse `REASON_NUMBER_BANNED`; otherwise (never linked / no row / `"connected"` yet bridge said no) → refuse `notConnectedReason`.
  - `export function isHeldExpired(createdAtIso: string, nowMs: number, maxHours: number): boolean`.

- [ ] **Step 1: Write the failing tests** — one assertion per rule above, including: `holdMaxHours({OUTBOUND_HOLD_MAX_HOURS:"0"}) === 24`, `"168" → 168`, `"169" → 24`, `"abc" → 24`; `heldExpiredReason(24)` exact string; `decideNotConnected(null, R)` → refuse R; disconnected with `lastConnectedAt` → hold; `waiting_qr` + `lastConnectedAt: null` → refuse R; `logged_out` + linked → hold; `banned` → refuse `REASON_NUMBER_BANNED`; `isHeldExpired("2026-10-15T00:00:00Z", Date.parse("2026-10-16T00:00:01Z"), 24) === true` and `…T23:59:59Z` false.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. Commit: `feat: hold rules for disconnected numbers`.

---

### Task 4: Bridge pokes the portal when a session reconnects

**Files:**
- Modify: `services/whatsapp-bridge/src/sessions.ts:300-326` (add beside `recordSent`), `:1001-1010` (open handler).
- Test: `services/whatsapp-bridge/test/sessions-poke.test.ts`.

**Interfaces:**
- Produces: `export function recordReconnected(poke: PortalPoke | null): void` — `poke?.schedule()`. Called in the `connection === "open"` branch after `void this.drainQueue(session)` with `this.outboundPoke`.

- [ ] **Step 1: Write the failing test** — `recordReconnected(poke)` schedules exactly one poke; `recordReconnected(null)` does not throw.
- [ ] **Step 2: Run** `cd services/whatsapp-bridge && npm test` → FAIL (not exported).
- [ ] **Step 3: Implement** with a JSDoc: "the portal's held-message release pass runs on this poke (src/lib/ghl-held.ts); the hourly cron is the backstop (hard rule 6)". Add one line to `services/whatsapp-bridge/README.md` under the outbound poke description.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` → PASS. Commit: `feat(bridge): poke portal on session reconnect`.

---

### Task 5: Repository — held rows

**Files:**
- Modify: `src/lib/data/repository.ts` (interface + JSDoc), `src/lib/data/supabase.ts:674-744` and `:1256-1312` and `:83-100`/`:444`, `scripts/test/repository-shape.test.ts` (METHODS list + count), the fake repos in `scripts/test/ghl.test.ts:364` and `scripts/test/ghl-inbound.test.ts` (add no-op/in-memory versions of the new methods so they still satisfy `GhlProviderRepo` after Task 7).

**Interfaces:**
- Produces (added to `GhlRepository`):
  - `updateGhlOutboundSendState(id, patch: { sendState; sendAttempts?; refusalReason?; onlyIfSendState?: GhlOutboundSendState })` — `pending_text` is cleared only when `sendState ∉ {"pending_send","held"}`; existing automatic `pending_send` guard kept; `onlyIfSendState` adds `.eq("send_state", onlyIfSendState)`.
  - `listHeldTenantIds(): Promise<string[]>` — distinct `tenant_id` with `send_state = 'held'` (select `tenant_id` where held, dedupe in code; cap 1000 rows).
  - `listHeldGhlOutboundMessages(tenantId: string, limit?: number): Promise<GhlOutboundMessage[]>` — oldest first, default 50.
  - `listExpiredHeldGhlOutboundMessages(cutoffIso: string, limit?: number): Promise<GhlOutboundMessage[]>` — held AND `created_at < cutoff`, oldest first, default 50.
  - `countHeldByTenant(tenantIds: string[]): Promise<Map<string, number>>` — counts `send_state in ('pending_send','held')` (the "waiting" definition, same as `getLocationStats.pendingSend`).
  - `listUnreportedGhlOutboundMessages` now adds `.neq("send_state", "held")`.
  - `getLocationStats`: `if (r.send_state === "pending_send" || r.send_state === "held") stats.pendingSend += 1;`
  - `getWhatsappSessionSummary` / `getWhatsappSessionSummaries` / `getWhatsappSessionSummariesForTenants` populate `heldMessages` via `countHeldByTenant`.

- [ ] **Step 1: Update `repository-shape.test.ts`** — add the four new names, bump both `44` literals to `48`. Run → FAIL.
- [ ] **Step 2: Add JSDoc to `repository.ts`** for each method stating the exclusion rule (held rows never appear in `listUnreportedGhlOutboundMessages`: Review Focus 5) and the guard rule (Review Focus 4).
- [ ] **Step 3: Implement in `supabase.ts`.** Follow `listUnreportedGhlOutboundMessages`'s query shape; `countHeldByTenant` selects `tenant_id, send_state` with `.in("tenant_id", ids).in("send_state", ["pending_send","held"])` and counts in code (page 1000 like `getLocationStats`).
- [ ] **Step 4: Extend the fake repos** in both test files (in-memory `Map` of rows is already there in `ghl.test.ts`'s `createFakeRepo`; implement the new methods against it, honour `onlyIfSendState`, exclude held from `listUnreportedGhlOutboundMessages`, keep `pendingText` for held).
- [ ] **Step 5: `npm run check`** → PASS. Commit: `feat(repo): held outbound rows`.

---

### Task 6: Repository — opt-outs

**Files:**
- Modify: `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `scripts/test/repository-shape.test.ts` (→ `52`), fake repos (`ghl.test.ts`, `ghl-inbound.test.ts`: in-memory `Map<string, OptOut>` keyed `${tenantId}:${phone}`).

**Interfaces:**
- Produces (added to `GhlRepository`):
  - `recordOptOut(input: { tenantId: string; phone: string; keyword: string; ghlContactId: string | null }): Promise<void>` — upsert on `(tenant_id, phone)`, sets `opted_out_at = now()`.
  - `clearOptOut(tenantId: string, phone: string): Promise<void>` — delete; no-op if absent.
  - `isOptedOut(tenantId: string, phone: string): Promise<boolean>`.
  - `countOptOutsByTenant(tenantIds: string[]): Promise<Map<string, number>>`.

- [ ] **Step 1: Update shape test** (`48` → `52`, names added). Run → FAIL.
- [ ] **Step 2: Implement** (`.upsert(row, { onConflict: "tenant_id,phone" })`; counts in code as Task 5).
- [ ] **Step 3: Extend fake repos.** **Step 4: `npm run check`** → PASS. Commit: `feat(repo): whatsapp_opt_outs`.

---

### Task 7: Provider — hold on disconnect, refuse opted-out contacts

**Files:**
- Modify: `src/lib/ghl-provider.ts` (`GhlProviderRepo` Pick `:113-130`; reasons `:262-307`; `handleProviderOutboundMessage` `:651-735`; `retryGateReason` `:1316-1320`; `drainPendingSend` `:1447-1567`; `GHL_PROVIDER_REASONS` `:1612`).
- Test: `scripts/test/ghl.test.ts`.

**Interfaces:**
- Consumes: Task 3's `decideNotConnected`, `REASON_NUMBER_BANNED`; Task 5/6 repo methods.
- Produces:
  - `GhlProviderRepo` Pick adds `"getWhatsappSessionSummary" | "isOptedOut"`.
  - `export const REASON_OPTED_OUT = "contact replied STOP to this number — not sent (they can reply START to opt back in)";` exported via `GHL_PROVIDER_REASONS.optedOut`, plus `.numberBanned`.
  - `HandleProviderOutboundOutcome` gains `| { kind: "held" }`.
  - `export async function outboundRefusalReason(repo: GhlProviderRepo, account: GhlAccount | null, toPhone: string | null): Promise<string | null>` — replaces `retryGateReason`: billing gate first, then `isOptedOut(account.tenantId, toPhone)` → `REASON_OPTED_OUT`.
  - `export async function resolveNotConnected(repo, account, row): Promise<NotConnectedDecision>` — reads `repo.getWhatsappSessionSummary(account.tenantId)` and calls `decideNotConnected(summary, REASON_NOT_CONNECTED)`; on `hold` writes `updateGhlOutboundSendState(row.id, { sendState: "held" })`.
  - Exports `reportGhlOutcome`, `mapBridgeFailureReason`, `isTransientBridgeFailure` (Task 8 reuses them).

- [ ] **Step 1: Write the failing tests** (fake repo seeded with `whatsapp_sessions` summaries via a new `sessionsByTenant` map in `createFakeRepo`):

```ts
test("webhook: bridge says session_not_connected for a previously linked number -> row held, no status report", async () => {
  // summary { status: "disconnected", lastConnectedAt: "2026-10-15T10:00:00Z" }; deps.sendWhatsapp -> { ok:false, code:"session_not_connected" }
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "held" });
  assert.equal(rows[0].sendState, "held"); assert.equal(rows[0].pendingText, "hello from GHL"); assert.equal(deps.statusCalls.length, 0);
});
test("webhook: session_not_connected for a never-linked number -> refused REASON_NOT_CONNECTED, reported failed", …);
test("webhook: banned number -> refused numberBanned", …);
test("webhook: opted-out contact -> refused optedOut BEFORE any bridge call, reported failed", async () => { assert.equal(deps.sendCalls.length, 0); });
test("webhook: opt-out is per number: same phone opted out on tenant B still sends on tenant A", …);
test("drain pending_send: bridge now says session_not_connected for a linked number -> held (not refused)", …);
test("drain pending_send: contact opted out since -> refused optedOut, no resend", …);
```

- [ ] **Step 2: Run** `npm test -- --test-name-pattern "session_not_connected"` → FAIL.
- [ ] **Step 3: Implement.** In `handleProviderOutboundMessage`, after the gate (`:657-662`) and before `mediaSplit`: `if (toPhone && await repo.isOptedOut(account.tenantId, toPhone))` → same three-line refuse pattern with `REASON_OPTED_OUT`. After `sendResult` (`:714`): `if (!sendResult.ok && sendResult.code === "session_not_connected") { const d = await resolveNotConnected(repo, account, row); if (d.kind === "hold") return { kind: "held" }; refuse with d.reason; }` — before the transient check. Mirror in `drainPendingSend` (held → `result.stillPending++`? no: add `held: number` to `DrainGhlOutboundStatusesResult` and `result.held++`; the cron log line prints it). Replace `retryGateReason` with `outboundRefusalReason(repo, account, row.toPhone)` at `:1534` and in `retryTextPart`. Keep `session_not_connected` in `TERMINAL_BRIDGE_FAILURE_CODES` (the media path still refuses it; note in a comment that multipart rows are out of scope for holding while `WA_MEDIA_OUTBOUND_ENABLED` is off by default). Update the header status table.
- [ ] **Step 4: Run** → PASS. `npm run check`. Commit: `feat(provider): hold while disconnected, refuse STOP opt-outs`.

---

### Task 8: Held release pass + route wiring

**Files:**
- Create: `src/lib/ghl-held.ts`, `scripts/test/ghl-held.test.ts`
- Modify: `src/app/api/cron/drain/route.ts:58-80`, `src/app/api/webhooks/crm-outbound-status/route.ts:55-57`, `docs/GO-LIVE-FOUNDATION.md` (gate (a) + `OUTBOUND_HOLD_MAX_HOURS` in the Vercel env table).

**Interfaces:**
- Consumes: Task 7 exports; Task 3; Task 5 repo methods; `GhlProviderDeps`.
- Produces:
  - `export type GhlHeldRepo = GhlProviderRepo & Pick<GhlRepository, "listHeldTenantIds" | "listHeldGhlOutboundMessages" | "listExpiredHeldGhlOutboundMessages" | "getWhatsappSessionSummariesForTenants">;`
  - `export interface ReleaseHeldResult { tenantsChecked: number; released: number; stillHeld: number; expired: number; refused: number; reportFailed: number; timeBudgetExceeded: boolean }`
  - `export async function releaseHeldOutboundMessages(repo: GhlHeldRepo, deps: GhlProviderDeps = defaultGhlProviderDeps, nowMs: number = Date.now(), env = process.env): Promise<ReleaseHeldResult>` — never throws.
  - Algorithm (the one part the signature does not determine):
    1. Expiry: `cutoff = nowMs - holdMaxHours(env)*3600_000`; for each `listExpiredHeldGhlOutboundMessages(cutoffIso, 50)`: `updateGhlOutboundSendState(id, { sendState: "refused", refusalReason: heldExpiredReason(hours), onlyIfSendState: "held" })`, then `reportGhlOutcome(..., "failed", reason)`; `expired++`.
    2. Release: `tenants = listHeldTenantIds()`; `summaries = getWhatsappSessionSummariesForTenants(tenants)`; for each tenant whose summary `status === "connected"`: rows = `listHeldGhlOutboundMessages(tenantId, 50)` oldest-first; for each row: `account = getGhlAccountByLocationId(row.locationId)`; `reason = outboundRefusalReason(repo, account, row.toPhone)` → refuse+report; else `sendWhatsapp({ coachId: row.tenantId, to: row.toPhone, text: row.pendingText, idempotencyKey: row.idempotencyKey })`: ok → `accepted`, `released++`; `session_not_connected` → `stillHeld++` and **break this tenant's loop**; `daily_cap_reached` → refuse `REASON_CAP_REACHED` + report (W11), continue; other terminal → refuse `mapBridgeFailureReason(code)` + report; transient → `stillHeld++`, continue. Rows with `toPhone === null || pendingText === null` → refuse `REASON_BRIDGE_UNREACHABLE_EXHAUSTED` (defensive, mirrors `drainPendingSend`).
    3. 25 s wall-clock budget checked before each row, as `DRAIN_TIME_BUDGET_MS`.

- [ ] **Step 1: Write the failing tests** (fake repo from `ghl.test.ts` extracted into a shared helper if simpler, else re-declared):

```ts
test("connected tenant: held rows released oldest-first under their original keys and text", …); // assert sendCalls order and idempotencyKey/text equality; rows now accepted
test("disconnected tenant: untouched, stillHeld counts, zero sends", …);
test("mid-release drop: second send returns session_not_connected -> first row accepted, rest stay held, loop stops", …); // Review Focus 1
test("daily cap during release: refused capReached and reported failed, next row still attempted", …); // W11
test("opted out since being held: refused optedOut, never sent", …); // Review Focus 2
test("expired (created_at older than 24h): refused with heldExpiredReason(24), reported failed", …);
test("expiry guard: a row released to accepted by a concurrent pass is not refused (onlyIfSendState)", …); // Review Focus 4
test("OUTBOUND_HOLD_MAX_HOURS=48: a 30h-old row is not expired", …);
test("never throws when listHeldTenantIds rejects", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/lib/ghl-held.ts` per the algorithm. **Step 4: Run** → PASS.
- [ ] **Step 5: Wire routes.** In both routes call `await releaseHeldOutboundMessages(repo)` immediately before `drainGhlOutboundStatuses(repo)`; cron response adds `heldRelease` and logs `released/stillHeld/expired` when non-zero; poke route spreads nothing new (keeps `{ ok: true, ...result }`) but awaits the release first.
- [ ] **Step 6: Docs.** In `GO-LIVE-FOUNDATION.md`: gate (a) → "Built — `src/lib/ghl-held.ts`; max hold `OUTBOUND_HOLD_MAX_HOURS` (default 24)"; add the env var to the Vercel env list.
- [ ] **Step 7: `npm run check` and build** → PASS. Commit: `feat: release held messages on reconnect; expire after max hold`.

---

### Task 9: Inbound — honour STOP and START

**Files:**
- Modify: `src/lib/ghl-inbound.ts` (`GhlInboundRepo` `:190-199`; `processGhlInboundRow` `:366-410`), `scripts/test/ghl-inbound.test.ts`, `docs/GO-LIVE-FOUNDATION.md` gate (b).

**Interfaces:**
- Consumes: Task 2 `classifyOptOutMessage`; Task 6 `recordOptOut`/`clearOptOut`.
- Produces: `GhlInboundRepo` adds `"recordOptOut" | "clearOptOut"`; `DrainGhlInboundRepliesResult` adds `optedOut: number; optedIn: number`; `export async function applyOptOutKeyword(repo: Pick<GhlInboundRepo,"recordOptOut"|"clearOptOut">, row: WhatsappInboundMessage, ghlContactId: string | null): Promise<"opt_out" | "opt_in" | null>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("STOP reply: opt-out recorded for (tenant, phone) with keyword STOP, reply still pushed to GHL", …);
test("START after STOP clears the opt-out; a later 'stop' re-records it (final state opted out), all three rows pushed", …); // Review Focus 3
test("STOP for tenant A does not opt the phone out on tenant B", …);
test("non-keyword reply writes nothing to opt-outs", …);
test("opt-out is recorded even when the GHL push later fails (ordering: before upsert/claim)", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — call `applyOptOutKeyword(repo, row, null)` immediately after the exhaustion pre-check (`:381-390`) and before `getGhlAccountByTenantId`; it is idempotent so a retried row is harmless. Increment the result counters. (Task 10 passes the real `contactId` for DND; until then `null`.)
- [ ] **Step 4: Run** → PASS; `npm run check`. Docs: gate (b) → "Built — `src/lib/opt-out.ts` + `src/lib/ghl-inbound.ts`; keywords listed". Commit: `feat(inbound): STOP/START opt-outs per number`.

---

### Task 10 (owner decision — skip if DND sync declined): optional GoHighLevel DND sync

**Files:**
- Modify: `src/lib/ghl.ts` (after `upsertGhlContact` `:848`), `src/lib/ghl-inbound.ts`, `scripts/test/ghl-inbound.test.ts`, `docs/GO-LIVE-FOUNDATION.md` env table.

**Interfaces:**
- Produces: `export function isGhlDndSyncEnabled(): boolean` (`GHL_SYNC_DND === "true"`); `export async function setGhlContactDnd(accessToken: string, contactId: string, dnd: boolean): Promise<{ ok: true } | { ok: false; error: string }>` — `PUT ${API_BASE}/contacts/${contactId}` body `{ dnd }`, 5 s timeout, fixed error strings (`"dnd update rejected: HTTP <status>"` / `"dnd update unreachable"`); `GhlInboundDeps.setContactDnd` with the real function as default.

- [ ] **Step 1: Tests** — with the flag on, a STOP row calls `setContactDnd(token, contactId, true)` once after the contact upsert; START calls with `false`; flag off → never called; a failing DND call does not change the row's resolution (`ghl_pushed`) and logs once.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — in `processGhlInboundRow`, after `contactId` is known and before the claim; fire-and-await with its own try/catch; move the `applyOptOutKeyword` call's `ghlContactId` to the resolved id when known (re-run `recordOptOut` is idempotent). **Step 4:** PASS, `npm run check`. Commit: `feat: optional GoHighLevel DND sync on STOP/START`.

---

### Task 11: Dashboard and in-GHL page counts

**Files:**
- Modify: `src/lib/account-data/map.ts:43-44` and `:51-60`, `src/lib/account-data/supabase.ts:12,51-65`, `src/app/api/crm/embed/session/route.ts:146-149`, `src/app/api/connect/session/logic.ts:126-129`, `src/components/whatsapp/WhatsappConnectionPanel.tsx:755-771`, `scripts/test/account-data-map.test.ts`, `scripts/test/embed-states.test.ts` or `scripts/test/ghl-embed.test.ts` (whichever already fixtures the summary shape).

**Interfaces:**
- Consumes: `WhatsappSessionSummary.heldMessages` (Task 1/5), `countOptOutsByTenant` (Task 6).
- Produces: `toLocationRow(loc, summary, stats, now, dailyCap, optOuts: number)`; `GhlEmbedWhatsappSummary` carries `heldMessages` (enumerated explicitly in both builders — never spread); panel copy in the disconnected branch when `summary.heldMessages > 0`: `` `${n} ${n === 1 ? "message" : "messages"} waiting — they send when the phone reconnects` ``.

- [ ] **Step 1: Tests** — `toLocationRow(..., 3).optOuts === 3`; `toWhatsappState(true, summary({status:"disconnected"}), 4)` unchanged (`waiting: 4`); embed/connect summary builders include `heldMessages` and still exclude `coachId`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `SupabaseAccountDataSource.listLocations` adds `countOptOutsByTenant` to its `Promise.all` and the repo Pick (`:12`). **Step 4:** PASS; `npm run check`; build. Commit: `feat(ui): waiting and opt-out counts`.

---

### Task 12: Go-live gate check and full acceptance

**Files:**
- Modify: `docs/GO-LIVE-FOUNDATION.md` "Go-live gates" (both gates marked built, with the known limit: a message already inside the bridge's paced queue when STOP arrives still sends; opt-outs take effect within poke latency, hourly at worst), `services/whatsapp-bridge/README.md` (reconnect poke).

- [ ] **Step 1:** Re-read `src/lib/site/faq.ts:59-72`, `sales-copy.ts:59-67`, `setup-steps.ts:179-184`, `connect-sheet.ts:63` against the built behaviour; change copy only if a promise is still untrue (none expected; `scripts/test/site-copy.test.ts:46-99` pins the wording).
- [ ] **Step 2:** `npm run check` → PASS; `NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build` → PASS; `cd services/whatsapp-bridge && npm test && npm run typecheck` → PASS.
- [ ] **Step 3:** Commit: `docs: reliability gates built`.

---

## Owner-only decisions

1. **Max hold default** — proposed `OUTBOUND_HOLD_MAX_HOURS=24` (range 1..168). Expired messages are reported to GoHighLevel as failed with "phone was disconnected for more than 24 hours — message not sent".
2. **GoHighLevel DND sync (Task 10)** — proposed: build it behind `GHL_SYNC_DND` (off by default) so a STOP also flips the contact's DND in GHL, stopping SMS/email workflows too. Skip the task if not wanted; nothing else depends on it.
3. **Keyword list** — proposed STOP, STOPALL, STOP ALL, UNSUBSCRIBE, END, QUIT, OPT OUT, OPTOUT (US carrier set + UK) and START, UNSTOP, SUBSCRIBE, OPT IN, OPTIN. Whole message only. Confirm or trim.
4. **`logged_out` holds** — a number the client unlinked from their phone is treated as "will reconnect" (the setup guide says so); `banned` fails immediately. Confirm.

## Controller decisions (16 Oct 2026, owner said "Sort all"; defaults applied)
1. OUTBOUND_HOLD_MAX_HOURS default 24 (range 1..168).
2. T10 GoHighLevel DND sync: build it behind GHL_SYNC_DND, OFF by default.
3. Keywords: CANCEL removed from the opt-out list — this product sends appointment reminders, and "Cancel" is how people cancel an appointment, not how they unsubscribe. Final opt-out list: STOP, STOPALL, STOP ALL, UNSUBSCRIBE, END, QUIT, OPT OUT, OPTOUT. Opt-in list unchanged. Whole message only.
4. logged_out numbers hold; banned numbers fail immediately.
