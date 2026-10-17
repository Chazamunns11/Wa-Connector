# Foundation go-live — Supabase, Railway, Vercel, a new GHL app, first light

The code is built and tested. This is the operator checklist for the parts
only a human with the accounts can do. Work top to bottom: each part feeds
values into the next.

Sign-up, Stripe billing and the dashboard have their own checklist:
[`GO-LIVE-ACCOUNTS.md`](GO-LIVE-ACCOUNTS.md). Do this document first, then that one.

`<Brand>` below means whatever you set `BRAND_NAME` to (default "PingWren"). `<app>` means this app's public URL, for example
`https://wa.example.com`, no trailing slash. `<bridge>` means the Railway
bridge's public URL.

Nothing here can send a WhatsApp message by accident before a QR code is
scanned. Until `WHATSAPP_BRIDGE_URL` is set on Vercel every send fails closed.

---

## Rule zero: never paste a secret into chat

Every secret below is generated on your machine and pasted straight into
Railway or Vercel. Never paste one into a Claude conversation, a ticket or a
doc. A key that appears in chat has to be treated as burned and rotated.

**Everything in this deployment is new.** A new Supabase project, a new
Railway service, new secrets, a new GHL Marketplace app. Never reuse the old
FitClosers `WA_CREDS_KEY`, bridge secret, poke secret, GHL client keys,
webhook public key or SSO secret. Reusing the bridge secret would let one
deployment send as the other.

Secret-generation commands (run in a terminal, one at a time, copy each result
straight into the destination):

```bash
# 32 random bytes, base64 — used ONLY for WA_CREDS_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 32 random bytes, hex (64 chars) — WA_BRIDGE_SECRET / WA_INBOUND_POKE_SECRET /
# CRON_SECRET / ONBOARD_STATE_SECRET (generate each separately)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep them in a password manager. Losing `WA_CREDS_KEY` means every linked
number has to re-scan its QR (annoying, never dangerous).

---

## Order of work

1. Part 1 Supabase (gives you the three Supabase values).
2. Part 2 Railway, first pass (gives you `<bridge>`).
3. Part 3 Vercel, first deploy (gives you `<app>`; needs `NEXT_PUBLIC_APP_URL`
   set before the build, so reserve the domain first).
4. Part 4 GHL app (gives you the six GHL values) then back to Vercel and
   Railway to fill them in and redeploy.
5. Part 5 first light.

Railway needs `<app>` for the poke URLs and Vercel needs `<bridge>`, so the
two are filled in a second pass once both domains exist. That is expected.

---

## Part 1 — Supabase

1. Supabase dashboard, existing organisation, **New project**. Name it for
   this product. Pick the region closest to Railway and Vercel. Save the
   database password in your password manager.
2. **SQL Editor → New query**. Paste the whole of
   `supabase/migrations/0001_init.sql` and run it once. It creates every
   table, the updated_at triggers, RLS (no policies; everything is
   service-role only) and the two storage buckets (`wa-media`, private, and
   `client-logos`).
   Then run each later file in `supabase/migrations/` in number order
   (`0002_accounts.sql`, `0003_activation_cap.sql`, `0004_reliability.sql`,
   `0005_whatsapp_sessions_phone_linked_at.sql`, `0006_ghl_location_numbers.sql`,
   `0007_whatsapp_groups.sql`, `0008_whatsapp_messages_group_jid.sql`,
   `0009_group_management.sql`, `0010_missed_calls_and_receipts.sql`, and any after), once each. The bridge writes `whatsapp_sessions.phone_linked_at` on
   every logout, so 0005 must be applied before the bridge is deployed.
   Likewise apply 0001 to 0010 in order before deploying the bridge and the
   app: 0002 to 0004 add accounts, activation and held messages / STOP
   opt-outs (see `docs/GO-LIVE-ACCOUNTS.md`), 0006 the several-numbers
   tables, 0007 the group tables, 0008 the `whatsapp_messages.group_jid`
   column the bridge and app now use, and 0009 the group action log and the
   per-account invite message used by group create and manage, and 0010 the
   missed-call and read-receipt columns plus the SQL function
   `ghl_outbound_awaiting_read` (service_role only). The bridge and app flags
   that use 0010 are off by default; see "Missed calls and read receipts" in
   Part 5.
   The app build must not go live before 0006 to 0010 are applied. Without
   them every GHL outbound message fails before it is recorded, the GHL
   inbound drain fails on every pass (no replies reach GHL), and a GHL
   install (OAuth) errors after it has already written the account. The
   bridge tolerates running before them: one-to-one sending and receiving
   are unaffected, and groups fail closed (no group traffic in or out until
   the migrations are in and the enabled-group set loads). Group create and add
   refuse until 0009 is in.
3. **Project Settings → API**. Note three values for Vercel and Railway:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL` (Vercel), `SUPABASE_URL` (Railway)
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Vercel)
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (Vercel and Railway)

   The service-role key bypasses RLS. It lives only in server env (Vercel
   server side, Railway). Never in a `NEXT_PUBLIC_` variable.

### 1b. Provision the owner (login does not sign people up)

Sign-in uses an emailed link with `shouldCreateUser: false`, so an address
that has no auth user simply never gets a link. Create the user first:

1. **Authentication → Users → Add user** (or **Invite user**) with your own
   email. For "Add user", tick "Auto Confirm User".
2. **SQL Editor**, give that user the owner role (replace the email):

   ```sql
   insert into profiles (id, role, email)
   select id, 'owner', lower(email) from auth.users
   where lower(email) = 'you@example.com';
   ```

   Check it inserted exactly one row. `/admin` and every admin action require
   `profiles.role = 'owner'`; a signed-in user with no profiles row is signed out
   and sent to `/signup`.

### 1c. Auth URLs (do this once the Vercel domain is known)

**Authentication → URL Configuration**:

- **Site URL**: `<app>`
- **Redirect URLs**: add `<app>/auth/callback`

Without the redirect entry the emailed link lands on the wrong place or is
rejected, and `/login?error=auth_callback` is what you see. Add
`http://localhost:3000/auth/callback` too if you will run it locally.

Customers sign out with **Log out** on their dashboard. The owner panel at
`/admin` has no sign-out button yet: clear the site's cookies for `<app>`.

---

## Part 2 — Railway (the WhatsApp bridge)

Use **Node 24**. Railway reads `engines.node` (`>=24`) from
`services/whatsapp-bridge/package.json` and `.nvmrc` (`24`); both are set. If
a deploy log ever shows Node 20, the bridge crash-loops with "native WebSocket
not found" (Node 22 is the hard floor, 24 is the supported version).

1. Existing Railway project → **New → GitHub Repo** → this repo (a **new
   service**; leave the old FitClosers bridge service alone).
2. Service → **Settings**:

   | Setting | Value |
   | --- | --- |
   | Root Directory | `services/whatsapp-bridge` |
   | Build Command | `npm install && npm run build` |
   | Start Command | `npm start` |
   | Healthcheck Path | `/health` |
   | Replicas | **1** |

   One replica: a second would only idle behind the session lease, which is
   wasted money, not capacity.
3. **Settings → Networking → Generate Domain**. That is `<bridge>`.
4. Generate three secrets (see Rule zero): `WA_CREDS_KEY` (base64 command),
   `WA_BRIDGE_SECRET` and `WA_INBOUND_POKE_SECRET` (hex command). All
   **new**.
5. **Variables**. Set the required ones, plus the two poke URLs once `<app>`
   is known (they can wait for the second pass). The full table is in
   "Bridge environment variables" below.

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | the new project's URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the new project's service-role key |
   | `WA_CREDS_KEY` | new base64 key |
   | `WA_BRIDGE_SECRET` | new hex secret (same value goes in Vercel as `WHATSAPP_BRIDGE_SECRET`) |
   | `PORTAL_INBOUND_URL` | `<app>/api/webhooks/whatsapp-replies` |
   | `PORTAL_OUTBOUND_URL` | `<app>/api/webhooks/crm-outbound-status` |
   | `WA_INBOUND_POKE_SECRET` | new hex secret (same value goes in Vercel as `WHATSAPP_INBOUND_POKE_SECRET`) |
   | `LOG_LEVEL` | `info` |

   Leave everything else at its default. The pacing defaults are deliberately
   cautious: 45 s minimum gap plus up to 30 s jitter, 150 messages per number
   per day. They exist to keep clients' numbers off WhatsApp's ban radar; do
   not raise them during the trial. Leave both media switches `false` for
   first light.
6. Check **Deployments → Logs**: it should reach "listening" with no config
   error. A missing or malformed variable stops the boot and names the
   variable. Open `<bridge>/health` in a browser: a small JSON response, no
   auth, reveals nothing.

Both poke URLs must be `https://`, and the poke secret must be set whenever
either URL is (the bridge refuses to boot otherwise). Without the pokes
nothing breaks; replies and delivery statuses just wait for the hourly cron
drain instead of arriving in seconds.

---

## Part 3 — Vercel (the web app)

1. Vercel → **Add New → Project** from this repo. Framework Next.js, root is
   the repo root (not the bridge). **New project**, not the old one.
2. Attach your domain so `<app>` is final before the first build.
3. **Environment Variables** (Production). The full table is in "Web app
   environment variables" below. The first-deploy minimum:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_APP_URL` | `<app>` — **required for `next build`**: `brandConfig()` throws in production without it, so the build fails if it is missing |
   | `NEXT_PUBLIC_SUPABASE_URL` | Part 1 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Part 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | Part 1 |
   | `BRAND_NAME` | `<Brand>` (optional; default "PingWren") |
   | `WHATSAPP_BRIDGE_URL` | `<bridge>` (https) |
   | `WHATSAPP_BRIDGE_SECRET` | the Railway `WA_BRIDGE_SECRET` value |
   | `WHATSAPP_INBOUND_POKE_SECRET` | the Railway `WA_INBOUND_POKE_SECRET` value |
   | `CRON_SECRET` | new hex secret. Vercel Cron sends it as `Authorization: Bearer …` to `/api/cron/drain` (hourly, `vercel.json`) |
   | `ONBOARD_STATE_SECRET` | new, separate hex secret. Signs connect links and embed sessions; required once either feature is used |
   | `SLACK_WEBHOOK_URL` | optional; an incoming-webhook URL for operational alerts |

   **The Supabase variables are required at runtime**, not just at build:
   without them `/admin` fails (the proxy throws for it) and sign-in cannot
   work. Public pages (the website, `/login`, `/signup`) still render. There
   is no demo mode.
4. Deploy. Visit `<app>/login`; it should render. The GHL variables come in
   Part 4, then redeploy.

`CRON_SECRET` and `ONBOARD_STATE_SECRET` must be different values.
Embed and connect-link signing never falls back to `CRON_SECRET`: anyone
holding the cron password could otherwise mint embed sessions. (The
owner-gated GHL install OAuth state in `signed-state.ts` still falls back to it.)

---

## Part 4 — GHL: a new Marketplace app

Do not reuse the FitClosers app. Create a **new** app under the `<Brand>`
name. (This mirrors the lessons of the original rollout; the layout of GHL's
developer portal differs from GHL's own docs, so trust this section over them
and, if the portal has moved again, stop and note what you see rather than
improvising.)

**Traps, all hit for real before:**

1. **Do 4e (client keys) BEFORE 4f.** The Conversation Providers module is
   *disabled* until the app has a client key pair, and its tooltip points at
   Advanced Settings, which is the wrong place. Redirect URL and scopes alone
   are not enough.
2. **Widen the browser window first.** On a window around 1150 px the Auth
   page's Save button renders off the right edge as a fixed footer; an
   ordinary click misses it and **the save fails silently**. Maximise, and
   always reload to confirm a save stuck.
3. **No URL you give GHL may contain "ghl".** GHL's validator scans the whole
   path and rejects it ("contains a Highlevel reference"). That is why the
   routes are `/api/crm/...` and `/api/webhooks/crm-provider`. Do not tidy
   them.
4. **Generate exactly ONE client key.** Two key pairs can both exist but only
   one is Default, and GHL's own generated install link uses the Default.

### 4a. Create the app and set the audience

**My apps → Create app**: name it `<Brand>`. Target user **Sub-Account**,
distribution **agency and sub-account**. App type **Private** for now.

### 4b. Pricing: choose **Free**, not Freemium (the Freemium trap)

Under Pricing details choose **Free**. Picking **Freemium**, even with a
single £0 plan, makes GHL classify the app as *paid*, and paid apps:

- refuse OAuth-link installs ("Paid apps can only be installed within the
  platform"), and
- **a Private app is not listed in the App Marketplace at all**.

That is a closed loop: neither door opens. Pricing is **locked once a version
is live** (the radios grey out), so fixing it later needs a new version set
to Free and published. Set Free the first time.

### 4c. Publishing is required before the app can be installed

A Draft app has never produced a version, and OAuth resolves a version: an
install of a Draft fails with `error.noAppVersionIdFound`. Clear "Mandatory
steps" before Part 5:

| Step | What it needs |
| --- | --- |
| Profile details | An **App description** and **at least three preview images**, 16:9, 640x360 to 960x540, PNG/SVG/JPEG/GIF (SVG is accepted) |
| Pricing details | **Free** (4b) |
| Publish | Mints the app version. Publishing a Private app does not list it publicly and does not trigger GHL review |

The app profile save has the same off-screen-Save trap as trap 2 above. Type, save,
reload, and check the description is still there and the step ticked.
Private stays private (new installs are only blocked past 5 *external*
agencies); do not switch to Public.

### 4d. BUILD → Advanced Settings → Auth

**Redirect URL**: paste

```
<app>/api/crm/oauth/callback
```

into the box and **click the blue "+ Add"**; typing without Add does not
save. Check it shows under "Added redirect URLs".

**Scopes**: use the "Search scopes" box. Tick exactly these six:

```
conversations.readonly
conversations.write
conversations/message.readonly
conversations/message.write
contacts.readonly
contacts.write
```

A banner saying agency-only scopes are unavailable is expected and correct.
**Save**, then reload to confirm.

### 4e. MANAGE → Secrets (client keys)

Generate **one** key pair. Have the Vercel tab already open: the Client Secret
is shown once.

| Vercel env var | Value |
| --- | --- |
| `GHL_CLIENT_ID` | the Client ID |
| `GHL_CLIENT_SECRET` | the Client Secret |

### 4f. BUILD → Modules → Conversation Providers

**+ Create conversation provider**:

| Field | Value |
| --- | --- |
| Name | `<Brand>` (or `<Brand> WhatsApp`) |
| Type | **SMS** |
| Delivery URL | `<app>/api/webhooks/crm-provider` |
| "Is this a Custom Conversation Provider" | **LEAVE UNTICKED** |

**That checkbox is the whole design.** Unticked, the provider *replaces* the
location's default SMS provider, so existing workflows route through it with
nothing rebuilt. Ticked, it becomes a separate channel type and every workflow
would have to be rewritten. If the checkbox is not where this says, stop.

Saving pops "Confirm before saving"; type `CONFIRM`. A provider does nothing
until a location both installs the app and selects it under Settings → Phone
Numbers.

GHL then shows a conversationProviderId:

| Vercel env var | Value |
| --- | --- |
| `GHL_CONVERSATION_PROVIDER_ID` | the id GHL just showed you |

It is minted once per Marketplace app, not per location. Until it is set,
replies queue safely in the database and never reach GHL; setting it later is
self-healing.

### 4g. The webhook public key

GHL publishes one **public** Ed25519 key for signing provider webhooks
(https://marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage).
It is a public key, so it does not need rule-zero handling. The key is global
to GHL, not specific to your app: paste GHL's current published key, both
marker lines included. The point is that it is set fresh in this Vercel
project rather than copied from the old one:

```
-----BEGIN PUBLIC KEY-----
…
-----END PUBLIC KEY-----
```

| Vercel env var | Value |
| --- | --- |
| `GHL_WEBHOOK_PUBLIC_KEY` | the full PEM block |

Until set, `/api/webhooks/crm-provider` returns 503 to every request
(fail-closed). The deployment verifies webhooks only against the key you
paste here.

### 4h. Custom Page (WhatsApp linking inside HighLevel)

1. **Advanced Settings → Auth → Shared Secret → Generate.** Copy it straight
   into Vercel:

   | Vercel env var | Value |
   | --- | --- |
   | `GHL_SSO_SHARED_SECRET` | the generated Shared Secret |

   `ONBOARD_STATE_SECRET` (Part 3) must also be set: the embed refuses to run
   without both.
2. **Modules → Custom Page**:
   - URL: `<app>/embed/crm`
   - Placement: **left navigation menu**, distributed to **sub-accounts**
   - **No template variables in the URL** (`{{location.id}}` and friends). The
     page ignores query params and identifies the location only from GHL's
     signed payload.
3. **Re-publish the app.** Adding a module creates a new version. Scopes are
   unchanged, so installed locations should not need re-authorising; confirm
   on the spare sub-account.
4. Verify after the redeploy:
   - Open the new left-nav item from **Sub-Account view** (Agency view has no
     active location and correctly refuses).
   - `curl -I <app>/embed/crm` returns a `Content-Security-Policy` header with
     `frame-ancestors`, and it is **not** `*`. If missing, stop and fix: the
     page could be framed by anyone.
   - If a client's agency uses a whitelabel domain, add that origin to
     `GHL_EMBED_FRAME_ANCESTORS` (space-separated, each a bare `https://`
     origin, at most one leading `*.`) and redeploy. The symptom is a blank
     panel, not an error.

**Accepted risk:** GHL's SSO payload carries no timestamp or nonce, so a
captured payload can mint an embed session for that location indefinitely.
Two revocations work: disable the affected location in `/admin`, or rotate
`GHL_SSO_SHARED_SECRET` (blunt: invalidates every location at once).

### 4i. Fill in the rest and redeploy

- Vercel: confirm `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`,
  `GHL_CONVERSATION_PROVIDER_ID`, `GHL_WEBHOOK_PUBLIC_KEY`,
  `GHL_SSO_SHARED_SECRET` are all set, then **Deployments → Redeploy**.
- Railway: if you deferred them, set `PORTAL_INBOUND_URL` and
  `PORTAL_OUTBOUND_URL` now. A malformed one refuses to boot and says which.
- `GHL_APP_ID`: note the app's id (shown on the app page) in your password
  manager. The current code does not read it, so it is not a required
  variable; it is useful when talking to GHL support.

---

## Part 5 — First light

Use a **spare sub-account** and **your own number** (a dedicated business
number, never a personal line you also use for family and friends). Rule
zero still applies: no secrets in screenshots you share.

1. **Install.** Sign in at `<app>/login` (Part 1b done). On `/admin` choose
   **Install to a GHL location**, pick the spare sub-account and approve.
   The location appears in the accounts panel.
2. **Connect via QR.** From the location's Custom Page (or a connect link
   minted in `/admin`), choose connect and scan the QR with your phone:
   WhatsApp → Linked devices → Link a device. Status moves to connected.
3. **Set the Telephony Provider.** In the sub-account: Settings → Phone
   System → Advanced Settings → Telephony Provider → select `<Brand>`. Some
   accounts label it Phone Numbers → SMS Provider instead; it is the same
   setting.
4. **Send.** Build or run a workflow with an SMS step to a contact whose
   phone is your number. It should arrive on WhatsApp within the pacing
   delay (the first send waits at least the 45 s gap plus jitter) and the
   GHL message should flip from pending to **delivered**.
5. **Reply.** Reply from WhatsApp. The reply should appear in the contact's
   GHL conversation (seconds with the poke, otherwise by the next hourly
   drain).
6. **Cold inbound.** From a phone GHL has never seen (not an existing
   contact), message the linked number. A **new contact** should appear in
   GHL with the conversation attached.

If a step fails: Vercel → Logs for the `/api/webhooks/*` and
`/api/cron/drain` routes, Railway → Logs for the bridge, and the health panel
on `/admin`. The usual causes of "nothing happens" are the Telephony Provider
not actually set (step 3), `GHL_CONVERSATION_PROVIDER_ID` unset (replies
queue but never reach GHL), and a poke secret that differs between Vercel
and Railway.

First light passes when all six steps work. Then, and only then, onboard real
locations.

### Group creation and management: checks before go-live

These need a real phone and a real GHL sub-account, so they cannot run in CI.
Do them after migration 0009 is applied and before a coach uses the feature.

- [ ] **Sandbox script.** Run `services/whatsapp-bridge/scripts/group-sandbox.ts`
  on a spare number, never a client's. It prints a pass or fail line per step.
  Record in the spec's Decisions log whether creating an empty group works.
- [ ] **Invites in GHL.** Only invites that WhatsApp accepted are posted into the
  contact's GHL conversation, with `POST /conversations/messages/outbound`.
  Held or queued invites are not. The request body
  (`type: "SMS"`, `contactId`, `conversationProviderId`, `message`) is
  unverified. Send one real invite and check that the message shows once in the
  conversation, that GHL does not try to deliver it again through our provider,
  and whether `conversationId` or `altId` is needed.
- [ ] **Tag filter.** Check the `POST /contacts/search` tag filter shape
  (`filters`, field `tags`, operator `contains`) returns the right contacts for
  a tag. The app rechecks tags itself, but a wrong filter returns nothing.
- [ ] **Inside GHL.** Open **Create group** and **Manage** in a real GHL
  sub-account, not only in a plain browser. Create a group, invite a contact,
  rename it, copy and reset the link, and leave.
- [ ] **Limits.** A create or add that reached WhatsApp is never refunded. A
  repeated create with the same `requestId` within 10 minutes returns the same
  group and sends no invites again. Check one repeat by hand.

---

### Missed calls and read receipts: checks before go-live

Apply migration 0010 first. Three flags, all off by default:

- `WA_MISSED_CALLS_ENABLED` (Railway, bridge)
- `WA_READ_RECEIPTS_ENABLED` (Railway, bridge)
- `GHL_READ_RECEIPTS_ENABLED` (Vercel, app)

Leave them off until the checks in
`docs/superpowers/specs/2026-10-17-calls-receipts-real-device-check.md` pass.
Turn on the bridge flags first, then the app flag, and only if GHL accepted
`read` in the sandbox.

## Part 6 — Moving a sub-account from the FitClosers app to this one

The same phone number must never be linked to both bridges at once; two
live sessions fight over one WhatsApp account.

1. Install this app on the sub-account (Part 5, step 1) and connect its
   number here (step 2).
2. Switch the Telephony Provider to `<Brand>` (step 3).
3. **Immediately afterwards, unlink the old linked device**: on the phone,
   WhatsApp → Linked devices → remove the FitClosers entry (or log out from
   the old app's panel). Do not leave both linked "until later".
4. Re-run the send/reply checks from Part 5 on that location.

---

## Environment variable reference

### Web app (Vercel). Source: `grep -rhoE "process\.env\.[A-Z0-9_]+" src next.config.ts | sort -u`

| Variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes at runtime | none | Supabase project URL; `/admin` and sign-in fail without it (public pages still render) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes at runtime | none | Supabase anon key; `/admin` and sign-in fail without it (public pages still render) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | none | Service-role key; server only |
| `NEXT_PUBLIC_APP_URL` | Yes in production, **and for `next build`** | `http://localhost:3000` in dev only | Public base URL; `brandConfig()` throws in production without it |
| `BRAND_NAME` | No | `PingWren` | Product name shown to users |
| `BRAND_TAGLINE` | No | `WhatsApp for GoHighLevel` | Short descriptor next to the name |
| `BRAND_LOGO_PATH` | No | the PingWren kit logo | Logo for light surfaces: a `/public` path or absolute URL |
| `BRAND_LOGO_REVERSE_PATH` | No | falls back to `BRAND_LOGO_PATH`, then the kit logo | Logo for dark surfaces |
| `BRAND_ACCENT` | No | PingWren Coral | Accent colour as hex, e.g. `#FF6B5B`; invalid values fall back to the default |
| `BRAND_SUPPORT_EMAIL` | No | unset | Support address shown to users |
| `BRAND_SUPPORT_WHATSAPP` | No | unset | Support WhatsApp number, E.164 |
| `WHATSAPP_BRIDGE_URL` | Yes for sending | unset (sends fail closed) | `<bridge>`, https (plain http only for localhost) |
| `WHATSAPP_BRIDGE_SECRET` | Yes for sending | unset (fail closed) | Must equal the bridge's `WA_BRIDGE_SECRET` |
| `WHATSAPP_INBOUND_POKE_SECRET` | Yes for pokes | unset (poke routes return 503; the hourly cron still drains) | Must equal the bridge's `WA_INBOUND_POKE_SECRET`; guards both poke routes |
| `CRON_SECRET` | Yes | unset (`/api/cron/drain` returns 503) | Bearer secret for the hourly drain |
| `OUTBOUND_HOLD_MAX_HOURS` | No | `24` (accepted 1 to 168) | How long a message to a disconnected number is held before it is reported as failed |
| `ONBOARD_STATE_SECRET` | Yes for connect links and the embed | unset (those features show "not switched on") | Signs connect-link and embed tokens; separate from `CRON_SECRET` |
| `SLACK_WEBHOOK_URL` | No | unset (alerts skipped) | Operational alerts |
| `GHL_CLIENT_ID` | Yes for GHL | unset (GHL features off) | Marketplace app client id |
| `GHL_CLIENT_SECRET` | Yes for GHL | unset | Marketplace app client secret |
| `GHL_WEBHOOK_PUBLIC_KEY` | Yes for GHL | unset (webhook returns 503) | GHL's current published webhook public key, PEM |
| `GHL_CONVERSATION_PROVIDER_ID` | Yes for replies to reach GHL | unset (replies queue) | Provider id from 4f |
| `GHL_SSO_SHARED_SECRET` | Yes for the Custom Page | unset (embed off) | Decrypts GHL's SSO payload |
| `GHL_EMBED_FRAME_ANCESTORS` | No | unset (GHL's own hosts only) | Extra `frame-ancestors` origins for whitelabel domains |
| `GHL_SYNC_DND` | No | `false` | Exactly `true` mirrors STOP/START onto the GHL contact's WhatsApp and SMS DND (`PUT /contacts/{id}` `dndSettings`; verify at first go-live). Failures are logged and never block the opt-out |
| `GHL_READ_RECEIPTS_ENABLED` | No | `false` | Exactly `true` lets the cron report `read` to GHL for messages the bridge saw read. Turn on only after the real-device check |
| `WA_MEDIA_BUCKET` | No | `wa-media` | Supabase Storage bucket for inbound media; must match the bridge |
| `WA_MEDIA_OUTBOUND_ENABLED` | No | `false` | Web-app side media switch; see the flip order below |
| `WA_MEDIA_SIGNED_URL_TTL_DAYS` | No | `90` | Lifetime of signed media URLs |
| `NODE_ENV` | Set by Vercel | n/a | Not an operator setting |

That is 23 foundation names (the `BRAND_*` website variables above are extra): 22 from `src/` (including `NODE_ENV`) plus
`GHL_EMBED_FRAME_ANCESTORS` from `next.config.ts`.

**Media switches, flip order.** Both media features default off and stay off
for first light. The bridge and the web app each have their own
`WA_MEDIA_OUTBOUND_ENABLED`. To enable, set the **bridge's** first, then the
web app's. To disable, the **web app's** first, then the bridge's. The other
order creates a window where attachments are refused. Inbound media is
enabled only by the bridge's `WA_MEDIA_INBOUND_ENABLED`.

### Bridge (Railway). Source: `services/whatsapp-bridge/src/config.ts`

Required variables refuse to boot when missing. Defaults are in code and in
`services/whatsapp-bridge/.env.example`.

| Variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | Yes | none | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | none | Service-role key |
| `WA_CREDS_KEY` | Yes | none | 32 bytes, base64; encrypts stored sessions. New, never reused |
| `WA_CREDS_KEY_PREVIOUS` | No | unset | Decrypt-only old key during rotation |
| `WA_BRIDGE_SECRET` | Yes | none | At least 32 chars; bearer secret for every route except `/health` |
| `PORT` | No | `8080` | HTTP port (Railway sets it) |
| `WA_SEND_MIN_GAP_MS` | No | `45000` | Minimum gap between sends on one number |
| `WA_SEND_JITTER_MS` | No | `30000` | Random jitter added to the gap |
| `WA_DAILY_CAP` | No | `150` | Max sends per number per UTC day |
| `WA_WARMUP_ENABLED` | No | `false` | Ramp a newly linked number's daily cap: 20/day for days 0-2, 50 for 3-6, 100 for 7-13, then `WA_DAILY_CAP`. Leave off while moving established numbers across |
| `WA_GROUP_CREATE_DAILY` | No | `3` | Groups one number may create per UTC day. Attempts count; failed creates are not refunded |
| `WA_GROUP_ADD_DAILY` | No | `50` | People one number may add directly per UTC day. Attempts count; not refunded |
| `WA_TYPING_INDICATOR_ENABLED` | No | `true` | Show "typing…" before each outbound text |
| `WA_TYPING_MAX_MS` | No | `4000` | Longest typing window per message (ms) |
| `WA_LOCK_HEARTBEAT_MS` | No | `10000` | Session lease heartbeat |
| `WA_LOCK_TTL_MS` | No | `30000` | Lease staleness TTL; must exceed the heartbeat |
| `WA_SHUTDOWN_FLUSH_TIMEOUT_MS` | No | `5000` | Shutdown write-flush ceiling; 500 to 5999 |
| `WA_MAX_QR_RECONNECT_ATTEMPTS` | No | `5` | Reconnects for a never-paired session |
| `LOG_LEVEL` | No | `info` | pino level; never `debug`/`trace` in production |
| `PORTAL_INBOUND_URL` | No | unset | `<app>/api/webhooks/whatsapp-replies`, https |
| `PORTAL_OUTBOUND_URL` | No | unset | `<app>/api/webhooks/crm-outbound-status`, https |
| `WA_INBOUND_POKE_SECRET` | Required if either poke URL is set | unset | At least 32 chars; shared by both pokes |
| `WA_MEDIA_OUTBOUND_ENABLED` | No | `false` | Master switch, exactly `true` or `false` |
| `WA_MEDIA_INBOUND_ENABLED` | No | `false` | Master switch, exactly `true` or `false` |
| `WA_MEDIA_FETCH_TIMEOUT_MS` | No | `30000` | Outbound attachment fetch cap |
| `WA_MEDIA_MAX_IMAGE_BYTES` | No | `10485760` | Outbound image cap |
| `WA_MEDIA_MAX_AUDIO_BYTES` | No | `16777216` | Outbound audio cap |
| `WA_MEDIA_MAX_VIDEO_BYTES` | No | `52428800` | Outbound video cap |
| `WA_MEDIA_MAX_DOCUMENT_BYTES` | No | `104857600` | Outbound document cap |
| `WA_INBOUND_MEDIA_MAX_BYTES` | No | `26214400` | Inbound per-file cap |
| `WA_INBOUND_MEDIA_PER_SENDER_DAILY` | No | `20` | Inbound media per sender per tenant per day |
| `WA_INBOUND_MEDIA_PER_TENANT_DAILY` | No | `300` | Inbound media per tenant per day |
| `WA_VOICE_TRANSCODE_ENABLED` | No | `false` | Send non-opus GHL audio as voice notes via ffmpeg. Turn on only after `ffmpeg -version` works in a Railway shell; see the bridge README, "Voice notes" |
| `WA_MISSED_CALLS_ENABLED` | No | `false` | Log calls that ring out unanswered as missed-call messages. Off until the real-device check passes |
| `WA_READ_RECEIPTS_ENABLED` | No | `false` | Record delivered and read times for one-to-one messages. Off until the real-device check passes |
| `WA_MEDIA_BUCKET` | No | `wa-media` | Storage bucket for inbound media |

That is 34 variables, all read in `config.ts`.

---

## Go-live gates — the website promises these

The marketing site, FAQ and setup guide describe the launched product. Do not
launch publicly until each of these is built or the copy is changed to match:

- **(a) Held messages while a phone is disconnected.** Built — `src/lib/ghl-held.ts`.
  Messages to a previously linked, offline number are held and released oldest
  first when it reconnects (reconnect poke and the hourly drain). A message held
  longer than `OUTBOUND_HOLD_MAX_HOURS` (default 24) is reported to GoHighLevel
  as failed, never sent late. New messages for a number with held rows wait
  behind them, so order is kept. Picture and file messages are held the same
  way: the whole message waits and is released text first, then attachments in
  order; a drop part-way keeps the remaining parts held and no part sends twice.
  With several numbers per sub-account, a message is held on the number it was
  routed to (the contact's sticky number, the default, or the group's number)
  and is never sent from another number instead. A number that was never
  linked is refused at once (a non-default one with "The WhatsApp number this
  contact uses is disconnected — reconnect it to reply").
- **(b) STOP opt-outs.** Built — `src/lib/opt-out.ts` + `src/lib/ghl-inbound.ts`. Whole-message, case-insensitive keywords. Opt-out: STOP, STOPALL, STOP ALL, UNSUBSCRIBE, END, QUIT, OPT OUT, OPTOUT (CANCEL is deliberately excluded: it cancels appointments). Opt-in: START, UNSTOP, SUBSCRIBE, OPT IN, OPTIN. The reply is still delivered to GoHighLevel. A STOP is stored on the number it arrived on but blocks sends from every number of that sub-account; a START on any of them clears it on all of them; removing a number carries its opt-outs onto the remaining default. A member typing STOP inside an enabled WhatsApp group records nothing, and group sends are never blocked by an opt-out (the owner opted the group in).
- **Known limits of (a) and (b).**
  - A message already inside the bridge's paced queue when a STOP lands still
    sends. The opt-out applies from the next send on every path.
  - The GoHighLevel do-not-disturb endpoint (`GHL_SYNC_DND`, off by default) is
    not live-verified. A failure is logged and never blocks anything.
  - The hold limit is `OUTBOUND_HOLD_MAX_HOURS` (default 24, accepted 1 to 168).
    Older messages are reported to GoHighLevel as not sent, never sent late.
- **(e) Real legal text.** Replace the draft notice and the "(drafts)" label
  on the privacy, terms and related pages with reviewed legal text.

Also before launch:

- Confirm the launch prices in `src/lib/pricing.ts` (per activated sub-account, up to 3 WhatsApp numbers included on every tier, decided 17 Oct 2026; volume pricing in GBP: £9.99 a month per sub-account for 1 to 10 sub-accounts, £7.99 each for 11 to 24, £5.99 each for 25 or more, the tier reached applying to every sub-account). There is no price env var any more. The Stripe price must be a recurring, monthly, **volume-tiered** price with exactly these three tiers (1 to 10 at 999p, 11 to 24 at 799p, 25 and above at 599p), and must be changed whenever `src/lib/pricing.ts` changes. See GO-LIVE-ACCOUNTS.md Part 2.
- Run a trademark search for "PingWren".

---

## Still true after first light

- The account dashboard has Log out. The owner panel at /admin has none yet: clear the site cookies.
- Use a **dedicated business number** for every location, and make sure the
  client has agreed in writing that the number will receive and be answered
  for cold inbound WhatsApp. The bridge stores every 1:1 reply; it does not
  know who the number's owner is willing to hear from.
- A number can be banned by WhatsApp. The pacing defaults exist to keep that
  rare; review what was sent before appealing.
- To rotate `WA_CREDS_KEY`, follow "Key rotation" in
  `services/whatsapp-bridge/README.md`.
