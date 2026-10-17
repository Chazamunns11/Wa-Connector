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
