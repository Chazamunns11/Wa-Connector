# Accounts and billing go-live

This is the checklist for turning on sign-up, Stripe billing and the dashboard.
Do `docs/GO-LIVE-FOUNDATION.md` first (Supabase, Railway, Vercel, the GHL app).
This page adds what accounts and billing need on top.

Work top to bottom. Use Stripe **test mode** until Part 9. Nothing here needs
you to write code.

`<app>` is the public web address, no trailing slash. `<bridge>` is the Railway
bridge address. `<Brand>` is whatever `BRAND_NAME` is set to (default PingWren).

---

## Rule zero: never paste a secret into chat

Keys go from the provider's screen straight into Vercel or Railway. Never into
a Claude chat, a ticket or a doc. If one appears anywhere else, treat it as
burned and roll it. Everything in this deployment is new. Do not reuse any
FitClosers key, secret or webhook.

The examples below show the shape of a value only. They are not real.

---

## Part 1 — Supabase

There is no PingWren Supabase project yet. The organisation holds Tendari,
SyncMe, CashMaker and FitLink Payments. Make PingWren a new project **in the
same organisation**.

1. Create the project as in Part 1 of the foundation doc. Note the three
   values (URL, anon key, service-role key).
2. **SQL Editor.** Run `supabase/migrations/0001_init.sql` once. Then run
   `supabase/migrations/0002_accounts.sql` once. Then run
   `supabase/migrations/0003_activation_cap.sql` once. Always in that order.
   Without 0003 every Activate button fails, because activation calls the
   `activate_ghl_location` function that 0003 creates.
3. Before 0002, if you ever ran 0001 on a project that already has people in
   `profiles`, check for emails that differ only by case. 0002 lower-cases
   every email and then adds a unique index. Two rows like `Sam@x.com` and
   `sam@x.com` would make it fail. On a brand-new project this is empty, but
   run it anyway:

   ```sql
   select lower(trim(email)) as email, count(*)
   from profiles
   group by 1
   having count(*) > 1;
   ```

   Zero rows means go ahead. Any rows: delete or merge the duplicates first.
4. **Authentication → URL Configuration.**
   - Site URL: `<app>`
   - Redirect URLs: `<app>/auth/callback`
   - Add `http://localhost:3000/auth/callback` only if you run it locally.
5. **Authentication → Providers → Email.** Keep email on. Sign-in is an
   emailed link (magic link). People are never created by the login form, only
   by sign-up and checkout (`shouldCreateUser: false`).
6. **Custom SMTP, before any real sign-up.** Supabase's built-in sender is
   rate-limited to a handful of emails an hour and is not for production. Set
   up Resend on the brand domain, then **Project Settings → Authentication →
   SMTP Settings** and enter Resend's host, port, username and API key. Send
   yourself a test link. Without this, new customers will not get their
   sign-in link and will think the product is broken.
7. **Insert the FitClosers account by hand.** It never touches Stripe.

   ```sql
   insert into accounts (name, kind, owner_email, billing_status)
   values ('FitClosers', 'agency', 'you@example.com', 'comped');
   ```

   Then **Authentication → Users → Add user** (tick Auto Confirm) for that
   email, and link them:

   ```sql
   insert into profiles (id, role, email, account_id)
   select u.id, 'account', lower(u.email), a.id
   from auth.users u, accounts a
   where lower(u.email) = 'you@example.com' and a.name = 'FitClosers';
   ```

   Your owner login from the foundation doc keeps `role = 'owner'`. If you
   want one email for both, use a second address for the account user.
8. **Run the RLS check** (Part 8).

---

## Part 2 — Stripe, test mode first

1. Open a Stripe account for PingWren. Leave **Test mode** on (switch at top
   right). Do everything in this part in test mode.
2. **Product catalogue → Add product.** Name: `PingWren WhatsApp number`.
3. Add **one** price on that product. Not two. The code reads a single price id
   and sets the quantity to the number of activated numbers.
   - Recurring, monthly, currency GBP.
   - Pricing model: **Volume pricing** (`tiers_mode = volume`,
     `billing_scheme = tiered`).
   - Tier 1: first unit 1, last unit 9, **£14.99** per unit (1499 pence).
   - Tier 2: first unit 10, last unit and above, **£7.99** per unit (799 pence).
   - No flat fee on either tier.

   That matches `stripeVolumeTiers()` in `src/lib/stripe/billing.ts`. Volume
   means the whole order gets the tier price. Ten numbers cost 10 x £7.99, not
   nine at £14.99 plus one at £7.99. If the prices in `src/lib/pricing.ts`
   ever change, the Stripe price must change with them.
4. Copy the price id (starts `price_`). It becomes `STRIPE_PRICE_ID`.
5. **Developers → API keys.** Copy the secret key (starts `sk_test_`). It
   becomes `STRIPE_SECRET_KEY`. Do not use the publishable key. The app never
   uses it.
6. **Settings → Billing → Customer portal.** Turn on:
   - Update payment method
   - View invoice history
   - Cancel subscription, set to **cancel at end of billing period**

   Leave "update quantity" and plan switching off. Quantity follows the
   activated numbers, not what the customer types. Set the portal's return
   link to `<app>/dashboard/billing`.
7. **Settings → Billing → Subscriptions and emails → Manage failed payments.**
   Use smart retries and set the last step to mark the subscription
   **unpaid** after about 7 days. The app turns `past_due` into the "payment
   failed" banner (sending keeps working), and `unpaid` into paused.
8. **Developers → Webhooks → Add endpoint.**
   - URL: `<app>/api/webhooks/billing`
   - Events, exactly these five (the handler ignores anything else):
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_failed`
   - Copy the **signing secret** (starts `whsec_`). It becomes
     `STRIPE_WEBHOOK_SECRET`. Test mode and live mode have different ones.
9. **Stripe Tax decision.** Pick one before launch:
   - Off: Stripe adds no tax. Leave `STRIPE_AUTOMATIC_TAX` unset. Fine if you
     are under the VAT threshold and take advice.
   - On: turn on Stripe Tax, add your registration and set a head-office
     address, then set `STRIPE_AUTOMATIC_TAX=true`. Checkout then collects the
     address it needs. Prices are then treated as tax-exclusive unless you set
     the price to tax-inclusive in Stripe. Check what the checkout page shows.

   Ask your accountant. This is not something the app can decide.

---

## Part 3 — Vercel environment

Add these in Vercel (Production), then redeploy. The full list for the whole
web app is in the table in Part 10.

| Variable | Required | Example shape | Used in |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes | `sk_test_...` | `src/lib/stripe/client.ts` |
| `STRIPE_PRICE_ID` | Yes | `price_...` | `src/lib/stripe/client.ts` |
| `STRIPE_WEBHOOK_SECRET` | Yes | `whsec_...` | `src/app/api/webhooks/billing/route.ts`, `client.ts` |
| `STRIPE_AUTOMATIC_TAX` | No | `true` (only the exact word `true` turns it on) | `src/lib/stripe/client.ts` |
| `BRAND_MAX_ACTIVE_NUMBERS` | No | `40` (a whole number above zero) | `src/lib/billing/activation.ts` |

What happens if they are missing:

- No `STRIPE_SECRET_KEY` or `STRIPE_PRICE_ID`: Stripe counts as not
  configured. Sign-up and the billing page will not work.
- No `STRIPE_WEBHOOK_SECRET`: the webhook answers 503 to everything. Stripe
  retries, but accounts never update.
- `BRAND_MAX_ACTIVE_NUMBERS` unset or not a plain whole number: no
  platform-wide cap.

`ONBOARD_STATE_SECRET` now also signs the claim links that tie a GHL install to
an account. It must already be set (foundation doc, Part 3). Do not change it
after launch, or unused claim links stop working.

---

## Part 4 — GoHighLevel app settings

The foundation doc, Part 4, has the full walkthrough. For accounts, check these
four things in the Marketplace app (**BUILD → Advanced Settings**):

1. **Redirect URL:** `<app>/api/crm/oauth/callback`. Click **+ Add**, then
   Save, then reload to check it stuck. Use a wide window. The Save button can
   sit off screen and fail silently.
2. **Webhook / conversation provider:** the Delivery URL is
   `<app>/api/webhooks/crm-provider`, and `GHL_WEBHOOK_PUBLIC_KEY` is set. No
   URL you give GHL may contain the letters "ghl".
3. **Custom page:** URL `<app>/embed/crm`, left navigation, sub-accounts, no
   template variables in the URL.
4. **SSO shared secret:** Auth → Shared Secret → Generate, paste into
   `GHL_SSO_SHARED_SECRET`. Needs `ONBOARD_STATE_SECRET` too. Re-publish the
   app after adding the module.

After this, an install from the Marketplace creates a location row. A customer
then claims it from the dashboard (sign-up with a claim link, or **Connect
GoHighLevel** on the dashboard).

---

## Part 5 — Railway bridge

The bridge itself is set up in Part 2 of the foundation doc. Accounts add two
things to check:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` point at the **new PingWren
  project**, not an old one. The 14-day cleanup logs numbers out through the
  bridge, so the web app and the bridge must share the same database.
- `WA_BRIDGE_SECRET` on Railway equals `WHATSAPP_BRIDGE_SECRET` on Vercel, and
  `WHATSAPP_BRIDGE_URL` on Vercel is `<bridge>`. Activate, deactivate, QR,
  connect link and the cleanup all go through that one link.

Bridge variables are listed in the foundation doc. Nothing new was added for
accounts.

---

## Part 6 — First light (test mode)

Use a spare GHL sub-account and your own number. Use Stripe test cards.

1. Go to `<app>/signup`. Sign up with a real inbox you can read. Pay with
   `4242 4242 4242 4242`, any future date, any CVC.
2. You should land on a "check your email" page. Open the sign-in link
   (it comes from the SMTP you set up). You should land on the dashboard.
3. In Stripe (test mode) the customer should show a subscription that is
   **trialing**. The dashboard should say you are on a trial.
4. **Connect GoHighLevel** and approve the spare sub-account. The location
   should appear on the dashboard.
5. **Activate** one number, scan the QR, then send a workflow SMS. It should
   reach WhatsApp.
6. In Stripe, the subscription item quantity should now be **1**.
7. **Deactivate** the number. Quantity goes to **0**. (See Part 7 for why this
   needs checking.) If the dashboard says "Deactivated. Your bill will update
   shortly.", the number is off and has stopped sending, but the call to
   Stripe to lower the quantity failed. Slack gets "Billing quantity sync
   failed for account ...". Nothing else to do: the next subscription update
   from Stripe, or the next activation, puts the quantity right. Check the
   subscription item in Stripe if the Slack note keeps repeating.
8. Activate up to the trial cap (three numbers). A fourth should be refused
   with the cap message.
9. Open **Billing** on the dashboard. **Manage billing** should open the
   Stripe Customer Portal. **End trial early** should move the account to
   active.

---

## Part 7 — Prove the whole life of an account, with test clocks

Do this once, in test mode, before any real customer. A test clock lets Stripe
fast-forward time. The trial in code is **7 days**.

**First, one open question.** When every number is deactivated, the app sets
the subscription item quantity to **0**. We have not confirmed that Stripe
accepts quantity 0 on your account and price. In step 7 above, check that the
update did not fail and that Slack has no "Billing quantity sync failed"
message. If Stripe refuses, stop and tell the developer. The fix is small, but
better found now than with a paying customer.

Then walk this journey:

1. **Stripe → Billing → Test clocks → New simulation.** Create a customer on
   a clock. Easiest route: start a new sign-up (Part 6) with a fresh email,
   then in the Stripe dashboard attach that customer to a test clock. If the
   dashboard will not let you attach an existing customer, create the
   customer and subscription from the dashboard on a clock, and use the
   Stripe CLI or dashboard to replay the events at the webhook.
2. **Signup and trial.** Status trialing. Trial end date visible on the
   billing page.
3. **Activation.** Advance the clock past day 7. The first invoice is paid
   with the test card. Status becomes **active**. Charge should be 1 x
   £14.99 (plus tax if on).
4. **Volume tier.** Activate ten numbers (use the comped FitClosers account's
   locations, or a test account). Charge for the month should be 10 x £7.99.
5. **Payment failed.** Replace the card with `4000 0000 0000 0341` (it
   attaches, then declines). Advance one billing cycle. Status becomes
   **past_due**, the dashboard shows the payment-failed banner, Slack gets the
   "Stripe payment failed" note, and **sending keeps working** while Stripe
   retries. Advance until the retries run out. Status becomes **paused** and
   sending stops.
6. **Cancel.** In the Customer Portal, cancel. The billing page should say
   "Cancels at the end of this period". Advance past the period end. Status
   becomes **cancelled**.
7. **14-day cleanup.** Advance the clock a further 14 days. The hourly cron
   job (`/api/cron/drain`) logs each of the account's numbers out of the
   bridge, which deletes the stored WhatsApp session, and clears activation.
   Check the Vercel log line `cancelled cleanup: 1 account(s)...` with
   `0 failure(s)`. Stripe's clock moves Stripe time, not your server's. To
   test cleanup properly, move the account's `cancelled_at` back in the
   database instead (`update accounts set cancelled_at = now() - interval
   '15 days' where ...`) and run the cron by hand.
8. **Resubscribe.** Sign in to the cancelled account and open **Billing**.
   Click **Restart your subscription** and complete Checkout with a test
   card. The account gets the new subscription, returns to trialing or
   active, and its cancelled and cleanup markers clear. (Signing up again
   with the same email does not work; it says the email already exists.)

Tick each step off. A failure at any step is a launch blocker.

---

## Part 8 — RLS check

The tables hold no policies on purpose, so a signed-in customer must see
nothing when they talk to the database directly. This script proves it.

Use a throwaway account user (sign up once with a spare email). From the repo
root, with the values for the **new** project:

```bash
SUPABASE_URL=<project url> \
SUPABASE_ANON_KEY=<anon key> \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
RLS_CHECK_EMAIL=spare@example.com \
node scripts/rls-check.mjs
```

Expect PASS and exit code 0. Anything else is a launch blocker. The script
prints no secrets, but your terminal history will hold the keys, so clear it
afterwards. It is run by hand and is not part of `npm test`.

---

## Part 9 — Going live with real money

Only after Parts 1 to 8 pass in test mode.

1. In Stripe, switch to **live mode** and repeat Part 2 steps 2 to 9: product,
   the same volume price, portal settings, retry settings, webhook endpoint.
   Live mode has its own price id, key and signing secret.
2. In Vercel, replace `STRIPE_SECRET_KEY` (`sk_live_...`), `STRIPE_PRICE_ID`
   and `STRIPE_WEBHOOK_SECRET` with the live values. Redeploy.
3. Re-run Part 6 with a real card, then refund it and cancel.
4. Confirm the go-live gates at the end of the foundation doc (held messages,
   STOP opt-outs, legal text).
5. Set `BRAND_MAX_ACTIVE_NUMBERS` only after the load test (see below).

---

## Part 10 — Every environment variable

Found with `grep -rn "process.env" src services`. "Web" is Vercel. "Bridge" is
Railway. Never put a real value in this file.

### Web app (Vercel)

| Variable | Required | Example shape | Where it is used |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | Yes (also for `next build`) | `https://app.example.com` | `src/lib/brand-config.ts` |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | `https://abcd.supabase.co` | sign-up, login, callback, proxy, `src/lib/auth.ts`, `src/lib/brand.ts`, `src/lib/data/supabase.ts` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | long `eyJ...` token | sign-up, login, callback, proxy, `src/lib/auth.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | long `eyJ...` token | sign-up, `src/lib/auth.ts`, `src/lib/data/supabase.ts` |
| `STRIPE_SECRET_KEY` | Yes | `sk_test_...` | `src/lib/stripe/client.ts` |
| `STRIPE_PRICE_ID` | Yes | `price_...` | `src/lib/stripe/client.ts` |
| `STRIPE_WEBHOOK_SECRET` | Yes | `whsec_...` | billing webhook route |
| `STRIPE_AUTOMATIC_TAX` | No | `true` | `src/lib/stripe/client.ts` |
| `BRAND_MAX_ACTIVE_NUMBERS` | No | `40` | `src/lib/billing/activation.ts` |
| `ONBOARD_STATE_SECRET` | Yes | 64 hex characters | `ghl-claim.ts`, `ghl-connect-link.ts`, `ghl-embed.ts` |
| `CRON_SECRET` | Yes | 64 hex characters | `/api/cron/drain`, `signed-state.ts` |
| `WHATSAPP_BRIDGE_URL` | Yes | `https://bridge.example.com` | `src/lib/whatsapp-bridge.ts` |
| `WHATSAPP_BRIDGE_SECRET` | Yes | 64 hex characters | `src/lib/whatsapp-bridge.ts` |
| `WHATSAPP_INBOUND_POKE_SECRET` | Yes for instant replies | 64 hex characters | `whatsapp-replies` and `crm-outbound-status` routes |
| `GHL_CLIENT_ID` | Yes | from the GHL app | `src/lib/ghl.ts` |
| `GHL_CLIENT_SECRET` | Yes | from the GHL app | `src/lib/ghl.ts` |
| `GHL_WEBHOOK_PUBLIC_KEY` | Yes | PEM block | `src/lib/ghl.ts` |
| `GHL_CONVERSATION_PROVIDER_ID` | Yes | from the GHL provider | `src/lib/ghl.ts` |
| `GHL_SSO_SHARED_SECRET` | Yes for the custom page | from GHL | `src/lib/ghl-embed.ts` |
| `GHL_EMBED_FRAME_ANCESTORS` | No | `https://app.agency.com` | `next.config.ts` |
| `SLACK_WEBHOOK_URL` | No, but wanted | `https://hooks.slack.com/...` | `src/lib/slack.ts` |
| `BRAND_NAME` | No | `PingWren` | `src/lib/brand-config.ts` |
| `BRAND_TAGLINE` | No | short phrase | `src/lib/brand-config.ts` |
| `BRAND_ACCENT` | No | `#FF6B5B` | `src/lib/brand-config.ts` |
| `BRAND_LOGO_PATH` | No | `/logo.svg` | `src/lib/brand-config.ts` |
| `BRAND_LOGO_REVERSE_PATH` | No | `/logo-light.svg` | `src/lib/brand-config.ts` |
| `BRAND_SUPPORT_EMAIL` | No | `help@example.com` | `src/lib/brand-config.ts` |
| `BRAND_SUPPORT_WHATSAPP` | No | `+447700900000` | `src/lib/brand-config.ts` |
| `WA_MEDIA_BUCKET` | No | `wa-media` | `src/lib/data/supabase.ts` |
| `WA_MEDIA_OUTBOUND_ENABLED` | No | `false` | `src/lib/ghl.ts` |
| `WA_MEDIA_SIGNED_URL_TTL_DAYS` | No | `90` | `src/lib/data/supabase.ts` |

`NODE_ENV` is set by Vercel. `BRAND_PRICE_PER_NUMBER` and `BRAND_CURRENCY` no
longer exist. Prices live in `src/lib/pricing.ts`.

### Bridge (Railway)

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WA_CREDS_KEY` (32 bytes,
base64), `WA_BRIDGE_SECRET` (hex). Optional with defaults: `PORT`, `LOG_LEVEL`,
`PORTAL_INBOUND_URL`, `PORTAL_OUTBOUND_URL`, `WA_INBOUND_POKE_SECRET`,
`WA_CREDS_KEY_PREVIOUS`, `WA_MEDIA_BUCKET`, the `WA_MEDIA_*` switches and the
pacing settings. The full table with defaults is in
`docs/GO-LIVE-FOUNDATION.md`, and the source is
`services/whatsapp-bridge/src/config.ts`.

### Script only

`scripts/rls-check.mjs` reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and `RLS_CHECK_EMAIL`. Set them on the command
line for that one run. Do not add them to Vercel.

---

## Known limitations. Read before launch.

- **Sign-up with an unverified email can squat an address.** Someone can sign
  up with an email they do not own. That address is then taken, and the real
  owner is told it already exists. Tighten this before launch, for example by
  requiring the emailed link before the account is created, or by letting the
  real owner take over an unverified account. Until then, watch the accounts
  list in `/admin` for strange sign-ups.
- **`BRAND_MAX_ACTIVE_NUMBERS` has no tested figure.** Leave it unset until you
  have load-tested one bridge on Railway with many numbers connected at once.
  Then set it a little below what held up. At the cap, new activations are
  refused.
- **Marketplace installs with no signed-in session create unclaimed rows.**
  If someone installs from the GHL Marketplace without being signed in, the
  location is saved with no owner. It sits in `/admin` until its real owner
  claims it from the dashboard. Nothing sends for it until an account owns it
  and is in good standing. Check for unclaimed rows now and then.
- **Quantity 0 is unconfirmed** until you do the check in Part 7.
- **Cleanup runs hourly, not exactly at day 14.** It can land up to an hour
  after the 14-day mark. If the bridge is down it retries on the next run.
