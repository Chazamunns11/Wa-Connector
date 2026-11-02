# WA Connector

A standalone WhatsApp provider for GoHighLevel (GHL). The product name shown to
users comes from `BRAND_NAME` (default "WA Connector").

## Run it

```bash
npm install
npm run dev     # http://localhost:3000
npm run check   # typecheck + lint + tests
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server only) |
| `NEXT_PUBLIC_APP_URL` | Public base URL of this app (required in production; defaults to `http://localhost:3000` in dev) |
| `BRAND_NAME` | Product name shown to users (default `PingWren`) |
| `BRAND_SUPPORT_EMAIL` | Optional support address shown to users |
| `GHL_REQUEST_AGENCY_SCOPES` | `true` asks HighLevel for `oauth.readonly` and `oauth.write`, which agency installs need. Tick both in the developer portal first, or every install breaks. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend credentials for outage emails. Unset: alerts go to Slack only. |
| `ALERT_EMAIL_TO` | Operator alert inbox, comma-separated (default `charlie@pingwren.co.uk`) |

### Environment variables — website

| Variable | Purpose |
| --- | --- |
| `BRAND_TAGLINE` | Short descriptor next to the name (default `WhatsApp for GoHighLevel`) |
| `BRAND_SUPPORT_WHATSAPP` | Optional support WhatsApp number in E.164 format |
| `BRAND_LOGO_PATH` | Optional logo: a `/public` path or absolute URL (unset = the PingWren kit logo) |
| `BRAND_ACCENT` | Optional accent colour as hex, e.g. `#FF5A36` (unset or invalid = default PingWren Coral `#FF5A36`) |

The complete list, with required/optional and defaults for both the web app
and the WhatsApp bridge, is in [`docs/GO-LIVE-FOUNDATION.md`](docs/GO-LIVE-FOUNDATION.md),
which is also the deploy and first-light guide. The bridge (`services/whatsapp-bridge`)
runs on Node 24, and its tests must be run on Node 24.

## Building without real secrets

`npx next build` needs the three public variables to exist, even for a local
check. Placeholders are fine. They are not used to reach anything.

```bash
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key \
NEXT_PUBLIC_APP_URL=http://localhost:3000 \
npx next build
```

Google Fonts warnings on an offline machine do not fail the build.

## Public status page

`/status` needs no login. It shows one state per service, "WhatsApp sending"
(the bridge's `/health`) and "GoHighLevel sync" (whether delivery updates are
stuck for over an hour), and never names a customer or shows counts. Its two
reads are cached for 60 seconds. Link to it from the marketing site and
support replies. The logic is in `src/lib/public-status.ts`.

## Live address: hub.pingwren.co.uk

The agency app (sign-up, login, dashboard, billing) lives at
`https://hub.pingwren.co.uk`. The marketing site stays on Netlify at
`pingwren.co.uk`. No code holds the address; it all comes from
`NEXT_PUBLIC_APP_URL`. To move it:

1. **Vercel** (the PingWren project) > Settings > Domains: add
   `hub.pingwren.co.uk`. Vercel shows the CNAME target it wants.
2. **GoDaddy** (DNS for pingwren.co.uk) > DNS: add a CNAME, name `hub`, value
   the target Vercel showed. Wait until Vercel says the domain is valid.
3. **Vercel** > Environment Variables: `NEXT_PUBLIC_APP_URL=https://hub.pingwren.co.uk`,
   then redeploy (it is read at build time).
4. **HighLevel developer portal** (PingWren app):
   - Advanced Settings > Auth > Redirect URL: add `https://hub.pingwren.co.uk/api/crm/oauth/callback`
   - Conversation Providers > Delivery URL: `https://hub.pingwren.co.uk/api/webhooks/crm-provider`
   - Custom Page URL: `https://hub.pingwren.co.uk/embed/crm`
5. **Supabase** (Wa-Connector project) > Authentication > URL Configuration:
   Site URL `https://hub.pingwren.co.uk`, and add `https://hub.pingwren.co.uk/auth/callback`.
6. **Railway** (PingWren bridge): `PORTAL_INBOUND_URL=https://hub.pingwren.co.uk/api/webhooks/whatsapp-replies`
   and `PORTAL_OUTBOUND_URL=https://hub.pingwren.co.uk/api/webhooks/crm-outbound-status`.
7. **Stripe** > Webhooks: point the endpoint at `https://hub.pingwren.co.uk/api/webhooks/billing`.
8. On `pingwren.co.uk`, point the "Log in" / "Start free trial" buttons at
   `https://hub.pingwren.co.uk/login` and `/signup`.

Keep `pingwren.vercel.app` working until all of the above is done. Connect
links already sent out keep the old address and still work while it does.

The app may be framed by `app.pingwren.co.uk` and any `*.pingwren.co.uk`
(the PingWren-branded HighLevel), as well as HighLevel's own domains.

## Install for a new client sub-account

> **Live PortalHub clients share this agency.** In the agency install chooser,
> tick only the sub-accounts that are moving to PingWren. Never "approve all",
> and never set PingWren as the SMS provider on a sub-account PortalHub still
> serves, or link a number that is already linked to PortalHub: that sub-account
> would get every inbound message twice, or stop sending through PortalHub.

1. **Install the app.** Either from the agency (Marketplace, agency view, pick
   the sub-accounts) or on the one sub-account. An agency install needs
   `oauth.readonly` and `oauth.write` ticked in the developer portal and
   `GHL_REQUEST_AGENCY_SCOPES=true`. If an agency install fails, `/admin` now
   shows HighLevel's own reason under the banner ("HighLevel said: ...").
2. **New sub-accounts after an agency install.** HighLevel can add the app to
   new sub-accounts automatically, but PingWren is not told (the INSTALL
   webhook is not handled yet), so their messages are ignored. Run the agency
   install again from `/admin` ("Install to a GHL location", choose the
   agency). Existing sub-accounts keep their names and numbers.
3. **Put it on an account.** The coach signs up (or follows the claim link),
   and the sub-account is activated from `/dashboard`.
4. **Set the SMS provider.** In the sub-account: Settings > Phone Numbers >
   Advanced Settings > SMS Provider > PingWren. Until this is set, nothing sends.
5. **Link WhatsApp.** Open the PingWren page in the sub-account's left menu and
   scan the QR code from the phone (WhatsApp > Linked devices).
6. **Test.** Make a contact with your own mobile number (a different phone from
   the one you linked), send it an SMS from Conversations, and check it arrives
   on WhatsApp within a minute or two (sends are paced). Reply, and check the
   reply lands in the same conversation.

## Setter seats

Add the setter as a normal HighLevel user on the sub-account. Nothing in
PingWren is per user: every user's replies in Conversations go out on the
coach's WhatsApp, and inbound replies land in the contact's conversation
whoever sent the last message.

If the setter has their own number (see the next section), they open the
PingWren page while logged in as themselves and click **Send my replies from
this number** on that number. From then on, messages they send go out from
that number. Order of choice for every outbound message:

1. the sending user's own number, if they picked one;
2. the number the contact last messaged (sticky);
3. the default number.

Workflows, bulk actions and the AI bot send without a user, so they follow
2 and 3. Removing a number clears any user who had picked it.

The PingWren page does not check the HighLevel role, so anyone who can open it
can also disconnect a number. Hide the menu link from setters in HighLevel
(Settings > Custom Menu Links, visibility) if that matters.

## Add a second number

On the PingWren page in the sub-account, click **Add a number**, name it (for
example "Setter"), and scan its QR code with the second phone. A sub-account
can have up to 3. **Make default** picks which number sends when nothing else
decides. Each number has its own pacing and daily cap.

Billing: each number is its own Stripe subscription with its own 7-day free
trial, so adding one starts its trial and removing one cancels its billing
(see "Billing" below). `/admin` shows each account's billed numbers.

## AI Setter (HighLevel Conversation AI)

PingWren is registered as a replacement SMS provider ("Is this a Custom
Conversation Provider" left unticked). That makes WhatsApp the sub-account's
SMS channel, so the bot is set up on SMS:

1. Buy the AI Employee plan for the sub-account. Growth is $50/month with
   1,000 Conversation AI responses (help article 155000006652).
2. AI Agents > Conversation AI: create the bot, mode **Auto-Pilot**, channel
   **SMS**, and make it the primary bot so it answers inbound on that channel.
3. Turn on **Appointment Booking** and pick the coach's calendar.
4. If the sub-account has "Conversations AI Channel Management" switched on in
   Labs, channels are chosen on the bot's Deploy tab instead; add SMS there.
5. Test: message the coach's WhatsApp from another phone, check the bot's reply
   arrives on WhatsApp, then ask to book and check the appointment appears.

Bot replies are paced like any send (45 to 75 seconds apart per number), so a
reply can take up to a minute.

Not yet proven on a live sub-account. HighLevel's docs don't say outright that
the bot answers messages added through the API by a custom SMS provider; a
HighLevel staff member said in May 2026 that it does
(ideas.gohighlevel.com/conversation-ai/p/custom-sms-provider). If the bot stays
silent, raise a HighLevel ticket quoting that post.

The other route, listing PingWren under "Add channels from marketplace" on the
bot's Deploy tab (help article 155000008559), needs PingWren registered as a
**Custom** conversation provider (box ticked). That is a separate channel next
to SMS, and the code would need to accept `type: "Custom"` webhooks and send
inbound as `type: "Custom"` with the provider id. Not built.

## Health checks and alerts

`GET /api/cron/health` (header `Authorization: Bearer $CRON_SECRET`) runs every
5 minutes from `vercel.json`. It checks the bridge, each sub-account's
HighLevel connection and each WhatsApp number, and returns their statuses
(never a phone number or a token). `ok: false` means something is down.

- A number that was linked and has been down for 5 minutes (at once if logged
  out or banned) emails the coach and `ALERT_EMAIL_TO` once, with a reconnect
  link, and again when it reconnects.
- The bridge not answering, or a sub-account needing re-authorisation, emails
  the operator only.
- Messages sent while a number is down are held for `OUTBOUND_HOLD_MAX_HOURS`
  (default 24) and go out on reconnect. After that they are marked failed in
  HighLevel. Failures and stuck messages show in the GHL health panel on `/admin`.

Ban risk and the limits we run under: [`docs/WHATSAPP-BAN-RISK.md`](docs/WHATSAPP-BAN-RISK.md).
Set `WA_WARMUP_ENABLED=true` on the bridge.

## Numbers and groups

A GHL sub-account can link up to 3 WhatsApp numbers. Each number is its own
tenant on the bridge, with its own session, pacing and daily cap, and the
embed and connect pages address them by slot (1 to 3), never by tenant id.
One number is the default for sending; a contact who has messaged a
particular number gets replies from that number (sticky). Removing the
default promotes the lowest remaining slot, and the last number cannot be
removed. The app routes are `/api/crm/embed/numbers` and
`/api/crm/embed/groups`.

WhatsApp groups are opt-in. The owner picks which groups to sync; each
enabled group appears in GHL Conversations as one synthetic contact, and
messages from groups that were never enabled are not stored. Sending to a
group contact posts to the group and costs 5 daily-cap units.

### Create and manage groups

From the Groups section in GHL, a coach can create a group (name, optional
description, and who to invite) and manage groups the number created or
administers: rename, settings, remove members, make or remove admins, invite
link, and leave. The app routes are `/api/crm/embed/groups/manage` (one POST
route, switched on `action`) and `/api/crm/embed/groups/invite-template`.

- Invites are normal outbound messages. They go through pacing, the daily cap,
  STOP and the hold queue, so a held or opted-out invite is not sent. People are
  added directly only if they have messaged that number in the last 90 days
  (a missed call doesn't count).
  Everyone else gets the invite link.
- Only invites that WhatsApp accepted are also posted into the contact's GHL
  conversation. Held or queued invites are not.
- The invite message is edited inside GHL and applies to that sub-account only.
  It must include `{link}`.
- Limits per number per day: `WA_GROUP_CREATE_DAILY` creates (default 3) and
  `WA_GROUP_ADD_DAILY` direct adds (default 50). A create or add that reached
  WhatsApp is never refunded, even if it failed.
- A repeated create with the same `requestId` within 10 minutes returns the same
  group and sends no invites again.
- Run `services/whatsapp-bridge/scripts/group-sandbox.ts` on a spare number
  before go-live.

Apply migrations `0006` to `0010` (in order, after `0001` to `0005`) before
deploying the new bridge and app. `0009` adds the group action log and the
invite message column; the group create and manage screens need it. `0010`
adds missed-call and read-receipt columns and the SQL function
`ghl_outbound_awaiting_read` (service_role only). Its three flags
(`WA_MISSED_CALLS_ENABLED`, `WA_READ_RECEIPTS_ENABLED`,
`GHL_READ_RECEIPTS_ENABLED`) default to off and stay off until the checks in
`docs/superpowers/specs/2026-10-17-calls-receipts-real-device-check.md` pass. The app build must not go live before
them: without them every GHL outbound message fails before it is recorded,
the inbound drain fails on every pass, and a GHL install (OAuth) errors after
it has already written the account. The bridge tolerates running before
them: one-to-one sending and receiving are unaffected, and groups fail
closed (no group traffic in or out). Details are in
[`docs/GO-LIVE-FOUNDATION.md`](docs/GO-LIVE-FOUNDATION.md) and
[`services/whatsapp-bridge/README.md`](services/whatsapp-bridge/README.md).

## Billing

Billing is per WhatsApp number (a `ghl_location_numbers` row), not per
sub-account. Code: `src/lib/pricing.ts`, `src/lib/billing/numbers.ts`.

- **Card first.** Sign-up opens a Stripe Checkout in setup mode that only
  saves a card on the account's Stripe customer. Nothing is charged. Saving it
  moves the account from `pending` to `active` ("card on file"). With no card,
  Activate and Add a number are refused.
- **One subscription per number.** Activating a sub-account starts a
  subscription for each of its numbers; adding a number to an activated
  sub-account starts one for that number. Each has its own 7-day trial, then
  charges the saved card when the trial ends and renews monthly on that day.
  A number that has had a subscription before (deactivated and activated
  again) restarts with no trial and is charged straight away. A removed and
  re-added number is a new number and gets a new trial.
- **Volume tiers by number count.** The account's billed numbers (trialing,
  active or past due) pick one price for all of them: 1 to 10 £9.99, 11 to 24
  £7.99, 25 or more £5.99 a month each. When the count crosses a tier, every
  number's subscription moves to the new price with no proration, from its
  next invoice. Prices are inline `price_data` on one Stripe Product
  (`STRIPE_PRODUCT_ID`); no per-tier Price objects are needed.
- **Stopping.** Removing a number, or deactivating its sub-account, cancels
  that number's subscription at once, with the unused part of the month
  credited to the customer's balance. Disconnecting (logging the phone out)
  keeps the number and its billing.
- **Sending gate.** A number sends only while its own subscription is
  trialing, active or past due. Comped accounts never touch Stripe and always
  send.
- **Webhooks.** Every number subscription carries `account_id`, `location_id`
  and `tenant_id` metadata; `/api/webhooks/billing` maps each event to its
  number by `tenant_id` and re-prices the account when a status changes.

Migration `0020_number_billing.sql` adds the billing columns to
`ghl_location_numbers` and drops the old 3-sub-account trial cap from
`activate_ghl_location`. Apply it before deploying the build that reads it.

## Checking migrations locally

To check that every file in `supabase/migrations/` applies cleanly, use a
scratch Postgres 16. The migrations expect pieces Supabase provides, so stub
them first.

1. Make a cluster and start it on a socket directory:
   `initdb -D /var/tmp/pwpg`, then
   `pg_ctl -D /var/tmp/pwpg -o "-k /var/tmp/pwsock -c listen_addresses=''" start`
   (create `/var/tmp/pwsock` first).
2. Create the roles: `create role anon; create role authenticated; create role service_role;`
3. Create a fresh database and stub two schemas in it:
   - `create schema auth; create table auth.users (id uuid primary key);`
   - `create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);`
4. Apply each file in number order, stopping at the first error:
   `psql -h /var/tmp/pwsock -d <db> -v ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql`,
   then 0002 and on.

Stop the cluster and delete `/var/tmp/pwpg` when done. This was last run for
0001 to 0020.

Apply `0017` (agency tokens), `0018` (setter numbers) and `0019` (alerts)
before deploying the app build that reads them.
