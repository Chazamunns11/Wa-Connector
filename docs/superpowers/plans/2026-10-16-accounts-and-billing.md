# Accounts, Logins and Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the website's Preview screens with real accounts: a Supabase-backed data model, emailed sign-in links, signup through Stripe Checkout (test mode), a dashboard on real data, per-number volume billing kept in sync from activated numbers, and a sending gate so only paid or trialing accounts send.

**Architecture:** One new migration adds `accounts`, links `profiles` and `ghl_accounts` to it, and records Stripe event ids; every table stays RLS-on with no policies (service-role only, authorisation in server code). Stripe is called through `fetch` with a tiny form-encoded client; a signature-verified webhook is the only writer of `billing_status`. The existing `AccountDataSource` seam gets a Supabase implementation and the preview source is deleted. Pure decision logic (status map, sending gate, activation rules, webhook handler, onboarding) lives in `src/lib/billing/*` with zero Next imports so `node --test` covers it; route handlers and server actions stay thin.

**Tech Stack:** Next.js 16.2.10 (App Router, `proxy.ts`, server actions), `@supabase/ssr` + `@supabase/supabase-js` (auth OTP, admin API, service-role reads), Stripe REST via `fetch` (no SDK), `node --test` via `scripts/test/alias-hook.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-12-brand-whatsapp-saas-design.md` (§1 accounts and login, §2 signup and billing, §3 dashboard, §4 in-GHL page, Error handling, Testing) and `docs/superpowers/specs/2026-10-16-website-design.md` (the screens being made real). Rulings in `.superpowers/sdd/2026-10-16-website/progress.md`; W40 (revised) is the pricing authority.

## Global Constraints

- Branch `claude/adoring-brown-hvwuyz-accounts`, worktree `/home/user/wa-connector-accounts`. Never touch `/home/user/wa-connector-site`, `/home/user/wa-connector` or `/home/user/PortalHub`.
- Next.js 16.2.10: read `node_modules/next/dist/docs/` before touching routes, `proxy.ts`, server actions or `cookies()` (`cookies()` is async; `redirect()` throws; Proxy is an optimistic check only).
- Pricing (W40 revised): VOLUME pricing in whole pence, GBP. Fewer than 10 numbers: 1499 each per month. 10 or more: 799 each for ALL. `src/lib/pricing.ts` constants `STANDARD_PENCE = 1499`, `VOLUME_PENCE = 799`, `VOLUME_FROM = 10`, `TRIAL_DAYS = 7`, `TRIAL_MAX_NUMBERS = 3`. Money is computed in pence; never floats.
- Trial: 7 days, card collected at Checkout, at most 3 activated numbers while `trialing`.
- Login: emailed Supabase OTP link with `shouldCreateUser: false` (only signed-up addresses), PKCE via the cookie client (the link must open in the browser that asked). Plus the in-GHL page per sub-account (existing embed).
- `billing_status` is only ever written from a Stripe subscription object (webhook or a Checkout session the app itself retrieved), never computed by hand. Webhook handlers are idempotent on the Stripe event id.
- A number must never be active but unbilled: on Activate, Stripe quantity is updated BEFORE `activated_at` is written; if the DB write then fails, quantity is re-synced.
- Every refusal shown in GHL is a fixed string.
- No RLS read policies for anyone. Every new table: `enable row level security`, no policies. Every read and write goes through server code after a session + ownership check.
- No "FitClosers" wording in `src/` (`scripts/test/no-fitclosers.test.ts`). Brand name via `brandConfig().name` (default "PingWren").
- Stripe via `fetch` only; pinned `Stripe-Version: 2024-11-20.acacia`. Secrets only in env; never logged.
- Acceptance for every task: `npm run check` passes and `NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build` passes.
- Commit after every task with a one-line conventional message. Do not push.

## Review Focus

1. A Checkout the customer abandons (closes the Stripe tab): the account and auth user already exist with `billing_status = 'pending'`; signing in must show "Add a card to start your trial" with a working button, not a blank dashboard. Test pinned in Task 9 (`planStatus` for `pending`) and Task 5 (`createCheckoutForAccount` reuses the account id).
2. The webhook arriving BEFORE the customer reaches `/signup/complete`, or AFTER: both paths call the same `applyCheckoutSession`, and applying twice changes nothing. Test pinned in Task 5.
3. `customer.subscription.updated` with a status the map does not know (`incomplete`): the handler must leave `billing_status` untouched rather than writing garbage. Test pinned in Task 6.
4. An agency install whose locations are partly owned by another account: the owned ones are skipped and counted as conflicts, the rest install, and the dashboard says so. Test pinned in Task 8.
5. Deactivate when Stripe is unreachable: `activated_at` is cleared (sending stops) and the quantity mismatch is reported to Slack for the next reconcile, never left silent. Test pinned in Task 10.

---

## File map

New:
- `supabase/migrations/0002_accounts.sql` — accounts, profiles.account_id, ghl_accounts.account_id/activated_at, stripe_events.
- `src/lib/stripe/client.ts` — `stripeRequest`, `encodeForm`, `isStripeConfigured`, `stripeConfig`.
- `src/lib/stripe/webhook.ts` — `verifyStripeSignature`.
- `src/lib/stripe/billing.ts` — typed calls: checkout session, subscription, quantity, trial end, portal, customer card.
- `src/lib/billing/status.ts` — `mapStripeSubscriptionStatus`.
- `src/lib/billing/gate.ts` — `sendingGate` + the two fixed refusal strings.
- `src/lib/billing/activation.ts` — `canActivate`, `platformCap`.
- `src/lib/billing/onboard.ts` — `applyCheckoutSession`, `createCheckoutForAccount`.
- `src/lib/billing/webhook-handler.ts` — `handleBillingEvent`.
- `src/lib/billing/quantity.ts` — `syncSubscriptionQuantity`.
- `src/lib/billing/cleanup.ts` — `purgeCancelledAccounts`.
- `src/lib/ghl-claim.ts` — the 30-minute claim token.
- `src/lib/account-session.ts` — `requireAccountSession`.
- `src/lib/account-data/supabase.ts` — `SupabaseAccountDataSource`; `src/lib/account-data/map.ts` — `toWhatsappState`, `toLocationRow`.
- `src/app/(site)/signup/complete/page.tsx` — post-Checkout page that emails the sign-in link.
- `src/app/api/webhooks/billing/route.ts` — Stripe webhook.
- `src/app/(app)/dashboard/billing/actions.ts` — portal + end-trial actions.
- `src/app/(app)/dashboard/whatsapp-actions.ts`, `src/components/app/LocationQrPanel.tsx`, `src/components/app/GhlResultNotice.tsx`, `src/components/owner/AccountsPanel.tsx`.
- `scripts/rls-check.mjs` — operator RLS check (manual, live project).
- `docs/GO-LIVE-ACCOUNTS.md` — Charlie's checklist.

Modified: `src/lib/types.ts`, `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/lib/auth.ts`, `src/proxy.ts`, `src/app/auth/callback/route.ts`, `src/app/login/actions.ts`, `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`, `src/app/(site)/signup/{page,actions}.tsx`, `src/lib/site/signup.ts`, `src/lib/signed-state.ts`, `src/lib/ghl-provider.ts`, `src/app/api/crm/embed/session/route.ts`, `src/app/embed/crm/CrmEmbedClient.tsx`, `src/app/api/crm/oauth/{start,callback}/route.ts`, `src/app/api/crm/oauth/callback/logic.ts`, `src/lib/account-data/{index,types,derive}.ts`, `src/lib/site/dashboard-url.ts`, `src/app/(app)/dashboard/{page,actions}.tsx`, `src/app/(app)/dashboard/billing/page.tsx`, `src/components/app/{PlanHeader,LocationTable,RowActions,LocationRowDetail}.tsx`, `src/app/admin/page.tsx`, `src/app/api/cron/drain/route.ts`, `docs/GO-LIVE-FOUNDATION.md`, `README.md`.

Deleted: `src/lib/account-data/preview.ts`, `src/components/app/ScenarioSwitcher.tsx`, `src/app/(site)/signup/checkout/page.tsx`, `src/components/site/PreviewBadge.tsx` (and its tests).

## Task order and parallel groups

| Group | Tasks | Notes |
|---|---|---|
| Serial | 0, then 1 | 0 brings W40 pricing in; 1 is the schema every later task imports from |
| A (parallel) | 2, 3, 4 | 2 auth/session; 3 Stripe client; 4 pure billing rules + claim token |
| B (parallel) | 5, 6, 7, 8 | 5 signup→Checkout; 6 webhook; 7 sending gate + embed; 8 OAuth linking |
| C (parallel) | 9, 12 | 9 real data source + dashboard; 12 admin panel + cleanup cron + RLS script |
| D (parallel) | 10, 11 | 10 row actions; 11 billing page |
| Serial | 13 | docs + final verification |

Tasks in one group touch disjoint files. Each later group starts from the merged result of the previous one.

---

### Task 0: Bring in the W40 pricing commit

**Files:**
- Modify: whatever `git cherry-pick 2b4e477` touches (`src/lib/pricing.ts`, pricing pages, tests).

**Interfaces:**
- Produces: `src/lib/pricing.ts` exports `CURRENCY`, `STANDARD_PENCE`, `VOLUME_PENCE`, `VOLUME_FROM`, `perNumberPence(n)`, `monthlyCostPence(n)`, `monthlyCost(n)`, `formatMoney(amount, currency)`, `pricingConfig(): { currency }`, `TRIAL_DAYS`, `TRIAL_MAX_NUMBERS`. Every later task reads prices from here.

- [ ] **Step 1: Cherry-pick the site branch's pricing commit**

Run: `git cherry-pick 2b4e477` (commit "site: tiered pricing, WhatsApp-style phones, drop why-we-made-it" on `claude/adoring-brown-hvwuyz-site`). Resolve nothing by hand: the accounts branch is at the same base (`da2cade`), so it applies clean. If the site branch has moved past `2b4e477` by the time this runs, cherry-pick the newest commit that touches `src/lib/pricing.ts` instead, and note it in the commit body.

- [ ] **Step 2: Verify**

Run: `npm run check && NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`
Expected: both pass; `grep -c "VOLUME_PENCE" src/lib/pricing.ts` prints at least 1.

- [ ] **Step 3: Commit**

The cherry-pick is the commit. Nothing more.

---

### Task 1: Schema, types and repository for accounts

**Files:**
- Create: `supabase/migrations/0002_accounts.sql`
- Modify: `src/lib/types.ts`, `src/lib/data/repository.ts`, `src/lib/data/supabase.ts` (mapper + methods), `src/lib/account-data/types.ts` (re-export the moved types)
- Test: `scripts/test/accounts-schema.test.ts`, `scripts/test/repository-shape.test.ts` (extend)

**Interfaces:**
- Produces (in `src/lib/types.ts`):
  ```ts
  export type BillingStatus = "pending" | "trialing" | "active" | "past_due" | "paused" | "cancelled" | "comped";
  export type AccountKind = "agency" | "business";
  export interface Account { id: string; name: string; kind: AccountKind; ownerEmail: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null; billingStatus: BillingStatus; trialEndsAt: string | null; cancelledAt: string | null; cleanedUpAt: string | null; createdAt: string }
  export interface AccountDraft { name: string; kind: AccountKind; ownerEmail: string }           // inserts with billingStatus 'pending'
  export interface AccountBillingPatch { stripeCustomerId?: string | null; stripeSubscriptionId?: string | null; billingStatus?: BillingStatus; trialEndsAt?: string | null; cancelledAt?: string | null; cleanedUpAt?: string | null }
  export interface AccountAdminRow { account: Account; locations: number; activeNumbers: number }
  export interface LocationStats { pendingSend: number; failedLast7Days: { count: number; reasons: string[] }; everReceived: boolean }
  ```
  `GhlAccount` and `GhlAccountSummary` gain `accountId: string | null; activatedAt: string | null`. `src/lib/account-data/types.ts` re-exports `BillingStatus` and `AccountKind` from `@/lib/types` (remove its own definitions).
- Produces (in `GhlRepository`):
  ```ts
  getAccountById(id: string): Promise<Account | null>;
  getAccountByStripeCustomerId(customerId: string): Promise<Account | null>;
  createAccount(draft: AccountDraft): Promise<Account>;
  updateAccountBilling(id: string, patch: AccountBillingPatch): Promise<void>;
  listAccountsForAdmin(): Promise<AccountAdminRow[]>;
  listAccountsCancelledBefore(iso: string): Promise<Account[]>;           // cancelled_at < iso AND cleaned_up_at IS NULL
  createProfile(draft: { id: string; role: Role; email: string; accountId: string | null }): Promise<void>;
  getProfileByEmail(email: string): Promise<{ id: string; role: Role; accountId: string | null } | null>;  // lower(email) match
  listGhlAccountsForAccount(accountId: string): Promise<GhlAccountSummary[]>;  // ordered by label
  claimGhlAccount(locationId: string, accountId: string): Promise<boolean>;    // UPDATE ... WHERE account_id IS NULL; true iff one row changed
  setGhlActivated(locationId: string, activatedAt: string | null): Promise<void>;
  countActivatedForAccount(accountId: string): Promise<number>;
  countActivatedAll(): Promise<number>;
  getWhatsappSessionSummariesForTenants(tenantIds: string[]): Promise<WhatsappSessionSummary[]>;
  getLocationStats(locationIds: string[], sinceIso: string): Promise<Record<string, LocationStats>>;
  recordStripeEvent(eventId: string, type: string): Promise<boolean>;         // INSERT ... ON CONFLICT DO NOTHING; true iff inserted
  ```
  `getProfile(userId)` in `src/lib/auth.ts` is Task 2's; this task only adds the column.

- [ ] **Step 1: Write the failing schema test**

`scripts/test/accounts-schema.test.ts` reads `supabase/migrations/0002_accounts.sql` as text and asserts, with `assert.match` on each:
- `create table public.accounts` with columns `kind text not null check (kind in ('agency', 'business'))`, `billing_status text not null default 'pending'` whose CHECK lists exactly `'pending', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'comped'`, `stripe_customer_id text unique`, `stripe_subscription_id text unique`, `trial_ends_at timestamptz`, `cancelled_at timestamptz`, `cleaned_up_at timestamptz`.
- `alter table public.profiles add column account_id uuid references public.accounts (id) on delete restrict`.
- `create unique index profiles_email_lower_idx on public.profiles (lower(email))`.
- `alter table public.ghl_accounts add column account_id uuid references public.accounts (id) on delete restrict`, `add column activated_at timestamptz`, `create index ghl_accounts_account_idx on public.ghl_accounts (account_id)`.
- `create table public.stripe_events (id text primary key, type text not null, received_at timestamptz not null default now())`.
- `alter table public.accounts enable row level security` and `alter table public.stripe_events enable row level security`, and the file does NOT contain `create policy`.
- The `comped` convention is in a comment: the FitClosers account is inserted by hand with `billing_status = 'comped'` and no Stripe ids.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import ./scripts/test/alias-hook.mjs --test scripts/test/accounts-schema.test.ts`
Expected: FAIL, file not found.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0002_accounts.sql` exactly as the test pins, plus `updated_at` with the existing `set_updated_at` trigger on `accounts`, and a header comment mirroring 0001's style stating: service-role only, no policies, `account_id` null on `ghl_accounts` means "installed from the Marketplace, not yet claimed", `activated_at` non-null means "billed, active number".

- [ ] **Step 4: Extend types and the repository interface**

Add the types from Interfaces to `src/lib/types.ts`; make `src/lib/account-data/types.ts` re-export `BillingStatus`/`AccountKind` from `@/lib/types`. Add the methods to `GhlRepository` with one-line JSDoc each. Extend `scripts/test/repository-shape.test.ts` (it asserts the Supabase class implements every interface method) so the new names are in its list.

- [ ] **Step 5: Implement in `SupabaseGhlRepository`**

Follow the existing explicit-column mapper pattern (`mapGhlAccount` gets `account_id`/`activated_at`; `GHL_ACCOUNT_SUMMARY_COLUMNS` and the full select both add the two columns). `mapAccount(row)` maps snake_case to `Account`. `claimGhlAccount` uses `.update({ account_id }).eq("location_id", id).is("account_id", null).select("location_id")` and returns `data.length === 1`. `recordStripeEvent` uses `.insert(...).select("id")` and treats a `23505` error as `false`. `getLocationStats` runs two bounded queries over `ghl_outbound_messages` for the given `location_id in (...)`: (a) rows with `created_at >= sinceIso` selecting `location_id, send_state, refusal_reason, reported_status`, folding `send_state = 'pending_send'` into `pendingSend` and `send_state = 'refused' OR reported_status = 'failed'` into `failedLast7Days` (reasons = distinct `refusal_reason`, max 3, in first-seen order); (b) `select location_id` with no time filter, `limit 1` per location via `in` + distinct fold, for `everReceived`. Every location id requested appears in the result (zero stats when absent).

- [ ] **Step 6: Run the suite**

Run: `npm run check`
Expected: PASS (the schema test, the extended shape test).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0002_accounts.sql src/lib/types.ts src/lib/data src/lib/account-data/types.ts scripts/test/accounts-schema.test.ts scripts/test/repository-shape.test.ts
git commit -m "feat: accounts schema, types and repository methods"
```

---

### Task 2: Account sessions, role-aware callback, dashboard gating, logout

**Files:**
- Create: `src/lib/account-session.ts`
- Modify: `src/lib/auth.ts`, `src/app/auth/callback/route.ts`, `src/proxy.ts`, `src/app/login/actions.ts`, `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`
- Test: `scripts/test/auth.test.ts` (extend), `scripts/test/account-session.test.ts`, `scripts/test/site-login.test.ts` (extend)

**Interfaces:**
- Consumes: `profiles.account_id` (Task 1).
- Produces:
  ```ts
  // src/lib/auth.ts
  export interface Session { profileId: string; role: Role; email: string; accountId: string | null }
  export async function getProfile(userId: string): Promise<{ role: Role; email: string; accountId: string | null } | null>
  // src/lib/account-session.ts
  export interface AccountSession extends Session { role: "account"; accountId: string }
  export function isAccountSession(s: Session | null): s is AccountSession
  export async function requireAccountSession(): Promise<AccountSession>   // redirect("/login") when no session; redirect("/admin") when owner; redirect("/login?error=no_account") when account with null accountId
  // src/app/login/actions.ts
  export async function signOutAction(): Promise<void>                      // supabase.auth.signOut() on the cookie client, then redirect("/login")
  ```
  Login page error copy gains `no_account` ("This sign-in doesn't belong to an account yet. Contact support.") and `checkout` ("Your account exists but no card was added. Sign in to finish setting up billing.") — the latter is the Checkout `cancel_url` landing (Task 5).

- [ ] **Step 1: Extend `scripts/test/auth.test.ts`**

Using its existing `mock.module` fakes: the `profiles` select now returns `{ role: "account", email, account_id: "acc-1" }` and `getSession()` resolves `accountId: "acc-1"`; an owner row with `account_id: null` resolves `accountId: null`. Add `scripts/test/account-session.test.ts` with `isAccountSession`: `null` → false; owner → false; account with `accountId: null` → false; account with id → true.

- [ ] **Step 2: Run, expect failure**

Run: `npm test`. Expected: the new assertions fail (`accountId` undefined; module missing).

- [ ] **Step 3: Implement**

`getProfile` selects `role, email, account_id`. `requireAccountSession` uses `redirect` from `next/navigation` as specified. Auth callback: after a successful exchange call `getProfile(user.id)` via `supabase.auth.getUser()`; `owner` → `/admin`, `account` with `accountId` → `/dashboard`, anything else → sign out and `/login?error=no_account`. Proxy: add `const APP_PREFIX = "/dashboard"`; a request under it with no user redirects to `/login` (no role lookup — the page's `requireAccountSession` is the authorisation). `(app)/layout.tsx`: replace the "Log out" link with `<form action={signOutAction}><button type="submit" className={LINK}>Log out</button></form>`.

- [ ] **Step 4: Extend `site-login.test.ts`**

File-content assertions: `src/proxy.ts` contains `"/dashboard"` and still excludes `api` in the matcher; `src/app/(app)/layout.tsx` imports `signOutAction` and no longer links to `SITE_ROUTES.login` for logout; `src/app/auth/callback/route.ts` contains both `"/admin"` and `"/dashboard"`.

- [ ] **Step 5: Verify and commit**

Run: `npm run check && NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`
```bash
git add src/lib/auth.ts src/lib/account-session.ts src/proxy.ts src/app/auth/callback/route.ts src/app/login src/app/(app)/layout.tsx scripts/test
git commit -m "feat: account sessions, role-aware sign-in landing, dashboard gating, logout"
```

---

### Task 3: Stripe client over fetch

**Files:**
- Create: `src/lib/stripe/client.ts`, `src/lib/stripe/webhook.ts`, `src/lib/stripe/billing.ts`
- Test: `scripts/test/stripe-client.test.ts`, `scripts/test/stripe-webhook.test.ts`, `scripts/test/stripe-billing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // client.ts
  export const STRIPE_API_VERSION = "2024-11-20.acacia";
  export function isStripeConfigured(): boolean            // STRIPE_SECRET_KEY && STRIPE_PRICE_ID both set
  export function stripeConfig(): { secretKey: string; priceId: string; webhookSecret: string | null; automaticTax: boolean }  // throws when not configured; automaticTax = STRIPE_AUTOMATIC_TAX === "true"
  export function encodeForm(params: Record<string, unknown>): string  // nested objects → a[b]=, arrays → a[0]=, booleans → "true"/"false", null/undefined skipped
  export type StripeResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string | null; message: string };
  export async function stripeRequest<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, opts?: { idempotencyKey?: string; fetchImpl?: typeof fetch }): Promise<StripeResult<T>>
  // webhook.ts
  export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean
  // billing.ts
  export interface StripeSubscription { id: string; status: string; customer: string; trialEnd: number | null; canceledAt: number | null; cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null; itemId: string | null; quantity: number; cardLast4: string | null; metadata: Record<string, string> }
  export interface StripeCheckoutSession { id: string; status: string | null; customer: string | null; subscription: StripeSubscription | null; metadata: Record<string, string> }
  export function createCheckoutSession(input: { accountId: string; customerEmail: string; successUrl: string; cancelUrl: string }, deps?): Promise<StripeResult<{ id: string; url: string }>>
  export function retrieveCheckoutSession(id: string, deps?): Promise<StripeResult<StripeCheckoutSession>>
  export function retrieveSubscription(id: string, deps?): Promise<StripeResult<StripeSubscription>>
  export function setSubscriptionItemQuantity(itemId: string, quantity: number, deps?): Promise<StripeResult<{ id: string; quantity: number }>>
  export function endTrialNow(subscriptionId: string, deps?): Promise<StripeResult<StripeSubscription>>
  export function createPortalSession(customerId: string, returnUrl: string, deps?): Promise<StripeResult<{ url: string }>>
  export function parseSubscription(raw: unknown): StripeSubscription | null   // exported for the webhook handler (Task 6)
  ```
  `deps` is `{ request?: typeof stripeRequest }` for tests. Every function reads config at call time.

- [ ] **Step 1: Write failing tests**

`stripe-client.test.ts`:
- `encodeForm({ mode: "subscription", line_items: [{ price: "p", quantity: 1 }], subscription_data: { trial_period_days: 7, metadata: { account_id: "a" } }, automatic_tax: { enabled: true } })` equals `mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&subscription_data%5Btrial_period_days%5D=7&subscription_data%5Bmetadata%5D%5Baccount_id%5D=a&automatic_tax%5Benabled%5D=true`.
- `stripeRequest` with a fake `fetchImpl` records: URL `https://api.stripe.com/v1/customers/cus_1`, header `Authorization: Bearer sk_test_x`, `Stripe-Version: 2024-11-20.acacia`, POST body form-encoded with `Content-Type: application/x-www-form-urlencoded`, `Idempotency-Key` present when given, GET appends `?a=b` and sends no body; a 402 JSON `{ error: { code: "card_declined", message: "m" } }` → `{ ok: false, status: 402, code: "card_declined", message: "m" }`; a thrown fetch → `{ ok: false, status: 0, code: null, message: "network" }`.
- `isStripeConfigured()` false with env unset, true with both set (use `process.env` directly in the test and restore).

`stripe-webhook.test.ts`: build `header = "t=1700000000,v1=" + hmacHex(secret, "1700000000." + body)`; `verifyStripeSignature(body, header, secret, 1700000100)` true; wrong secret false; `nowSec = 1700000400` (401s later) false; header `null` false; header with two `v1=` where the second matches → true; header missing `t=` false.

`stripe-billing.test.ts`: with a recording fake `request`: `createCheckoutSession({ accountId: "acc-1", customerEmail: "a@b.co", successUrl: "S", cancelUrl: "C" })` POSTs `/checkout/sessions` with params `mode: "subscription"`, `customer_email: "a@b.co"`, `client_reference_id: "acc-1"`, `line_items: [{ price: <STRIPE_PRICE_ID>, quantity: 1 }]`, `subscription_data: { trial_period_days: 7, metadata: { account_id: "acc-1" } }`, `metadata: { account_id: "acc-1" }`, `payment_method_collection: "always"`, `success_url: "S"`, `cancel_url: "C"`, and `automatic_tax: { enabled: true }` plus `customer_update: { address: "auto" }` only when `STRIPE_AUTOMATIC_TAX=true`; `parseSubscription` of a raw object `{ id, status: "trialing", customer: "cus", trial_end: 1, canceled_at: null, cancel_at_period_end: false, current_period_end: 2, items: { data: [{ id: "si_1", quantity: 3 }] }, default_payment_method: { card: { last4: "4242" } }, metadata: {} }` → the typed shape with `itemId: "si_1"`, `quantity: 3`, `cardLast4: "4242"`; `customer` given as an object `{ id: "cus" }` → `"cus"`; missing `items` → `null`. `retrieveSubscription` GETs `/subscriptions/sub_1` with `expand: ["default_payment_method"]`; `retrieveCheckoutSession` GETs `/checkout/sessions/cs_1` with `expand: ["subscription", "subscription.default_payment_method"]`; `setSubscriptionItemQuantity("si_1", 0)` POSTs `/subscription_items/si_1` with `{ quantity: 0, proration_behavior: "create_prorations" }`; `endTrialNow("sub_1")` POSTs `/subscriptions/sub_1` with `{ trial_end: "now", proration_behavior: "none" }`; `createPortalSession("cus", "R")` POSTs `/billing_portal/sessions` with `{ customer: "cus", return_url: "R" }`.

- [ ] **Step 2: Run, expect failure** — `npm test` → modules missing.

- [ ] **Step 3: Implement the three files**

`stripeRequest` builds `https://api.stripe.com/v1${path}`; GET puts the encoded params in the query string. Parse the JSON body; a non-2xx maps `error.code`/`error.message`. Never log the key or the body. `verifyStripeSignature` splits on `,`, collects every `v1`, computes `createHmac("sha256", secret).update(`${t}.${rawBody}`)` hex, compares with `timingSafeEqual` on equal-length buffers, and checks `|nowSec - t| <= toleranceSec`.

- [ ] **Step 4: Verify and commit**

Run: `npm run check`
```bash
git add src/lib/stripe scripts/test/stripe-*.test.ts
git commit -m "feat: Stripe client over fetch with signature verification"
```

---

### Task 4: Pure billing rules and the claim token

**Files:**
- Create: `src/lib/billing/status.ts`, `src/lib/billing/gate.ts`, `src/lib/billing/activation.ts`, `src/lib/ghl-claim.ts`
- Modify: `src/lib/signed-state.ts` (add `"ghl-claim"` to `SignedStateKind` with a JSDoc entry)
- Test: `scripts/test/billing-rules.test.ts`, `scripts/test/ghl-claim.test.ts`

**Interfaces:**
- Consumes: `BillingStatus` (Task 1), `TRIAL_MAX_NUMBERS` (Task 0).
- Produces:
  ```ts
  // status.ts
  export function mapStripeSubscriptionStatus(status: string): BillingStatus | null
  // gate.ts
  export const REASON_NOT_ACTIVATED = "WhatsApp isn't activated for this sub-account";
  export function reasonSubscriptionInactive(brandName: string): string   // `${brandName} subscription inactive — the account owner needs to update billing`
  export function sendingGate(location: { accountId: string | null; activatedAt: string | null }, billingStatus: BillingStatus | null, brandName: string): string | null
  // activation.ts
  export type ActivateRefusal = "already_active" | "billing_inactive" | "trial_cap" | "platform_cap";
  export function canActivate(input: { billingStatus: BillingStatus; alreadyActive: boolean; accountActive: number; platformActive: number; platformCap: number | null }): { ok: true } | { ok: false; reason: ActivateRefusal }
  export function platformCap(): number | null   // BRAND_MAX_ACTIVE_NUMBERS as a positive integer, else null
  // ghl-claim.ts
  export const CLAIM_TOKEN_TTL_MS = 30 * 60 * 1000;
  export function isClaimConfigured(): boolean                      // ONBOARD_STATE_SECRET set (same rule as ghl-embed: never the CRON_SECRET fallback)
  export function mintClaimToken(locationId: string): string         // throws when not configured
  export function verifyClaimToken(token: string): { locationId: string } | null
  export function claimSignupUrl(appUrl: string, locationId: string): string   // `${appUrl}/signup?claim=${encodeURIComponent(token)}`
  ```

- [ ] **Step 1: Write failing tests**

`billing-rules.test.ts`:
- Status map, every pair: `trialing→trialing`, `active→active`, `past_due→past_due`, `unpaid→paused`, `paused→paused`, `canceled→cancelled`, `incomplete_expired→cancelled`, `incomplete→null`, `"garbage"→null`.
- Gate, with `brandName "PingWren"`: `{ accountId: null, activatedAt: null }` any status → `REASON_NOT_ACTIVATED`; `{ accountId: "a", activatedAt: null }` with `active` → `REASON_NOT_ACTIVATED`; activated with `billingStatus: null` → `"PingWren subscription inactive — the account owner needs to update billing"`; activated with each of `pending`, `paused`, `cancelled` → the inactive string; activated with each of `trialing`, `active`, `past_due`, `comped` → `null`.
- `canActivate`: `alreadyActive: true` → `already_active`; `pending`/`paused`/`cancelled` → `billing_inactive`; `trialing` with `accountActive: 3` → `trial_cap`, with `accountActive: 2` → ok; `active` with `accountActive: 40` → ok; `platformCap: 50, platformActive: 50` → `platform_cap`; `platformCap: null` never caps. Precedence when several apply: already_active, billing_inactive, trial_cap, platform_cap.
- `platformCap()`: unset → null; `"abc"` → null; `"0"` → null; `"75"` → 75.

`ghl-claim.test.ts` (set `ONBOARD_STATE_SECRET` in the test): mint → verify returns the location id; a token minted for kind `ghl-embed` via `signKindedState` → `null`; tampered last char → `null`; with the secret unset `isClaimConfigured()` false and `verifyClaimToken` null; `claimSignupUrl("https://x", "loc")` starts with `https://x/signup?claim=`. Expiry: `signKindedState("ghl-claim", { locationId: "l" }, -1)` → verify null.

- [ ] **Step 2: Run, expect failure.** `npm test`.

- [ ] **Step 3: Implement the four files and the `SignedStateKind` member.**

- [ ] **Step 4: Verify and commit**

```bash
git add src/lib/billing src/lib/ghl-claim.ts src/lib/signed-state.ts scripts/test/billing-rules.test.ts scripts/test/ghl-claim.test.ts
git commit -m "feat: billing status map, sending gate, activation rules, claim token"
```

---

### Task 5: Signup → Stripe Checkout → sign-in link

**Files:**
- Create: `src/lib/billing/onboard.ts`, `src/app/(site)/signup/complete/page.tsx`
- Modify: `src/app/(site)/signup/actions.ts`, `src/app/(site)/signup/page.tsx`, `src/lib/site/signup.ts`, `src/lib/site/routes.ts` (add `signupComplete: "/signup/complete"`), `src/components/auth/AuthShell.tsx` (the `preview` prop becomes optional and unused by signup)
- Delete: `src/app/(site)/signup/checkout/page.tsx`
- Test: `scripts/test/billing-onboard.test.ts`, `scripts/test/site-signup.test.ts` (rewrite the two preview assertions), `scripts/test/site-routes.test.ts` (map the new route)

**Interfaces:**
- Consumes: Task 1 repo methods, Task 3 `createCheckoutSession`/`retrieveCheckoutSession`, Task 4 `mapStripeSubscriptionStatus`/`verifyClaimToken`.
- Produces:
  ```ts
  // onboard.ts
  export type OnboardRepo = Pick<GhlRepository, "getProfileByEmail" | "createAccount" | "createProfile" | "claimGhlAccount" | "getAccountById" | "updateAccountBilling">;
  export interface OnboardDeps { createAuthUser: (email: string) => Promise<{ id: string } | { error: "exists" | "failed" }>; checkout: typeof createCheckoutSession; appUrl: string }
  export type SignupOutcome = { kind: "checkout"; url: string } | { kind: "exists" } | { kind: "unavailable" } | { kind: "failed" };
  export async function startSignup(repo: OnboardRepo, deps: OnboardDeps, input: SignupInput & { claimLocationId: string | null }): Promise<SignupOutcome>
  export async function createCheckoutForAccount(repo: OnboardRepo, deps: Pick<OnboardDeps, "checkout" | "appUrl">, account: Account): Promise<SignupOutcome>
  export async function applyCheckoutSession(repo: Pick<GhlRepository, "getAccountById" | "updateAccountBilling">, session: StripeCheckoutSession): Promise<{ applied: boolean; accountId: string | null }>
  ```
  `createCheckoutForAccount` uses `successUrl = ${appUrl}/signup/complete?session_id={CHECKOUT_SESSION_ID}` (literal Stripe placeholder) and `cancelUrl = ${appUrl}/login?error=checkout`. `applyCheckoutSession`: `session.status !== "complete"` or no `metadata.account_id` or no `session.subscription` → `{ applied: false }`; else write `stripeCustomerId`, `stripeSubscriptionId`, `billingStatus = mapStripeSubscriptionStatus(sub.status) ?? current`, `trialEndsAt = sub.trialEnd ? new Date(sub.trialEnd * 1000).toISOString() : null`. Applying to an account whose ids already match returns `{ applied: true }` without error.

- [ ] **Step 1: Write failing tests (`billing-onboard.test.ts`, fake repo + deps)**

- `startSignup` happy path: no existing profile → `createAuthUser` called with the lower-cased email → `createAccount({ name, kind, ownerEmail })` → `createProfile({ id: <auth id>, role: "account", email, accountId })` → `checkout` called with `accountId` and the two URLs above → `{ kind: "checkout", url }`. Order asserted via a call log.
- Existing profile → `{ kind: "exists" }` and no other call.
- `createAuthUser` returns `{ error: "exists" }` → `{ kind: "exists" }`; `{ error: "failed" }` → `{ kind: "failed" }`.
- With `claimLocationId: "loc"` → `claimGhlAccount("loc", <accountId>)` is called after the profile; its result does not change the outcome.
- `checkout` returns `{ ok: false }` → `{ kind: "failed" }` but the account and profile already exist (asserted on the fake).
- `applyCheckoutSession` for `status: "complete"`, `metadata.account_id: "acc-1"`, subscription `trialing` with `trialEnd 1_800_000_000` → `updateAccountBilling("acc-1", { stripeCustomerId: "cus", stripeSubscriptionId: "sub", billingStatus: "trialing", trialEndsAt: "2027-01-15T08:00:00.000Z" })`; called twice → second call still `{ applied: true }`; `status: "open"` → `{ applied: false }`; unknown account → `{ applied: false, accountId: "acc-1" }`.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `onboard.ts`.**

- [ ] **Step 4: Wire the signup action and pages**

`src/app/(site)/signup/actions.ts` → `export async function startSignupAction(formData)`: `validateSignup`; on errors redirect as today; `claimLocationId = claim ? verifyClaimToken(claim)?.locationId ?? null : null`; if `!isStripeConfigured()` or `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` is unset → `redirect("/signup?error=unavailable")`; call `startSignup(repo, { createAuthUser, checkout: createCheckoutSession, appUrl: brandConfig().appUrl }, …)`; `checkout` → `redirect(url)`; `exists` → `redirect("/login?error=exists")`; else `redirect("/signup?error=failed")`. `createAuthUser` lives in this file: service-role `createClient(...).auth.admin.createUser({ email, email_confirm: true })`; an error whose message matches `/already/i` → `{ error: "exists" }`, any other → `{ error: "failed" }`.

`signup/page.tsx`: drop the `preview` prop; add `error` copy for `unavailable` ("Signups aren't open yet.") and `failed` ("Something went wrong creating your account. Try again, or contact support."). `login/page.tsx` gains `exists`: "That email already has an account. We've sent nothing — request a sign-in link below." (Task 2 added `checkout`/`no_account`.)

`signup/complete/page.tsx` (dynamic): read `session_id`; `retrieveCheckoutSession`; if `ok` → `applyCheckoutSession(repo, session)`; then, on the cookie client, `signInWithOtp({ email: <session customer email from metadata.owner_email or the account's ownerEmail>, options: { emailRedirectTo: `${appUrl}/auth/callback`, shouldCreateUser: false } })`; render `AuthShell` "You're nearly there" + "We've emailed a sign-in link to <email>. Open it in this browser." On any failure render "Your card was saved. Request a sign-in link from the login page." with a link to `/login`. Note: `signInWithOtp` on the cookie client writes the PKCE verifier cookie, so this page must call it from a server action or route handler, not during render (see `cookies.md`, "Setting cookies is not supported during Server Component rendering"). Therefore: the page renders a one-button form "Email me my sign-in link" whose action `sendCompleteLinkAction(formData)` (in `signup/actions.ts`, takes `session_id`) does the retrieve + apply + `signInWithOtp` + `redirect("/login?sent=1")`. The page itself only shows the card-saved confirmation and that button.

Add `metadata.owner_email` to `createCheckoutSession`'s session `metadata` (Task 3's test pins `account_id`; extend it there with `owner_email`).

- [ ] **Step 5: Update site tests**

`site-signup.test.ts`: replace "signup action never imports supabase or stripe" with "signup action calls startSignup and never inlines Stripe params" (`assert.match(src, /startSignup\(/)` and `assert.doesNotMatch(src, /api\.stripe\.com/)`); delete the `checkoutQuery` tests and the function if nothing else uses it; `site-routes.test.ts` maps `signupComplete` to `src/app/(site)/signup/complete/page.tsx`.

- [ ] **Step 6: Verify and commit**

Run: `npm run check && NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`
```bash
git add -A src/app/(site)/signup src/lib/billing/onboard.ts src/lib/site src/lib/stripe/billing.ts src/components/auth scripts/test
git commit -m "feat: signup creates the account and sends the customer to Stripe Checkout"
```

---

### Task 6: Stripe webhook

**Files:**
- Create: `src/lib/billing/webhook-handler.ts`, `src/lib/billing/quantity.ts`, `src/app/api/webhooks/billing/route.ts`
- Test: `scripts/test/billing-webhook.test.ts`

**Interfaces:**
- Consumes: Task 3 (`verifyStripeSignature`, `parseSubscription`, `retrieveSubscription`, `setSubscriptionItemQuantity`), Task 4 status map, Task 5 `applyCheckoutSession`, Task 1 repo.
- Produces:
  ```ts
  // quantity.ts
  export type QuantityRepo = Pick<GhlRepository, "countActivatedForAccount">;
  export interface QuantityDeps { retrieveSubscription: typeof retrieveSubscription; setQuantity: typeof setSubscriptionItemQuantity; notify: (text: string) => void }
  export async function syncSubscriptionQuantity(repo: QuantityRepo, deps: QuantityDeps, account: Account): Promise<{ ok: true; quantity: number } | { ok: false; reason: "no_subscription" | "stripe_failed" }>
  // webhook-handler.ts
  export interface StripeEvent { id: string; type: string; data: { object: Record<string, unknown> } }
  export type WebhookRepo = Pick<GhlRepository, "recordStripeEvent" | "getAccountById" | "getAccountByStripeCustomerId" | "updateAccountBilling">;
  export interface WebhookDeps { applyCheckout: (session: StripeCheckoutSession) => Promise<unknown>; retrieveCheckoutSession: typeof retrieveCheckoutSession; syncQuantity: (account: Account) => Promise<unknown>; notify: (text: string) => void }
  export type WebhookOutcome = { kind: "duplicate" } | { kind: "ignored"; type: string } | { kind: "handled"; type: string } | { kind: "unknown_account"; type: string };
  export async function handleBillingEvent(repo: WebhookRepo, deps: WebhookDeps, event: StripeEvent): Promise<WebhookOutcome>
  ```
  `syncSubscriptionQuantity`: `comped` or no `stripeSubscriptionId` → `no_subscription` (not an error); retrieve the subscription for `itemId`; set quantity to `countActivatedForAccount`; on Stripe failure notify Slack `"Billing quantity sync failed for account <id>: <message>"`.

- [ ] **Step 1: Write failing tests**

- `recordStripeEvent` returns false → `{ kind: "duplicate" }`, nothing else called.
- `checkout.session.completed` → `retrieveCheckoutSession(id)` (fresh, expanded; never trust the event body's subscription) → `applyCheckout(session)` → `syncQuantity(account)` (account re-read by `metadata.account_id`) → `handled`.
- `customer.subscription.updated` with `metadata.account_id: "acc-1"`, status `past_due` → `updateAccountBilling("acc-1", { billingStatus: "past_due", trialEndsAt: null, cancelledAt: null, stripeSubscriptionId: "sub" })` → `handled`.
- `customer.subscription.deleted` status `canceled`, `canceled_at: 1_800_000_000` → `billingStatus: "cancelled"`, `cancelledAt: "2027-01-15T08:00:00.000Z"`.
- Subscription event without `metadata.account_id` → lookup by `customer` → found → handled; not found → `unknown_account` and `notify` called once.
- Status `incomplete` → no `updateAccountBilling` call, outcome `handled` (Review Focus 3).
- `invoice.payment_failed` → `notify` once with the customer id, no billing write, `handled`.
- `customer.created` → `{ kind: "ignored" }`.
- `syncSubscriptionQuantity`: comped → `no_subscription`; 2 activated → `setQuantity(itemId, 2)` → `{ ok: true, quantity: 2 }`; Stripe error → `stripe_failed` + `notify`.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement the handler, the quantity sync and the route**

Route (`src/app/api/webhooks/billing/route.ts`, mirrors `crm-provider/route.ts`'s shape): `await request.text()` first; `STRIPE_WEBHOOK_SECRET` unset → 503 `{ ok: false, error: "STRIPE_WEBHOOK_SECRET not configured" }`; bad signature → 400 `invalid_signature`; bad JSON → 400; then `handleBillingEvent(repo, defaultDeps, event)` → 200 `{ ok: true, outcome }`. `unknown_account` still returns 200 (Stripe retrying will not help). Any thrown error → 500 and a console error (Stripe retries). `export const dynamic = "force-dynamic"`.

- [ ] **Step 4: Verify and commit**

```bash
git add src/lib/billing/webhook-handler.ts src/lib/billing/quantity.ts src/app/api/webhooks/billing scripts/test/billing-webhook.test.ts
git commit -m "feat: Stripe billing webhook with idempotent subscription sync"
```

---

### Task 7: Sending gate and the in-GHL page states

**Files:**
- Modify: `src/lib/ghl-provider.ts` (`GhlProviderRepo` + the gate call), `src/app/api/crm/embed/session/route.ts`, `src/app/embed/crm/CrmEmbedClient.tsx`
- Test: `scripts/test/ghl.test.ts` (extend the provider fakes), `scripts/test/embed-states.test.ts`

**Interfaces:**
- Consumes: Task 4 `sendingGate`, `claimSignupUrl`, `isClaimConfigured`; Task 1 `getAccountById`, `GhlAccount.accountId/activatedAt`.
- Produces: `GhlProviderRepo` adds `"getAccountById"`. Embed session responses gain `{ ok: true, state: "unclaimed", claimUrl: string | null }`, `{ ok: true, state: "billing_paused" }`, `{ ok: true, state: "not_activated" }`; `CrmEmbedClient` `Phase` gains `"unclaimed" | "billing_paused" | "not_activated"`.

- [ ] **Step 1: Extend `scripts/test/ghl.test.ts`**

The existing fake repo's `getGhlAccountByLocationId` rows gain `accountId`/`activatedAt`; add `getAccountById`. New cases for `handleProviderOutboundMessage`: location `activatedAt: null` → `{ kind: "refused", reason: "WhatsApp isn't activated for this sub-account" }`, `updateGhlOutboundSendState` called with that `refusalReason`, `sendWhatsapp` never called, status reported `failed` inline; activated + account `paused` → refused with `"PingWren subscription inactive — the account owner needs to update billing"`; activated + `past_due` → sends; activated + `comped` → sends; activated + account row missing → refused inactive. Every pre-existing case gets `activatedAt: "2026-10-01T00:00:00Z"`, `accountId: "acc"` and an `active` account so it keeps passing. The gate runs after the `needs_reauth`/`disabled` check and before `mediaSplit`, so the media path is gated too (one test with `mediaSplit` on).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement the gate call in `handleProviderOutboundMessage`**

Inside Phase B, before `if (mediaSplit)`: `const billing = account.accountId ? (await repo.getAccountById(account.accountId))?.billingStatus ?? null : null; const gateReason = sendingGate(account, billing, brandConfig().name); if (gateReason) { refuse + report exactly as the needs_reauth branch does }`.

- [ ] **Step 4: Embed states, tests first**

`scripts/test/embed-states.test.ts` tests a new pure function `embedStateFor(account: GhlAccount, billing: BillingStatus | null, claimUrl: string | null)` exported from `src/app/api/crm/embed/session/logic.ts` (zero Next imports): `disabled` → `"disabled"`; `accountId null` → `{ state: "unclaimed", claimUrl }`; billing in `pending|paused|cancelled` or null → `"billing_paused"`; `activatedAt null` → `"not_activated"`; else `"ok"`. The route calls it after the `not_installed` check, minting `claimUrl` with `claimSignupUrl(brandConfig().appUrl, locationId)` when `isClaimConfigured()` else `null`.

`CrmEmbedClient.tsx` renders, per the spec §4, with `EmptyState`: unclaimed → title "Start your 7-day free trial", description "Connect this sub-account's WhatsApp by creating a <brand> account.", and a link button to `claimUrl` with `target="_blank"` (absent when `claimUrl` is null: description then says "Visit <brand> to start your free trial."); billing_paused → "Sending is paused. The account owner needs to update billing."; not_activated → "WhatsApp isn't active for this sub-account. Ask your account owner to activate it." No QR in any of the three.

- [ ] **Step 5: Verify and commit**

Run: `npm run check && NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`
```bash
git add src/lib/ghl-provider.ts src/app/api/crm/embed src/app/embed/crm scripts/test/ghl.test.ts scripts/test/embed-states.test.ts
git commit -m "feat: sending gate on activation and billing; in-GHL page states"
```

---

### Task 8: Link GHL installs to an account, with the conflict rule

**Files:**
- Modify: `src/app/api/crm/oauth/start/route.ts`, `src/app/api/crm/oauth/callback/route.ts`, `src/app/api/crm/oauth/callback/logic.ts`
- Test: `scripts/test/ghl-oauth-callback.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 `Session.accountId`, Task 1 `claimGhlAccount`, `GhlAccount.accountId`.
- Produces:
  ```ts
  export type InstallOutcome = "installed" | "conflict" | "failed";
  export async function installGhlLocation(repo, tokens, locationName?: string | null, accountId: string | null = null): Promise<InstallOutcome>
  export interface GhlBulkInstallResult { totalFound; installed; failed; conflicts: number; skippedOverCap }
  export async function runGhlBulkInstall(repo, deps, companyId, locations, cap?, accountId?: string | null): Promise<GhlBulkInstallResult>
  ```
  `GhlOauthCallbackRepo` adds `"claimGhlAccount"`. Signed state for `ghl-install` carries `{ accountId }` (`null` for owner). The callback redirects an account session to `/dashboard?ghl=<reason>&installed=&failed=&conflicts=` and an owner to `/admin?ghl=…` as today; `conflicts` is a plain count. With NO session the callback no longer refuses: it installs with `accountId = null` (an unclaimed Marketplace install, spec §1) and redirects to `/signup?from=ghl`.

- [ ] **Step 1: Extend the callback tests**

- Existing row with `accountId: "other"`, install for `"acc-1"` → `"conflict"`, no upsert, no tenant minted.
- Existing row with `accountId: null`, install for `"acc-1"` → upsert + `claimGhlAccount(locationId, "acc-1")` → `"installed"`.
- New row for `"acc-1"` → tenant minted, upsert, then `claimGhlAccount` → `"installed"`.
- Install with `accountId: null` onto a row owned by `"other"` → `"installed"` (reinstall refreshes tokens; ownership untouched, `claimGhlAccount` not called).
- Bulk: three locations, one owned elsewhere → `{ installed: 2, failed: 0, conflicts: 1 }` (Review Focus 4).
- Add `conflicts: 0` to every existing bulk expectation.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

`logic.ts` per the interfaces. `start/route.ts`: accept `owner` or `account` session; `signKindedState("ghl-install", { accountId: session.accountId })`; `back()` targets `/dashboard` for account sessions. `callback/route.ts`: read `accountId` from the verified state when present, else from the session; require that the state's `accountId` equals the session's (mismatch → `forbidden`); a request with no session and no state is the Marketplace path (see Interfaces); on any `conflict` in the result send Slack `"GHL location <id> is already connected to another <brand> account; install by <accountId> skipped."` via `notifyText`. Keep the comment block explaining why a missing state is tolerated and update it for the sessionless path.

- [ ] **Step 4: Verify and commit**

```bash
git add src/app/api/crm/oauth scripts/test/ghl-oauth-callback.test.ts
git commit -m "feat: GHL installs link to the signed-in account; conflicts are skipped and counted"
```

---

### Task 9: Real AccountDataSource and the dashboard on it

**Files:**
- Create: `src/lib/account-data/supabase.ts`, `src/lib/account-data/map.ts`, `src/components/app/GhlResultNotice.tsx`
- Modify: `src/lib/account-data/index.ts`, `src/lib/account-data/derive.ts`, `src/lib/site/dashboard-url.ts`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/dashboard/billing/page.tsx` (only what the signature change forces; Task 11 finishes it), `src/components/app/{PlanHeader,LocationTable,RowActions,LocationRowDetail}.tsx`, `src/lib/site/routes.ts` (add `connectGhl: "/api/crm/oauth/start"`)
- Delete: `src/lib/account-data/preview.ts`, `src/components/app/ScenarioSwitcher.tsx`, `src/components/site/PreviewBadge.tsx`
- Test: `scripts/test/account-data-map.test.ts`, `scripts/test/site-account-data.test.ts` (rewrite), `scripts/test/site-account-derive.test.ts` (extend), `scripts/test/site-dashboard.test.ts` (rewrite the preview assertions), `scripts/test/site-samples.test.ts` and `scripts/test/ghl-branding.test.ts` (drop their PreviewBadge references)

**Interfaces:**
- Consumes: Task 1 repo methods, Task 2 `requireAccountSession`, Task 3 `retrieveSubscription`, Task 0 pricing.
- Produces:
  ```ts
  // map.ts
  export function toWhatsappState(activated: boolean, summary: WhatsappSessionSummary | null, pendingSend: number): WhatsappState
  export function toLocationRow(loc: GhlAccountSummary, summary: WhatsappSessionSummary | null, stats: LocationStats, now: Date, dailyCap: number): LocationRow
  export const PROVIDER_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
  export const DEFAULT_DAILY_CAP = 150;    // mirrors the bridge's WA_DAILY_CAP default
  // supabase.ts
  export class SupabaseAccountDataSource implements AccountDataSource { constructor(repo: GhlRepository, deps: { retrieveSubscription: typeof retrieveSubscription }, accountId: string, now: Date); readonly preview = false; … }
  // index.ts
  export function getAccountDataSource(session: AccountSession, now?: Date): AccountDataSource
  // types.ts: AccountSummary gains `stripeCustomerId: string | null; stripeSubscriptionId: string | null`; BillingSummary gains `cancelAtPeriodEnd: boolean`
  // derive.ts: planStatus handles "pending" → { label: "Trial not started", tone: "warn", banner: "Add a card to start your 7-day free trial." }; `headline` takes (rows) and uses monthlyCostPence
  // dashboard-url.ts
  export type DashboardResult = "activated" | "deactivated" | "disconnected" | "link" | "trial_cap" | "platform_cap" | "billing_inactive" | "stripe_failed" | "not_found";
  export function dashboardHref(opts?: { filter?: DashboardFilter; result?: DashboardResult; focus?: string }): string   // ?filter=attention&result=…&focus=<locationId>#row-<locationId>
  export function billingHref(): string
  export const DASHBOARD_RESULT_COPY: Record<DashboardResult, string>
  ```
  Row state mapping: `!activated` → `not_active`; summary `connected` → `{ connected, number: phoneNumber ?? "" }`; summary `waiting_qr`, or no summary, or a summary that has never connected (`lastConnectedAt === null`) → `waiting_qr`; otherwise → `{ disconnected, waiting: pendingSend }`. `providerNudge` = activated for at least 24h, state connected, and `!stats.everReceived`. `heldMessages = stats.pendingSend`; `optOuts = 0` (the STOP feature is the reliability plan's; this column is wired when it lands — leave a one-line comment). `getBilling`: no subscription → `{ cardLast4: null, nextInvoiceAt: null, nextInvoiceAmount: null, currency, portalAvailable: false, cancelAtPeriodEnd: false }`; else `retrieveSubscription` → `cardLast4`, `nextInvoiceAt = currentPeriodEnd*1000`, `nextInvoiceAmount = monthlyCostPence(activeCount) / 100`, `portalAvailable = !!stripeCustomerId`.

- [ ] **Step 1: Write `account-data-map.test.ts`**

Pin each mapping rule above with one case, including: `lastConnectedAt` set + status `disconnected` + `pendingSend 4` → `{ disconnected, waiting: 4 }`; nudge true at exactly 24h + connected + `everReceived false`; nudge false when `everReceived true`; `dailyCap` passed through.

- [ ] **Step 2: Rewrite `site-account-data.test.ts`**

With a fake repo and a fake `retrieveSubscription`: `listLocations` calls `listGhlAccountsForAccount("acc-1")`, then `getWhatsappSessionSummariesForTenants` with the rows' tenant ids and `getLocationStats` with their location ids and `sinceIso = now - 7 days`, and returns rows in label order; `getAccount` maps `Account` → `AccountSummary`; `getBilling` for a comped account never calls Stripe; `getAccountDataSource(session).preview === false`.

- [ ] **Step 3: Run, expect failure.**

- [ ] **Step 4: Implement map, source, index; delete the preview files; update derive and dashboard-url**

- [ ] **Step 5: Dashboard page and components**

`dashboard/page.tsx`: `const session = await requireAccountSession()`; `source = getAccountDataSource(session, now)`; keep the layout; replace the preview notice with `DASHBOARD_RESULT_COPY[result]` (role `status`) and `<GhlResultNotice reason={params.ghl} installed failed conflicts />` whose copy map covers every `?ghl=` reason `GhlAccountsPanel` knows plus the conflict sentence `"This sub-account is already connected to another <brand> account. Contact support."`; `generateMetadata` title `Dashboard — <brand>`; remove `ScenarioSwitcher`, `PreviewBadge`, `scenario` props everywhere (`LocationTable`, `RowActions`, `PrimaryAction` take `filter` only — Task 10 wires the real actions; for this task point the forms at a placeholder `rowAction` in `dashboard/actions.ts` that redirects with `result: "not_found"`). `PlanHeader`'s connect button links to `SITE_ROUTES.connectGhl` (a plain `<a>`, not `<Link>`, since it leaves the app); for `pending` accounts it instead renders a form button "Add a card to start your trial" posting to `startCheckoutAction` (Task 11 adds the action; this task adds the prop `pendingCheckoutAction?`).

- [ ] **Step 6: Update the site tests named in Files; run everything**

Run: `npm run check && NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`

- [ ] **Step 7: Commit**

```bash
git add -A src/lib/account-data src/lib/site src/app/(app) src/components/app src/components/site scripts/test
git commit -m "feat: dashboard reads real account data; preview source removed"
```

---

### Task 10: Row actions: activate, deactivate, QR, connect link, disconnect

**Files:**
- Create: `src/lib/billing/activate.ts`, `src/app/(app)/dashboard/whatsapp-actions.ts`, `src/components/app/LocationQrPanel.tsx`
- Modify: `src/app/(app)/dashboard/actions.ts`, `src/components/app/{RowActions,LocationRowDetail,LocationTable}.tsx`, `src/app/(app)/dashboard/page.tsx`
- Test: `scripts/test/billing-activate.test.ts`, `scripts/test/site-dashboard.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4 `canActivate`/`platformCap`, Task 6 `syncSubscriptionQuantity`, Task 1 `setGhlActivated`/`countActivatedForAccount`/`countActivatedAll`, existing `mintConnectLinkToken`, `connectWhatsappSession`/`getWhatsappBridgeSession`/`logoutWhatsappSession`.
- Produces:
  ```ts
  // activate.ts
  export type ActivateRepo = Pick<GhlRepository, "getGhlAccountByLocationId" | "getAccountById" | "countActivatedForAccount" | "countActivatedAll" | "setGhlActivated">;
  export interface ActivateDeps { retrieveSubscription; setQuantity; notify; now: () => Date; platformCap: () => number | null }
  export type ActivateOutcome = { ok: true } | { ok: false; reason: ActivateRefusal | "not_found" | "stripe_failed" };
  export async function activateLocation(repo, deps, accountId: string, locationId: string): Promise<ActivateOutcome>
  export async function deactivateLocation(repo, deps, accountId: string, locationId: string): Promise<{ ok: true; quantitySynced: boolean } | { ok: false; reason: "not_found" }>
  // actions.ts
  export async function rowAction(formData: FormData): Promise<void>   // intent: activate | deactivate | disconnect | send-link | show-qr; location; filter
  // whatsapp-actions.ts (account-scoped twins of src/app/admin/actions.ts's three)
  export async function connectLocationWhatsappAction(locationId: string): Promise<PanelBridgeSessionResult>
  export async function pollLocationWhatsappAction(locationId: string): Promise<PanelBridgeSessionResult>
  export async function logoutLocationWhatsappAction(locationId: string): Promise<BridgeOkResult>
  ```
  `activateLocation`: location must belong to `accountId` (else `not_found`); `canActivate(...)`; for a non-comped account with a subscription: `setQuantity(itemId, accountActive + 1)` FIRST; on failure → `stripe_failed`, nothing written; then `setGhlActivated(locationId, now)`; if that throws, call `setQuantity(itemId, accountActive)` (best effort) and rethrow. `deactivateLocation`: `setGhlActivated(locationId, null)` first, then `syncSubscriptionQuantity`; a Stripe failure is reported by the sync's own Slack notify and returned as `quantitySynced: false` (Review Focus 5). `rowAction` redirects with `dashboardHref({ filter, result, focus: locationId })`: activate → `activated`/the refusal; deactivate → `deactivated`; disconnect → `logoutWhatsappSession(tenantId)` then `disconnected`; send-link → `link` (the page re-mints the link for `focus` and shows it in that row's detail; the token never rides in the URL); show-qr → `?qr=<locationId>` (page opens that row's `LocationQrPanel`). Every intent first checks ownership via `listGhlAccountsForAccount`/`getGhlAccountByLocationId` + `accountId` equality; a mismatch is `not_found`.

- [ ] **Step 1: Write `billing-activate.test.ts`**

With fakes: trial account at 3 active → `trial_cap`, no Stripe call, no DB write; active account, 2 active → `setQuantity(itemId, 3)` then `setGhlActivated(loc, <now iso>)` (order via call log) → ok; Stripe fails → `stripe_failed`, `setGhlActivated` never called; `setGhlActivated` throws → `setQuantity(itemId, 2)` called again, error rethrown; comped → no Stripe call, activated; location owned by another account → `not_found`; platform cap `2` with `countActivatedAll 2` → `platform_cap`; deactivate → `setGhlActivated(loc, null)` then quantity sync with 1; sync failing → `{ ok: true, quantitySynced: false }` and `notify` called.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `activate.ts`, the actions and the components**

`LocationQrPanel` is a client component that renders the existing `WhatsappConnectionPanel` (as `CrmEmbedClient` does, `coachId: ""` placeholder) with the three account actions bound to `locationId`, copy title "Link WhatsApp for <name>". `LocationRowDetail` gains `connectLink?: string` (rendered as a copyable read-only input with the sentence "Send this link to whoever has the phone. It works for 7 days.") and `qrOpen?: boolean`. `RowActions`/`PrimaryAction` post to `rowAction` with `intent`, `location`, `filter`.

- [ ] **Step 4: Extend `site-dashboard.test.ts`**

File-content: `RowActions.tsx` imports `rowAction` and not `previewRowAction`; `dashboard/actions.ts` imports `activateLocation` and `requireAccountSession`; `whatsapp-actions.ts` calls `requireAccountSession()` in each exported function.

- [ ] **Step 5: Verify and commit**

Run: `npm run check && NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`
```bash
git add src/lib/billing/activate.ts src/app/(app)/dashboard src/components/app scripts/test
git commit -m "feat: activate, deactivate, QR, connect link and disconnect from the dashboard"
```

---

### Task 11: Billing page: Customer Portal, end trial early, pending checkout

**Files:**
- Create: `src/app/(app)/dashboard/billing/actions.ts`
- Modify: `src/app/(app)/dashboard/billing/page.tsx`, `src/components/app/PlanHeader.tsx` (wire `startCheckoutAction`), `src/lib/account-data/derive.ts` (`trialCapMessage`)
- Test: `scripts/test/site-billing.test.ts`

**Interfaces:**
- Consumes: Task 3 `createPortalSession`, `endTrialNow`; Task 5 `createCheckoutForAccount`; Task 9 source.
- Produces:
  ```ts
  export async function openBillingPortalAction(): Promise<void>   // requireAccountSession → account → createPortalSession(customerId, `${appUrl}/dashboard/billing`) → redirect(url); no customer → redirect(billingHref() + "?error=no_portal")
  export async function endTrialNowAction(): Promise<void>          // trialing only; endTrialNow(subscriptionId); the webhook moves status; redirect(billingHref() + "?result=trial_ended")
  export async function startCheckoutAction(): Promise<void>        // pending only; createCheckoutForAccount → redirect(url)
  export const TRIAL_CAP_MESSAGE = "Your trial includes 3 numbers. Start your paid plan now to add more.";
  ```
  Billing page copy: plan row uses `tierSentence(currency)` from pricing; "Manage billing" is a form button to `openBillingPortalAction` (enabled when `portalAvailable`); while `trialing` a secondary "Start my paid plan now" button to `endTrialNowAction` with the sentence "Ends the free trial today and starts monthly billing for your active numbers."; `cancelAtPeriodEnd` shows "Cancels at the end of this period."; `pending` shows the "Add a card" button. The dashboard's `trial_cap` result renders `TRIAL_CAP_MESSAGE` with the same "Start my paid plan now" form.

- [ ] **Step 1: Write `site-billing.test.ts`** (file-content assertions, matching the site tests' style): the billing page no longer contains `(sample)`, `PreviewBadge` or `disabled aria-describedby="portal-hint"`; it imports `openBillingPortalAction` and `endTrialNowAction`; `actions.ts` calls `requireAccountSession` in every exported function and never reads `formData` for the customer id (the id comes from the account row).

- [ ] **Step 2: Run, expect failure. Step 3: Implement. Step 4: Verify and commit**

```bash
git add src/app/(app)/dashboard/billing src/components/app/PlanHeader.tsx src/lib/account-data/derive.ts scripts/test/site-billing.test.ts
git commit -m "feat: billing page with Customer Portal, end trial early and pending checkout"
```

---

### Task 12: Admin accounts panel, cancellation cleanup, RLS check script

**Files:**
- Create: `src/components/owner/AccountsPanel.tsx`, `src/lib/billing/cleanup.ts`, `scripts/rls-check.mjs`
- Modify: `src/app/admin/page.tsx`, `src/app/api/cron/drain/route.ts`
- Test: `scripts/test/billing-cleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 `listAccountsForAdmin`, `listAccountsCancelledBefore`, `listGhlAccountsForAccount`, `setGhlActivated`, `updateAccountBilling`; existing `logoutWhatsappSession`.
- Produces:
  ```ts
  export const CANCELLED_CLEANUP_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
  export async function purgeCancelledAccounts(repo, deps: { logout: (tenantId: string) => Promise<BridgeOkResult>; now: () => Date }): Promise<{ accounts: number; locations: number; failures: number }>
  ```
  For each account from `listAccountsCancelledBefore(now - 14d)`: for each of its locations `logout(tenantId)` (the bridge deletes stored credentials on logout) and `setGhlActivated(locationId, null)`; then `updateAccountBilling(id, { cleanedUpAt: now })` only when every logout returned ok, so a bridge outage retries next day.

- [ ] **Step 1: Write `billing-cleanup.test.ts`**: two accounts, one with a failing logout → `{ accounts: 2, locations: 3, failures: 1 }`, `cleanedUpAt` written for the clean one only; an empty list → zeros.

- [ ] **Step 2: Run, expect failure. Step 3: Implement**

Cron: add a fourth non-fatal pass after the purge, included in the JSON summary as `cancelledCleanup`. `AccountsPanel`: a table (name, kind, status chip, numbers active / locations, trial ends, owner email) above the GHL panels; `/admin` passes `await repo.listAccountsForAdmin()`. `scripts/rls-check.mjs` (not part of `npm test`; documented in Task 13): takes `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RLS_CHECK_EMAIL`; uses the service role to `auth.admin.generateLink({ type: "magiclink", email })`, the anon client to `verifyOtp({ token_hash, type: "magiclink" })`, then `select("*").limit(1)` on each of `profiles, accounts, stripe_events, whatsapp_tenants, whatsapp_sessions, whatsapp_session_keys, whatsapp_messages, whatsapp_inbound_messages, ghl_accounts, ghl_outbound_messages, ghl_outbound_attachments`; passes only if every read returns zero rows or a permission error; exit code 1 otherwise.

- [ ] **Step 4: Verify and commit**

```bash
git add src/components/owner/AccountsPanel.tsx src/lib/billing/cleanup.ts scripts/rls-check.mjs src/app/admin/page.tsx src/app/api/cron/drain/route.ts scripts/test/billing-cleanup.test.ts
git commit -m "feat: admin accounts list, 14-day cancellation cleanup, RLS check script"
```

---

### Task 13: Go-live checklist, env tables, final verification

**Files:**
- Create: `docs/GO-LIVE-ACCOUNTS.md`
- Modify: `docs/GO-LIVE-FOUNDATION.md` (env table: remove `BRAND_PRICE_PER_NUMBER` and `BRAND_CURRENCY`, add the Stripe rows and `BRAND_MAX_ACTIVE_NUMBERS`; Part 1c auth URLs), `README.md` (env table)
- Test: `scripts/test/go-live-docs.test.ts`

- [ ] **Step 1: Write `go-live-docs.test.ts`**: `docs/GO-LIVE-ACCOUNTS.md` exists and mentions each of `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_AUTOMATIC_TAX`, `BRAND_MAX_ACTIVE_NUMBERS`, `/api/webhooks/billing`, `tiers_mode`, `volume`, `1499`, `799`, `0002_accounts.sql`, `rls-check.mjs`, `comped`; `docs/GO-LIVE-FOUNDATION.md` no longer mentions `BRAND_PRICE_PER_NUMBER`.

- [ ] **Step 2: Write `docs/GO-LIVE-ACCOUNTS.md`** with these sections, in Charlie's operator voice (same register as GO-LIVE-FOUNDATION, rule zero repeated):
  1. **Supabase** — there is no PingWren project yet (the org holds Tendari, SyncMe, CashMaker, FitLink Payments): create one per the foundation doc, then apply `0001_init.sql` and `0002_accounts.sql` in order. Auth → URL configuration: Site URL `<app>`, redirect `<app>/auth/callback`. Auth → Email: Supabase's built-in sender is rate-limited; set custom SMTP (Resend on the brand domain) before any real signups. Insert the FitClosers row by hand: `insert into accounts (name, kind, owner_email, billing_status) values ('FitClosers', 'agency', '<email>', 'comped')`, then create its auth user and `profiles` row (role `account`, that `account_id`). Run `node scripts/rls-check.mjs` with a throwaway account user and expect PASS.
  2. **Stripe (test mode first)** — new Stripe account for PingWren. Product "PingWren WhatsApp number", one recurring monthly GBP price, `billing_scheme = tiered`, `tiers_mode = volume`, tiers: up to 9 → 1499 pence per unit; 10 and above → 799 pence per unit. Copy the price id → `STRIPE_PRICE_ID`. Settings → Subscriptions: "cancel at end of period" on customer-initiated cancels; failed-payment retries ending in `unpaid` after about 7 days. Customer Portal: enable card update, invoice history, cancel subscription. Stripe Tax: optional; if on, set `STRIPE_AUTOMATIC_TAX=true`. Webhook endpoint `<app>/api/webhooks/billing` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` → `STRIPE_WEBHOOK_SECRET`. Secret key → `STRIPE_SECRET_KEY`.
  3. **Vercel env** — the table of new variables (required/default/meaning): `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_AUTOMATIC_TAX`, `BRAND_MAX_ACTIVE_NUMBERS`; note `ONBOARD_STATE_SECRET` now also signs claim links.
  4. **First light** — sign up with a test card `4242 4242 4242 4242`, open the emailed link, Connect GoHighLevel, activate one number, scan, send a workflow SMS; then check Stripe shows quantity 1; deactivate → quantity 0; try a fourth activation on trial → the cap message.
  5. **Go-live gates** — carry forward W20's list (held messages, STOP, legal text) and add: switch Stripe to live keys and a live price; re-run the first-light sequence with a real card.

- [ ] **Step 3: Update the foundation doc and README env tables.**

- [ ] **Step 4: Final verification**

Run: `npm run check && NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build`
Expected: both pass. Also `node scripts/test/no-fitclosers.test.ts` is part of `npm test` and must pass.

- [ ] **Step 5: Commit**

```bash
git add docs/GO-LIVE-ACCOUNTS.md docs/GO-LIVE-FOUNDATION.md README.md scripts/test/go-live-docs.test.ts
git commit -m "docs: accounts and billing go-live checklist"
```

---

## Self-review notes

- Spec coverage: §1 data model (T1), roles via `profiles` (T1/T2), linking + conflict + Marketplace-first + claim token (T4/T7/T8), admin accounts list (T12); §2 flow (T5), Stripe webhook + status map + quantity sync + portal (T3/T6/T11), sending gate (T7), trial cap + platform cap (T4/T10), cancellation cleanup (T12); §3 header/rows/filter/actions/detail/nudge (T9/T10), settings billing (T11); §4 embed states (T7); Testing: unit cases for the status map, gate, caps, conflict rule, claim token, nudge (T4/T7/T8/T9/T10), RLS script (T12). Deferred to later stages and said so in the plan: owner alert emails (Resend), STOP opt-out counts, waitlist beyond the platform-cap refusal, account settings (name change).
- Decisions the owner must make (also listed in the handback): custom SMTP for sign-in emails; Stripe Tax on or off; whether a sessionless Marketplace install should create an unclaimed row (this plan follows the spec and does); the `BRAND_MAX_ACTIVE_NUMBERS` figure after the load test.
