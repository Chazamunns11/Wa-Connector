# `<Brand>` Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** This repo runs the GHL WhatsApp provider on its own: its own Next.js app, its own Supabase schema and its own copy of the WhatsApp bridge. The code is copied from PortalHub with every copied test passing, and Charlie can install it on a spare sub-account and do a send → reply round trip.

**Architecture:** Copy the GHL provider slice of PortalHub (`/home/user/PortalHub` in the build environment, or `github.com/Chazamunns11/PortalHub` at commit `7749351` or later) into a fresh Next.js app. Replace PortalHub's 300k-line data layer with a small `GhlRepository` holding only the methods the copied code calls. Squash the relevant migrations into one `0001_init.sql`. Copy `services/whatsapp-bridge/` and strip its coach-tenant paths. No product features (accounts, billing, dashboard): those are the later plans.

**Tech Stack:** Next.js **16.2.10**, React **19.2.4**, `@supabase/ssr` ^0.12.3, `@supabase/supabase-js` ^2.110.6, `@vercel/functions` ^3.7.5, `qrcode` ^1.5.4, Tailwind 4, TypeScript 5, `node --test`. The bridge keeps its own `package.json` and `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-12-brand-whatsapp-saas-design.md`, section "Revision: standalone", order-of-work step 1.

## Global Constraints

- **Copy, don't rewrite.** Copied modules keep their bodies, comments and tests. Edits are limited to (a) import paths, (b) removing Hub-only branches named in a task, and (c) wording that names FitClosers. Any other change needs a one-line reason in the commit message.
- **No "FitClosers" in any user-facing string.** User-facing text takes its product name from `brandConfig().name` (`src/lib/brand-config.ts`, Task 1). The two reasons at `ghl-provider.ts:264,266` become `"…reconnect from your <name> dashboard"` and `"…connect it from your <name> dashboard first"`. They are built once at module load, and stay fixed strings.
- **No demo mode.** The app requires `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`. Tests use in-file fakes, as PortalHub's tests already do.
- AGENTS.md rule carried over: read `node_modules/next/dist/docs/` before writing any route, layout, page or proxy code.
- Every task ends with `npm run check` (portal) and, from Task 6 on, `cd services/whatsapp-bridge && npm test`. Both must pass.
- Commit on branch `claude/adoring-brown-hvwuyz`.

## Review Focus

1. **A webhook signed by the old FitClosers GHL app.** The new app has its own `GHL_WEBHOOK_PUBLIC_KEY`, and a FitClosers-signed body must be rejected (Task 4 test).
2. **Leftover FitClosers wording or URLs.** A test scans `src/` and `services/` for `/fitclosers/i` outside comments and fails on any hit (Task 4).
3. **Leftover Hub tables.** The bridge must never query `calls`, `coaches` or `automation_*`. A test greps `services/whatsapp-bridge/src` for those names (Task 6).
4. **Missing env at runtime.** Every copied fail-closed path (no bridge URL, no GHL keys, no SSO secret) stays fail-closed. Copy the existing tests for these unchanged.
5. **The same number linked to both the old and new bridge during the client move.** Not code: written into the go-live doc (Task 7) as "unlink the old device immediately after flipping the Telephony Provider".

---

### Task 1: Scaffold the app

**Files:**
- Create: `package.json` (name `wa-connector`, scripts copied from PortalHub's `dev`/`build`/`start`/`lint`/`check`, and `"test": "node --import ./scripts/test/alias-hook.mjs --experimental-test-module-mocks --test \"scripts/test/*.test.ts\""`), `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `.gitignore`, `AGENTS.md`, `CLAUDE.md` (copied from PortalHub), `scripts/test/alias-hook.mjs` (copied), `src/app/layout.tsx`, `src/app/globals.css` (PortalHub's design tokens only), `src/lib/brand-config.ts`, `src/components/ui/{Button,Card,EmptyState}.tsx`, `src/components/ui/Chip.tsx` (from `components/owner/Chip.tsx`), `README.md` (what this is, how to run it, the env var list from Task 7)
- Test: `scripts/test/brand-config.test.ts`

**Interfaces — Produces:** `brandConfig(): { name: string; supportEmail: string | null; appUrl: string }`. Reads `BRAND_NAME` (default `"WA Connector"`), `BRAND_SUPPORT_EMAIL` and `NEXT_PUBLIC_APP_URL` (required in production; default `http://localhost:3000` in dev). The trailing slash is stripped.

- [ ] **Step 1:** Write the failing tests: the default name, the env override, the trailing slash stripped from `appUrl`.
- [ ] **Step 2:** `npm install`, then `npm test`. Expected: FAIL.
- [ ] **Step 3:** Create the files. `src/app/page.tsx` is a placeholder that redirects to `/admin`.
- [ ] **Step 4:** `npm run check`. Expected: PASS (typecheck, lint, 3 tests).
- [ ] **Step 5:** Commit `"scaffold: Next.js 16 app, test harness, brand config"`.

---

### Task 2: Squashed schema

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Source migrations** (PortalHub `supabase/migrations/`): `0046`, `0048`, `0069`, `0070`, `0071`, `0072`, `0073`, `0074`, `0075`, `0076`. Take only what touches `whatsapp_*` and `ghl_*` tables, with their indexes, comments, RLS (enabled, **no policies**) and storage bucket (0073).

Changes from the source:
- `whatsapp_tenants.kind` CHECK allows only `'ghl_location'`. Drop `coach_id` and the kind-shape constraint, and keep the `(id, kind)` unique constraint that `ghl_accounts` references.
- `whatsapp_inbound_messages`: drop `call_id` and its FK to `calls`. Keep `resolution` free text.
- Every FK to `coaches`/`calls`/`profiles` from the source is removed. Tables that become unreferenced are not created.
- Skip `0047`, `0049`, `0052`, `0056` and `0057`: they're Hub sequences and calendar only. Confirm by grepping the copied code (Tasks 3–6) for each of their table names and getting no hits.
- Add `profiles(id uuid primary key references auth.users on delete cascade, role text not null check (role in ('owner','account')), email text not null, created_at timestamptz default now())`, RLS on, no policies.
- A header comment lists the source migrations and each change above.

- [ ] **Step 1:** Write the file.
- [ ] **Step 2:** Verify against a local Postgres. Run `docker run -d --rm -e POSTGRES_PASSWORD=pw -p 54329:5432 postgres:16`, then `psql` the file in after stubbing `auth.users` (`create schema auth; create table auth.users(id uuid primary key);`) and `storage` (stub `storage.buckets(id text primary key, name text, public boolean)`). Expected: it applies with no errors. If Docker isn't available, use `npx supabase db start` if installed. Otherwise record "not executed locally, to be applied on the new Supabase project in Task 7" in the commit message.
- [ ] **Step 3:** Commit `"schema: squashed 0001_init for the GHL provider + bridge tables"`.

---

### Task 3: Types and the `GhlRepository` data layer

**Files:**
- Create: `src/lib/types.ts` (copied type declarations only: `GhlAccount`, `GhlOutboundMessage`, `GhlOutboundSendState`, `GhlOutboundAttachment`, `GhlOutboundAttachmentDraft`, `WhatsappInboundMessage`, `WhatsappSessionSummary`, and anything those reference, followed transitively), `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/lib/data/index.ts`
- Test: `scripts/test/repository-shape.test.ts`

**Interfaces — Produces:**
- `interface GhlRepository` with exactly these methods, signatures copied from PortalHub `src/lib/data/index.ts`: `getGhlAccountByLocationId`, `getGhlAccountByTenantId`, `getGhlAccounts`, `upsertGhlAccount`, `updateGhlAccountBranding`, `createGhlTenant`, `saveGhlTokens`, `markGhlNeedsReauth`, `claimGhlTokenRefresh`, `bumpGhlConnectLinkVersion`, `recordGhlOutboundMessage`, `updateGhlOutboundSendState`, `listUnreportedGhlOutboundMessages`, `markGhlOutboundReported`, `recordGhlOutboundAttachments`, `listGhlOutboundAttachmentsForMessages`, `updateGhlOutboundAttachmentSendState`, `getWhatsappMessagesByTenantKeys`, `getUnprocessedGhlInboundMessages`, `claimWhatsappInboundMessage`, `resolveGhlInboundMessage`, `recordGhlInboundPushFailure`, `purgeOldWhatsappInboundMessages`, `createWhatsappMediaSignedUrl`, `getWhatsappSessionSummary`, `getWhatsappSessionSummaries`, `getGhlHealthSnapshot`.
- `src/lib/data/index.ts` exports `repo: GhlRepository` (the service-role Supabase implementation). PortalHub's `webhookRepo` and `repo` both map to this one export: there are no user-session repos in this repo.
- `supabase.ts` method bodies are copied from PortalHub `src/lib/data/supabase.ts`, along with the row mappers they use (`mapGhlAccount` etc.), adapted only where a dropped column (`call_id`, `coach_id`) appeared.
- Each copied module's `Pick<WebhookRepository, …>` becomes `Pick<GhlRepository, …>`.

- [ ] **Step 1:** Write a failing type-level test: `const _check: GhlRepository = {} as import("@/lib/data/supabase").SupabaseGhlRepository;` plus a runtime assertion that the class prototype has all 27 method names.
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement. **Step 4:** `npm run check`. PASS.
- [ ] **Step 5:** Commit `"data: GhlRepository — the 27 methods the provider slice uses, copied from PortalHub"`.

---

### Task 4: The GHL provider library and its tests

**Files:**
- Create (copied from PortalHub `src/lib/`): `ghl.ts`, `ghl-provider.ts`, `ghl-inbound.ts`, `ghl-embed.ts`, `ghl-connect-link.ts`, `ghl-health.ts`, `whatsapp-bridge.ts`, `phone.ts`, `connect-throttle.ts`, `bridge-panel-guard.ts`, `slack.ts` (**only** `notifyText`, reading `SLACK_WEBHOOK_URL`)
- Create: `src/lib/signed-state.ts`, holding `signKindedState`/`verifyKindedState` and their helpers **copied** out of PortalHub `src/lib/onboarding.ts` (nothing else from that file)
- Create: `src/lib/brand.ts`, holding only the exports `ConnectBrandHeader.tsx` and the connect page import (follow the imports; copy those functions and their helpers)
- Test (copied from PortalHub `scripts/test/`): `ghl.test.ts`, `ghl-inbound.test.ts`, `ghl-embed.test.ts`, `ghl-connect-link.test.ts`, `ghl-health.test.ts`, `ghl-branding.test.ts`, plus any phone tests (`grep -l "normalisePhoneE164" scripts/test/*.ts`)
- Create test: `scripts/test/no-fitclosers.test.ts`

- [ ] **Step 1:** Copy the tests first, fixing only import paths. Write `no-fitclosers.test.ts`: walk `src/` and `services/whatsapp-bridge/src/`, strip `//` and `/* */` comments, and assert no `/fitclosers/i` match (Review Focus 2). Add to `ghl.test.ts`: `"verifyGhlSignature: a body signed by a different app's key fails"` (Review Focus 1). That test already exists in a similar form, so confirm it's there and keep it.
- [ ] **Step 2:** `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Copy the modules. Fix imports: `@/lib/onboarding` → `@/lib/signed-state`, `WebhookRepository` → `GhlRepository`, `@/lib/types` stays. Apply the Global Constraints wording change.
- [ ] **Step 4:** `npm run check`. Expected: PASS, with **every copied test passing unchanged** apart from imports and the two reworded reason strings.
- [ ] **Step 5:** Commit `"lib: GHL provider slice copied from PortalHub with its tests"`.

---

### Task 5: Routes, pages and the owner login

**Files:**
- Create (copied, imports fixed): `src/app/api/crm/oauth/start/route.ts`, `src/app/api/crm/oauth/callback/{route,logic}.ts`, `src/app/api/webhooks/crm-provider/route.ts`, `src/app/api/webhooks/crm-outbound-status/route.ts`, `src/app/api/crm/embed/**`, `src/app/api/connect/**`, `src/app/embed/crm/{page,CrmEmbedClient}.tsx`, `src/app/connect/[token]/{page,ConnectLinkClient}.tsx`, `src/components/whatsapp/{WhatsappConnectionPanel,ConnectBrandHeader}.tsx`, `src/components/shell/Wordmark.tsx` (render `brandConfig().name` as text; drop the FitClosers mark)
- Create (copied, Hub parts removed): `src/app/api/webhooks/whatsapp-replies/route.ts`, the inbound poke target. It runs **only** `drainGhlInboundReplies(repo)` (PortalHub's version also ran the coach drain).
- Create: `src/app/api/cron/drain/route.ts`, guarded by `CRON_SECRET` like PortalHub's cron routes. It runs `drainGhlOutboundStatuses`, `drainGhlInboundReplies` and `purgeOldWhatsappInboundMessages`, each in its own try/catch, and returns their result objects. Add `vercel.json` with `{"crons":[{"path":"/api/cron/drain","schedule":"0 * * * *"}]}`.
- Create: owner login. `src/app/login/{page,actions}.ts(x)` sends a Supabase OTP email link. `src/app/auth/callback/route.ts` exchanges the code and redirects to `/admin`. `src/lib/auth.ts` provides `getSession(): Promise<{ profileId: string; role: "owner" | "account"; email: string } | null>` and `assertOwner()`. `src/proxy.ts` redirects `/admin/**` to `/login` without an owner session. **Copy the shape** of PortalHub's `src/lib/auth.ts` `getLiveSession` and `src/proxy.ts` `liveProxy`, cut down to the profiles columns above.
- Create: `src/app/admin/page.tsx`, the copied `GhlAccountsPanel` and `GhlHealthPanel` (PortalHub `src/components/owner/`) and the GHL server actions from PortalHub `src/app/owner/setup-links/actions.ts` lines 80–200 (`connect/poll/logoutGhlWhatsappAction`, `createGhlConnectLinkAction`, plus `assertGhlAccountExists`). Every OAuth `back(...)` redirect target becomes `/admin?ghl=…`.
- Test: copy `scripts/test/ghl-oauth-callback.test.ts`. Add `scripts/test/auth.test.ts` for `assertOwner` (an `account` role throws, no session throws).

- [ ] **Step 1:** Copy the tests and write `auth.test.ts`. **Step 2:** Run. FAIL.
- [ ] **Step 3:** Copy and adapt. A `client`/`closer`/`coachId` branch in a copied route is deleted. Note each deletion in the commit message.
- [ ] **Step 4:** `npm run check`. PASS. Then `npm run build`. Expected: success.
- [ ] **Step 5:** Commit `"app: GHL install, provider webhooks, embed + connect pages, cron drain, owner login, /admin"`.

---

### Task 6: The bridge, with coach paths removed

**Files:**
- Create: `services/whatsapp-bridge/**`, copied whole (src, test, `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`)
- Modify: `services/whatsapp-bridge/src/{sessions,inbound,store}.ts`
- Test: `services/whatsapp-bridge/test/*` (copied); create `services/whatsapp-bridge/test/no-hub-tables.test.ts`

What changes:
- `resolveTenantKind` and `Session.tenantKind` go. Every session behaves as today's `'ghl_location'` branch. Delete the `'coach'` branches in `sessions.ts` and `inbound.ts`.
- `store.ts` loses any column or query that only coach rows used (anything reading `call_id` or `coach_id`).
- `test/sessions-tenant-kind.test.ts`: delete the coach-specific cases, and keep and rename the GHL ones to describe "every session".
- `no-hub-tables.test.ts`: assert that `src/` contains none of `"calls"`, `"coaches"`, `automation_`, `coach_id`, `call_id` (Review Focus 3).

- [ ] **Step 1:** Copy everything and run `npm ci && npm test` in `services/whatsapp-bridge`. Expected: PASS (it's a pure copy). Commit `"bridge: copied from PortalHub unchanged"`.
- [ ] **Step 2:** Write `no-hub-tables.test.ts` and edit the tenant-kind tests. Run. Expected: FAIL.
- [ ] **Step 3:** Remove the coach paths. **Step 4:** `npm test` in the bridge, and `npm run check` at the root. PASS.
- [ ] **Step 5:** Commit `"bridge: GHL-location tenants only — coach paths removed"`.

---

### Task 7: Deploy and first light (operator, with a doc)

**Files:**
- Create: `docs/GO-LIVE-FOUNDATION.md`

The doc, in PortalHub's go-live voice (rule zero: no secrets pasted into chat), covers:
1. **Supabase:** new project in the existing organisation. Apply `0001_init.sql` in the SQL editor. Sign in once at `/login`, then run `insert into profiles (id, role, email) select id, 'owner', email from auth.users where email = '<Charlie's email>';`.
2. **Railway:** a new service in the existing project. Root `services/whatsapp-bridge`, build `npm install && npm run build`, start `npm start`, healthcheck `/health`, 1 replica. Variables as in PortalHub `docs/WHATSAPP-GO-LIVE.md` Part 4, but with the **new** Supabase URL and key and **new** secrets (never reuse `WA_CREDS_KEY` or the bridge secret), plus `PORTAL_INBOUND_URL=<app>/api/webhooks/whatsapp-replies` and the outbound poke URL `<app>/api/webhooks/crm-outbound-status`.
3. **Vercel:** a new project from this repo. Env: Supabase ×3, `NEXT_PUBLIC_APP_URL`, `BRAND_NAME`, `WHATSAPP_BRIDGE_URL`, `WHATSAPP_BRIDGE_SECRET`, `WHATSAPP_INBOUND_POKE_SECRET`, `CRON_SECRET`, `ONBOARD_STATE_SECRET`, `SLACK_WEBHOOK_URL`, and the GHL vars from step 4. List every `process.env.*` the copied code reads (`grep -rhoE "process\.env\.[A-Z_]+" src | sort -u`) and confirm each one is in this list.
4. **GHL:** a **new** Marketplace app under the `<Brand>` name (Private for now, pricing **Free**, distribution agency **and** sub-account). Redirect URL `<app>/api/crm/oauth/callback`, provider delivery URL `<app>/api/webhooks/crm-provider`, Custom Page `<app>/embed/crm`. Then `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_WEBHOOK_PUBLIC_KEY`, `GHL_APP_ID`, `GHL_CONVERSATION_PROVIDER_ID` and `GHL_SSO_SHARED_SECRET`. Mirror PortalHub `docs/GHL-PROVIDER-GO-LIVE.md` Parts 1–4 and 8, including the "Freemium trap".
5. **First light**, on a spare sub-account and Charlie's own number: install from `/admin` → connect via QR → set the Telephony Provider → send a workflow SMS → it arrives on WhatsApp and shows delivered → reply → it appears in GHL → message from a phone GHL has never seen → a new contact appears.
6. **Review Focus 5:** when a sub-account moves from the FitClosers app to this one, unlink the old linked device right after switching the Telephony Provider.

- [ ] **Step 1:** Write the doc. **Step 2:** Commit `"docs: foundation go-live — Supabase, Railway, Vercel, new GHL app, first light"`.
- [ ] **Step 3 (Charlie):** Work through the doc. The foundation is done when first light passes.
