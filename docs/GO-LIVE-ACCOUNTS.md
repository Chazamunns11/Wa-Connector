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
   `supabase/migrations/0003_activation_cap.sql` once. Then run
   `supabase/migrations/0004_reliability.sql` once. Always in that order.
   Without 0003 every Activate button fails, because activation calls the
   `activate_ghl_location` function that 0003 creates. Without 0004 held
   messages and STOP opt-outs fail.
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
   emailed link (magic link). The login form never creates people
   (`shouldCreateUser: false`). The sign-up form does (`shouldCreateUser:
   true`), but the account and profile are only made after the emailed link is
   opened, so nobody can sign up with an address they cannot read. Keep
   **Confirm email** on. In **Authentication → Email Templates**,
   new people get Supabase's "Confirm signup" template and returning people
   get "Magic Link". Customise both, and keep the wording neutral, for example
   "Follow this link to continue:", rather than "Sign in". Part 6 checks which
   one arrives.
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
   Do **not** add any prices to it by hand. Billing is per WhatsApp number:
   the app creates one subscription per number and prices it inline
   (`price_data`) at the account's current tier from `src/lib/pricing.ts`
   (1 to 10 numbers £9.99, 11 to 24 £7.99, 25 or more £5.99, per number per
   month, the tier applying to every number). Stripe makes the inline prices
   itself. If the pence in `src/lib/pricing.ts` ever change, nothing in Stripe
   needs changing; numbers move to the new price at their next invoice the
   next time their account is re-priced.
3. (No step: there is no Price object to create.)
4. Copy the product id (starts `prod_`). It becomes `STRIPE_PRODUCT_ID`.
5. **Developers → API keys.** Copy the secret key (starts `sk_test_`). It
   becomes `STRIPE_SECRET_KEY`. Do not use the publishable key. The app never
   uses it.
6. **Settings → Billing → Customer portal.** Turn on:
   - Update payment method
   - View invoice history

   Sign-up saves a card with a Stripe Checkout in setup mode (no charge), and
   "Add a card" on the billing page does the same; the webhook makes it the
   customer's default and resumes any number that paused because its trial
   ended with no usable card. (Adding a card in the portal does not resume a
   paused subscription.)
   - Cancel subscription, set to **cancel at end of billing period**. The
     portal lists one subscription per number. Removing a number or
     deactivating a sub-account in the app cancels at once instead.

   Leave "update quantity" and plan switching off. The app owns each number's
   price. Set the portal's return link to `<app>/dashboard/billing`.
7. **Settings → Billing → Subscriptions and emails → Manage failed payments.**
   Use smart retries and set the last step to mark the subscription
   **unpaid** after about 7 days. The app turns `past_due` into the "payment
   failed" banner (sending keeps working), and `unpaid` into paused.
8. **Developers → Webhooks → Add endpoint.**
   - URL: `<app>/api/webhooks/billing`
   - Events, exactly these seven (the handler ignores anything else):
     - `checkout.session.completed` (saving a card, at sign-up or "Add a card")
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `customer.subscription.paused` (a number's trial ended with no usable card)
     - `customer.subscription.resumed` (a card was added after that)

     Each number's subscription carries `account_id`, `location_id` and
     `tenant_id` metadata; the handler maps events to the number by
     `tenant_id`.
     - `invoice.payment_failed`

     `customer.subscription.trial_will_end` is not needed: there is no
     trial-ending email yet (the app has no email sending of its own). The
     card is saved before any number's trial starts.
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
| `STRIPE_PRODUCT_ID` | Yes | `prod_...` | `src/lib/stripe/client.ts` |
| `STRIPE_WEBHOOK_SECRET` | Yes | `whsec_...` | `src/app/api/webhooks/billing/route.ts`, `client.ts` |
| `STRIPE_AUTOMATIC_TAX` | No | `true` (only the exact word `true` turns it on) | `src/lib/stripe/client.ts` |
| `BRAND_MAX_ACTIVE_NUMBERS` | No | `40` (a whole number above zero) | `src/lib/billing/activation.ts` |

What happens if they are missing:

- No `STRIPE_SECRET_KEY` or `STRIPE_PRODUCT_ID`: Stripe counts as not
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

1. Go to `<app>/signup`. Fill in the form with a real inbox you can read.
   You should see "Check your email to continue". Nothing exists yet: no
   account in `/admin`, no row in `profiles`.
2. Open the emailed link in the same browser (it comes from the SMTP you set
   up). Check which template it used: a new address gets "Confirm signup",
   a returning one "Magic Link", and both should be customised. It confirms the address, creates the account and sends you straight to
   Stripe Checkout. Checkout asks for a card and **charges nothing** (it is
   in setup mode). Save `4242 4242 4242 4242`.
   You then land on "You're nearly there" ("Card saved. Nothing has been
   charged"); the button takes you to the dashboard. Try the form again with
   the same address: it should say you already have an account and point you
   to log in.
3. In Stripe (test mode) the customer should exist with that card as its
   default and **no subscription**. The account's `billing_status` is
   `active` (card on file).
4. **Connect GoHighLevel** and approve the spare sub-account. The location
   should appear on the dashboard.
5. **Activate** it, scan the QR, then send a workflow SMS. It should reach
   WhatsApp. In Stripe the customer now has **one subscription per number** of
   that sub-account, each **trialing** for 7 days at £9.99, with metadata
   `account_id`, `location_id`, `tenant_id`.
6. **Add a number** on the PingWren page (or the dashboard). A second
   trialing subscription appears for it. **Remove** it: that subscription is
   cancelled straight away.
7. **Deactivate** the sub-account. Its numbers' subscriptions are cancelled
   at once (any unused paid time goes to the customer's credit balance). If
   the dashboard says "Deactivated. Your bill will update shortly.", sending
   has stopped but a Stripe cancel failed; Slack names the subscription.
   Cancel it by hand in Stripe if it is still live.
8. **Activate** again. The numbers had subscriptions before, so they restart
   with **no trial** and are charged at once.
9. Open **Billing** on the dashboard. It shows the card, the billed numbers,
   the monthly total and how many are still in trial. **Manage billing**
   opens the Stripe Customer Portal.

An account that abandoned the card Checkout shows "No card yet" with a **Save
a card** button, and Activate is refused until it has one.

---

## Part 7 — Prove the whole life of an account, with test clocks

Do this once, in test mode, before any real customer. A test clock lets Stripe
fast-forward time. Each number's trial is **7 days**.

1. **Stripe → Billing → Test clocks → New simulation.** Start a new sign-up
   (Part 6) with a fresh email, save a card, then attach that customer to a
   test clock in the Stripe dashboard before activating anything.
2. **Number trial, then the first charge.** Activate one sub-account. Its
   number is trialing; nothing is charged. Advance past day 7. That number's
   first invoice (1 x £9.99, plus tax if on) is charged to the saved card, the
   subscription is **active**, and it renews monthly on that day. The webhook
   writes `active` on the number's row.
3. **A second number has its own dates.** Advance 3 days and add a second
   number. Its trial ends 7 days after it was added, and it is charged
   separately on that day, as its own invoice.
4. **Trial ends with no usable card.** On a second customer, save a card,
   activate a number, then remove the card in the portal. Advance past the
   number's trial. That subscription is **Paused** and nothing was charged;
   the number's `billing_status` is `paused`. A workflow SMS from it fails in
   GoHighLevel with "PingWren subscription inactive — the account owner needs
   to update billing". The dashboard shows "Billing stopped" with **Add a
   card**. Save a card: the webhook gets `checkout.session.completed` (setup
   mode), resumes the number (charging it now) and it sends again.
5. **Volume tiers.** Add numbers until the account has eleven billed. Every
   number's subscription moves to £7.99 with no proration (check the
   subscription item price, and that no proration line appears). Their next
   invoices are 1 x £7.99 each. At 25 they all move to £5.99. Remove numbers
   to go back under 25 and under 11: they move back up.
6. **Payment failed.** Replace the card with `4000 0000 0000 0341` (it
   attaches, then declines). Advance to a number's renewal. That number is
   **past_due**, the dashboard shows the payment-failed banner, Slack gets the
   "Stripe payment failed" note, and **that number keeps sending** while Stripe
   retries. When the retries run out it is **paused** (Stripe `unpaid`) and
   stops sending; pay the invoice in the portal.
7. **Cancel in the portal.** Cancel one number's subscription in the Customer
   Portal. At the period end it becomes **cancelled** on that number's row and
   the number stops sending. The rest of the account is untouched.

Tick each step off. A failure at any step is a launch blocker.

Not covered by per-number billing yet: the 14-day credential cleanup still
runs only for an account whose own `cancelled_at` is set, which per-number
billing never sets. A number cancelled by Stripe keeps its stored WhatsApp
session until its sub-account is deactivated or the number is removed.

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
   portal settings, retry settings, webhook endpoint. Live mode has its own
   product id, key and signing secret.
2. In Vercel, replace `STRIPE_SECRET_KEY` (`sk_live_...`), `STRIPE_PRODUCT_ID`
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
| `STRIPE_PRODUCT_ID` | Yes | `prod_...` | `src/lib/stripe/client.ts` |
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
| `OUTBOUND_HOLD_MAX_HOURS` | No | `24` (1 to 168) | `src/lib/ghl-held-rules.ts` |
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

- **Held messages and STOP have limits.** A message already in the bridge's
  paced queue when a STOP lands still sends. The GoHighLevel do-not-disturb endpoint is not
  live-verified (it is off unless `GHL_SYNC_DND` is `true`). Held messages
  older than `OUTBOUND_HOLD_MAX_HOURS` (default 24) are reported to
  GoHighLevel as not sent.
- **`BRAND_MAX_ACTIVE_NUMBERS` has no tested figure.** Leave it unset until you
  have load-tested one bridge on Railway with many numbers connected at once.
  Then set it a little below what held up. At the cap, new activations are
  refused.
- **Marketplace installs with no signed-in session create unclaimed rows.**
  If someone installs from the GHL Marketplace without being signed in, the
  location is saved with no owner. It sits in `/admin` until its real owner
  claims it from the dashboard. Nothing sends for it until an account owns it
  and is in good standing. Check for unclaimed rows now and then.
- **Per-number trials can be farmed.** Removing a number and adding it again
  makes a new number with a new 7-day trial. Deactivating and re-activating a
  sub-account does not (those numbers restart with no trial).
- **Automatic tax needs a customer address.** With `STRIPE_AUTOMATIC_TAX=true`
  a number's subscription cannot be created until the customer has an
  address in Stripe (see Part 2 step 9).
- **Cleanup runs hourly, not exactly at day 14.** It can land up to an hour
  after the 14-day mark. If the bridge is down it retries on the next run.
