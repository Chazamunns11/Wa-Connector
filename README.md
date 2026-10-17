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
| `BRAND_NAME` | Product name shown to users (default `WA Connector`) |
| `BRAND_SUPPORT_EMAIL` | Optional support address shown to users |

The complete list, with required/optional and defaults for both the web app
and the WhatsApp bridge, is in [`docs/GO-LIVE-FOUNDATION.md`](docs/GO-LIVE-FOUNDATION.md),
which is also the deploy and first-light guide. The bridge (`services/whatsapp-bridge`)
runs on Node 24, and its tests must be run on Node 24.

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

Apply migrations `0003` to `0005` (in order, after `0001` and `0002`) before
deploying the new bridge and app. Details are in
[`docs/GO-LIVE-FOUNDATION.md`](docs/GO-LIVE-FOUNDATION.md) and
[`services/whatsapp-bridge/README.md`](services/whatsapp-bridge/README.md).
