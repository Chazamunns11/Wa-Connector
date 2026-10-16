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

### Environment variables — website

| Variable | Purpose |
| --- | --- |
| `BRAND_TAGLINE` | Short descriptor next to the name (default `WhatsApp for GoHighLevel`) |
| `BRAND_SUPPORT_WHATSAPP` | Optional support WhatsApp number in E.164 format |
| `BRAND_LOGO_PATH` | Optional logo: a `/public` path or absolute URL (unset = text wordmark) |
| `BRAND_ACCENT` | Optional accent colour as hex, e.g. `#17BEB4` (unset or invalid = default teal) |
| `BRAND_PRICE_PER_NUMBER` | Monthly price per WhatsApp number, a decimal in major units (required in production; dev default `29`) |
| `BRAND_CURRENCY` | ISO 4217 currency code (default `GBP`) |

Full list in `docs/GO-LIVE-FOUNDATION.md` (Task 7).
