# `<Brand>`: self-serve WhatsApp for GoHighLevel — design

Charlie, 12 Oct 2026; **revised 16 Oct 2026 to a standalone product** (see "Revision: standalone" below); **revised 17 Oct 2026 for pricing, numbers and agency resale** after the competitor research (`docs/research/2026-10-16-competitor-gap-analysis.md`). Agreed in conversation, section by section. `<Brand>` is a placeholder until the name is picked.

## Goal

A public, paid product that anyone running GoHighLevel can find (through ads or the GHL Marketplace), sign up for, pay for, and use to send GHL's "Send SMS" steps over WhatsApp. It should all happen in about 10 minutes, without talking to Charlie.

**Success = ready for ads**, which means all of:
- GHL has approved the public Marketplace listing.
- A 2-week soft launch with 5–10 friendly agencies or coaches, with no lost messages.
- Someone who's never seen it goes from signup to first WhatsApp sent in under 10 minutes, watched by Charlie.
- Someone is covering the support channel.

## Decisions (settled)

| Topic | Decision |
|---|---|
| Customer | Anyone with GHL: **agency owners** (many sub-accounts) **and single sub-account owners** (often under a white-label like FitPro CRM). Both use the same system. |
| Price | **Per activated sub-account, monthly** (decided 17 Oct), with **3 WhatsApp numbers included** per sub-account. Volume tiers and an annual discount; the amounts are Charlie's to set (market: $29, $22 at 3+, $19 at 10+ per sub-account; extra numbers $9–10). |
| Trial | **7 days, no card** (decided 17 Oct). When the trial ends without a card, sending pauses until one is added. Trial limited to **3 active sub-accounts**. (Previously: card at signup. Every competitor checked runs a no-card trial.) |
| Numbers per sub-account | Up to 3 included (decided 17 Oct). **One default sending number per sub-account; a contact who has messaged a particular number gets replies from that number** (sticky). See roadmap item B. |
| Agency resale | **Decided 17 Oct:** at launch, agency branding that every sub-account inherits, plus auto-claiming sub-accounts added to an installed agency later. After the soft launch, a 20% recurring affiliate scheme. Custom domains later. |
| Brand | **A new brand on its own domain** (`app.<brand>.com`). Agencies never see "FitClosers". |
| Login | **Both:** a passwordless email sign-in link on `app.<brand>.com` (the main login; Supabase OTP, as the Hub uses), plus the in-GHL page per sub-account (GHL signs that user in for that one sub-account only). |
| Architecture | **Standalone** (revised 16 Oct): its own private GitHub repo, its own Vercel project, its **own Supabase project** and its **own bridge service**, in the same Railway account/project and Supabase organisation as the Hub (one login, one bill, separate instances). |
| Team members | One login per account for now. |

## Revision: standalone (16 Oct 2026)

`<Brand>` shares **no code, database or WhatsApp server** with the FitClosers Hub.

| | FitClosers Hub (untouched) | `<Brand>` |
|---|---|---|
| Code | `PortalHub` repo | New private repo |
| App | `portal.fitclosers.co.uk` | `app.<brand>.com`, its own Vercel project |
| Database | Current Supabase project | **New Supabase project**, same organisation |
| WhatsApp server | Current Railway service (keeps running Hub coach sequences) | **New Railway service**, same Railway account/project |
| Stripe / email / GHL app | FitClosers' own | New Stripe account, new Resend domain, a **new GHL Marketplace app** under the `<Brand>` name |

**Why separate instances, not just separate accounts:** the bridge stores each number's WhatsApp credentials in its database, so sharing the bridge means sharing the database. Sharing that would put customers' contacts and messages beside FitClosers' calls and deals, couple outages and migrations, and make a later split a risky live migration. Separate instances cost roughly $15–30/month more.

**Copied from PortalHub, with their tests:** `services/whatsapp-bridge/`; `src/lib/ghl.ts`, `ghl-provider.ts`, `ghl-inbound.ts`, `ghl-embed.ts`, `ghl-connect-link.ts`, `ghl-health.ts`, `whatsapp-bridge.ts`, `phone.ts`; the GHL OAuth, provider-webhook, outbound-status, inbound-poke, embed and connect-link routes; `WhatsappConnectionPanel` and the embed client.
**Simplified on the way in:** the bridge's coach-tenant paths are removed (every tenant is a GHL location). The Hub's 80+ migrations are squashed into one clean starting schema covering only the copied tables.
**Left behind:** everything else (calls, closers, deals, commissions, sequences, booking pages, Stripe Connect, the Hub roles).
**Roles:** `owner` (Charlie, platform admin) and `account` (a customer). No `client`/`closer`.

**Order of work:**
1. **Foundation:** new repo, copied code, squashed schema, own bridge deployed; every copied test passing.
2. **Reliability:** held messages and STOP opt-outs (the PortalHub plan `2026-10-12-ghl-whatsapp-self-serve-phase1.md`, rewritten for the new repo, minus Hub sequences).
3. **Product:** §1–§4 below.
4. **Move FitClosers' 11 sub-accounts across**, one at a time like the WAGHL move: install the new `<Brand>` GHL app → re-scan the QR → set the Telephony Provider to `<Brand>` → keep the old FitClosers provider installed for 7 days → remove it. FitClosers is a `comped` account.
5. **Soft launch, then ads** (§6).

**Ongoing cost:** two copies of the bridge until (if ever) the Hub's own coach WhatsApp moves onto `<Brand>`. A bridge fix lands in both.

## Prerequisite

Steps 1–2 above ship before §1–§4. Paid traffic must not land on a product that loses messages when a phone drops off.

## 1. Accounts and login

**Data (new migration):**
- `accounts`: `id`, `name`, `kind` (`'agency' | 'business'`, which only changes wording), `owner_email`, `stripe_customer_id`, `stripe_subscription_id`, `billing_status` (`'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'comped'`), `trial_ends_at`, `cancelled_at`, `created_at`. RLS on.
- `profiles`: `id` (= `auth.users.id`), `role` (`'owner' | 'account'`), `account_id uuid null references accounts`, `email`. An `account` profile belongs to exactly one account.
- `ghl_accounts.account_id uuid null references accounts`. `null` means installed from the Marketplace but not yet claimed by anyone. `ghl_accounts.activated_at timestamptz null`: non-null means a billed, active number.
- A "FitClosers" account with `billing_status = 'comped'` is created by hand at go-live. Its 11 sub-accounts arrive through the normal install as they're moved across (step 4).

**Who can see what:**
- **No RLS read policies for `account` users on any table.** `ghl_accounts` holds GHL access and refresh tokens. Every read and write goes through server code using the service role, after checking the session and ownership. RLS default-deny is the safety net: an `account` user's own Supabase client must read zero rows from every table.
- `owner` (Charlie) gets an admin area (`/admin`): an **Accounts** list (trial, active, past-due, numbers, conflicts) and the GHL health view copied from the Hub.
- The whole app is `<Brand>`. `/` is the signed-in dashboard (or the login page). The marketing landing page lives on the brand's root domain, outside this app.

**Linking GHL:**
- `/api/crm/oauth/start` accepts an `account` or `owner` session. The signed OAuth state carries the `account_id`.
- The callback (agency-level or location-level install, both already supported) stamps `account_id` on each location it creates, or on one that's still unclaimed (`null`).
- **Conflict rule:** a location already owned by a *different* account is skipped. The result shows "This sub-account is already connected to another `<Brand>` account. Contact support.", and Charlie gets a Slack alert. Fixed by hand; there's no transfer feature.
- **Marketplace-first install** (no `<Brand>` session): the callback creates the row with `account_id = null`. The in-GHL page (§4) offers "Start your 7-day free trial", which links to `/signup?claim=<signed token>`. The token is signed from the embed session and holds the `location_id`, with a 30-minute expiry. Once checkout completes, the location is claimed by the new account.

## 2. Signup and billing

**Flow:** landing page → **Start 7-day free trial** → `/signup` (account name, "agency or single business?", email; sign-in link emailed) → **Stripe Checkout** (subscription mode, `trial_period_days: 7`, `payment_method_collection: 'if_required'` so no card is asked for, `trial_settings.end_behavior.missing_payment_method: 'pause'`) → the dashboard (`/`) → **Connect GHL** → choose sub-accounts in GHL → **Activate** each one wanted → scan the QR or send a connect link → checklist: set the Telephony Provider.

**Stripe:**
- A **separate Stripe account** for `<Brand>`, with one recurring price per number per month. Stripe Tax handles UK and EU VAT.
- A new webhook route, `/api/webhooks/brand-billing`, with its own signing secret, separate from the existing Connect webhook. It handles `checkout.session.completed`, `customer.subscription.created|updated|deleted` and `invoice.payment_failed`.
- **Subscription quantity = the number of activated locations.** Activate and Deactivate update the subscription item quantity with prorations. Quantity 0 is allowed.
- Stripe status maps to `billing_status`: `trialing` → `trialing`, `paused` (trial ended with no card) → `paused`, `active` → `active`, `past_due` → `past_due` (**sending continues**, with a dashboard banner), `unpaid` → `paused`, `canceled` / `incomplete_expired` → `cancelled`. In Stripe settings, failed retries end in `unpaid` after about 7 days.
- Stripe's hosted Customer Portal handles card updates, invoices and cancelling (at the end of the period).

**Sending gate.** In `handleProviderOutboundMessage`, before any send:
- location not activated → refuse with `"WhatsApp isn't activated for this sub-account"`
- account `paused` / `cancelled` → refuse with `"<Brand> subscription inactive — the account owner needs to update billing"`
- `comped` / `trialing` / `active` / `past_due` → send.

Both refusal reasons are fixed strings, reported as failed in GHL.

**Limits:** while `trialing`, Activate refuses past **3** active sub-accounts ("Your trial includes 3 sub-accounts. Start your paid plan now to add more", with a button that adds a card and ends the trial early in Stripe). A trial that ends with no card leaves the account `paused`: the dashboard and the in-GHL page show "Your trial has ended. Add a card to keep sending.", with the Stripe Customer Portal link. A platform-wide `BRAND_MAX_ACTIVE_NUMBERS` env var makes Activate refuse beyond the server's tested capacity and adds the account to a waitlist instead.

**Cancellation cleanup:** a daily cron. **14 days** after `cancelled_at`, it logs out every bridge session for that account's locations and deletes their stored WhatsApp credentials.

## 3. Dashboard (`/`)

- **Header:** plan state ("Trial: N days left" / "Active" / a red "Payment failed — update card" banner), "N sub-accounts active · £X/month", and the main **Connect GHL** button ("Add sub-accounts" once something is linked).
- **One row per location:** name, WhatsApp state (not active / waiting for scan / connected with the number / disconnected with N waiting), sent today out of the cap, and a **Needs attention** column.
- A **"Needs attention" filter.**
- **Row actions:** Activate, Show QR, Send connect link (the existing `ghl-connect-link` mechanism), Disconnect, Deactivate.
- **Row detail:** the overview from the phase 1 plan (Task 6): held messages, failures in the last 7 days with reasons, and the opt-out count.
- **Telephony Provider nudge:** connected and activated for 24 hours or more with **no outbound webhook from GHL ever** → "No messages from GHL yet. Is the Telephony Provider set?", showing the exact steps. Also one email to the owner.
- **Alerts go to the customer:** a disconnect emails the account owner (Resend, from the brand domain), once per disconnect episode, with the number of held messages and a reconnect link. Charlie's Slack only gets platform-level alerts: bridge down, the billing webhook failing, conflicts, and capacity reaching 80%.
- **Settings:** account name, password, Billing (opens the Stripe Customer Portal).
- Works at phone width.

## 4. The in-GHL page (`/embed/crm`, per sub-account)

This is the existing embed plus the phase 1 overview card, with `<Brand>` styling. The page state follows the location:
- **Unclaimed** (`account_id = null`): "Start your 7-day free trial", linking to the signed claim link (§1). No QR.
- **Account paused or cancelled:** "Sending is paused. The account owner needs to update billing." No QR.
- **Claimed but not activated:** "WhatsApp isn't active for this sub-account. Ask your account owner to activate it."
- **Active:** connect, reconnect and status, as built today.

## 5. Branding

- One `brand` config (name, logo, colour tokens, support contacts) read from env. Every page, email and the embed use it. No FitClosers wording anywhere. Renaming the brand is a config change.
- The new GHL app's Custom Page and redirect URLs point at `app.<brand>.com`.

## 6. Launch checklist (outside the code)

1. **Name, domain, logo**, a support email and a support WhatsApp number.
2. A **separate Stripe account** and price, and Resend on the brand domain.
3. **Terms, acceptable use policy, privacy policy, and a data processing agreement** (UK GDPR, as a data processor for message content). The terms must say plainly that this uses WhatsApp's linked-device mechanism, not the official Business API, and that WhatsApp may restrict numbers.
4. **GHL Marketplace:** new app version, pricing **Free**, available to **agencies and sub-accounts**, submitted as **Public**. Submit early, because review can take weeks. Until it's approved, the app is Private and limited to 5 outside agencies, which is enough for the soft launch.
5. **Check on real accounts:** a sub-account admin under a white-label agency can install from the direct link and change the Telephony Provider. If an agency blocks app installs, the signup flow shows "ask your agency to allow `<Brand>`" instead of failing silently.
6. **Capacity:** load-test the single Railway bridge, record the number of numbers it handles safely, set `BRAND_MAX_ACTIVE_NUMBERS` below it, and alert at 80%.
7. **Ads:** start small. Use "WhatsApp for GoHighLevel" wording, never "bulk messaging", because Meta reviews WhatsApp-related ads.

## Error handling

- Every new refusal shown in GHL is a fixed string (the existing hard rule).
- If the Stripe webhook fails, Stripe retries. Handlers are idempotent on the event id (store processed ids). `billing_status` is only ever set from Stripe's own subscription object, never computed by hand.
- If the quantity update fails on Activate, the activation is rolled back and the error shown. **It must never leave a number active but unbilled.**
- If OAuth install hits a conflict, the other locations in the same install still succeed. Conflicts are listed in the result.

## Testing

- Unit (`node --test`): Stripe status → `billing_status` mapping; the sending gate for every status; the trial limit and capacity cap on Activate; the conflict rule in the callback; claim-token sign, verify and expiry; the Telephony Provider nudge condition.
- RLS: a script that signs in as an `account` user with the anon key and asserts it reads zero rows from every table.
- Manual, before ads: the full ad-click → first-message run on a spare sub-account, with Stripe in test mode, then live.

## Out of scope (later, if wanted)

Team members per account; customers without GHL; SMS fallback through the customer's own Twilio; read receipts; affiliates (planned after the soft launch, see Agency resale above); custom domains for agencies; transferring a location between accounts; holding messages for Hub sequences.

## Open items

- The name, and the price per number.
- The bridge capacity figure (from the load test).
- Whether white-label sub-account admins can install (checklist item 5).
