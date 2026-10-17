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
