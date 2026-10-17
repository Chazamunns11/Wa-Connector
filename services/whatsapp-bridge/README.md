# WA Connector WhatsApp bridge

Always-on service holding each GoHighLevel location's WhatsApp Web session
(Baileys), so the web app can send a location's messages **from that
location's own linked number** and forward its replies to GHL. The web app
(Next on Vercel) cannot hold a permanently-open WebSocket, so this runs on
Railway instead. The product name shown to users comes from the web app's
`BRAND_NAME` (default "WA Connector"); this package never shows it.

Every tenant is a GHL location (`whatsapp_tenants.kind = 'ghl_location'`).
The HTTP contract is in `src/server.ts`'s file header; the web-app side is
`src/lib/whatsapp-bridge.ts` (typed client) in the repo root. Setup is in
`docs/GO-LIVE-FOUNDATION.md` at the repo root.

## Baileys version

Pinned to `@whiskeysockets/baileys@6.7.24` — the latest **stable** line
(released 29 Jul 2026). v7 exists only as release candidates (7.0.0-rc14, same
day) with breaking API changes and an ESM rewrite; do not bump to it casually.
The auth-state adapter (`src/auth-state.ts`) implements the v6.7.x
`AuthenticationState`/`SignalKeyStore` interface verified against the tagged
source (`src/Types/Auth.ts`, `src/Utils/use-multi-file-auth-state.ts` at
v6.7.18): six key categories, `BufferJSON` serialisation,
`AppStateSyncKeyData.fromObject` revival.

## Node 24 is the supported version

Run the bridge, and its tests, on **Node 24** (`.nvmrc` is `24`,
`engines.node` is `>=24`). The suite passes 279/279 on Node 24.11; tests run
on older Node versions are not supported (for example `npx -y node@24 --test`
or `nvm use` before `npm test`).

The hard floor is Node 22: Baileys opens its WhatsApp connection over a
**global `WebSocket`**, which Node only exposes natively from **Node 22**. On
Node 20 the process dies at startup
with:

```
[whatsapp-bridge] fatal: Node.js detected but native WebSocket not found.
```

Found the hard way on the first Railway deploy (30 Jul 2026): `engines.node`
said `>=20`, Railway believed it and provisioned `node@20.20.2`, and every
container crash-looped. It never showed locally because the dev machine runs
Node 24 — the classic "works on my machine" shape, caused by a manifest that
understated its own requirement.

So the version is declared in **two** places, deliberately: `engines.node`
(`>=24`, which Nixpacks and most hosts read) and `.nvmrc` (`24`, which the rest
read). `@supabase/supabase-js` independently warns that Node 20 is deprecated.

## Run

```bash
npm install
npm test          # unit checks (run on Node 24) — no network, no WhatsApp, no Supabase needed
npm run build     # tsc -> dist/
npm start         # node dist/index.js
```

Railway: root directory `services/whatsapp-bridge`, build `npm install && npm
run build`, start `npm start`, healthcheck path `/health` (unauthenticated,
liveness only). Set every variable in `.env.example`; the service refuses to
boot with any secret missing. **One Railway service, one replica** — the
session lease (`src/lock.ts`) makes an accidental second replica harmless
(it idles, unable to claim), but it is waste, not capacity.

Deploy order for the first live run: apply `supabase/migrations/0001_init.sql`
→ deploy bridge → set `WHATSAPP_BRIDGE_URL`/`WHATSAPP_BRIDGE_SECRET` on Vercel.

Groups: apply `0005_groups.sql` (the order is 0001 to 0005) → set
`WA_GROUPS_ENABLED=true` on the bridge → set `GROUPS_ENABLED=true` on the portal
→ turn on the site flag. See "Groups first light" in `docs/GO-LIVE-FOUNDATION.md`.

## Key rotation (`WA_CREDS_KEY`)

1. Generate a new key; set `WA_CREDS_KEY` to it and move the old value to
   `WA_CREDS_KEY_PREVIOUS`. Redeploy.
2. Rows re-encrypt organically on write (Baileys rewrites creds/keys
   constantly while connected). Envelopes are tagged with a fingerprint of
   the key that wrote them (`v1.<fp>.…`); get the OLD key's fingerprint with
   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update(Buffer.from(process.env.WA_CREDS_KEY_PREVIOUS,'base64')).digest('hex').slice(0,8))"
   ```
   then after a day or two check nothing still carries it:
   ```sql
   select count(*) from whatsapp_sessions    where creds_enc like 'v1.<fp>.%';
   select count(*) from whatsapp_session_keys where value_enc like 'v1.<fp>.%';
   ```
3. Both zero → remove `WA_CREDS_KEY_PREVIOUS`, redeploy. Non-zero rows that
   never drain belong to idle/disconnected sessions — either reconnect them or
   accept that those locations re-scan a QR after the old key is dropped.

If the key is **lost** (not rotated): wipe `creds_enc`/`whatsapp_session_keys`
for the affected locations and have each re-scan a QR. Annoying, never dangerous.

## Ops: what the portal sees, what a human does

The portal reads `whatsapp_sessions.status` (never this service directly), so
status stays visible even when the bridge is down.

| Event | Portal sees | Human action |
| --- | --- | --- |
| Session drops (network/stream error) | `disconnected` + reason | None — auto-reconnect with capped backoff (cap 60s), retried indefinitely (a failed reconnect attempt reschedules itself — see `sessions.ts`'s `scheduleReconnect`). |
| QR sits unscanned | `waiting_qr` persists; `GET /sessions/:id` serves each fresh QR (~60s rotation) | Client scans within `WA_MAX_QR_RECONNECT_ATTEMPTS` reconnect cycles (default 5). After that the bridge gives up (`disconnected`, reason "QR not scanned…") rather than re-registering with WhatsApp forever — run /connect again to get a fresh QR. |
| Client unlinks from their phone | `logged_out`, creds wiped | Re-run connect, client re-scans. Deliberate: unlinking is the client's choice. |
| Number banned (403) | `banned`, creds wiped | Human-only path: client appeals in-app to WhatsApp; once restored, connect + re-scan. Review what was sent — the pacer caps exist to keep this row empty. |
| Bridge redeploy | Momentary gap only (lease handoff; SIGTERM releases immediately, the new instance's resume-sweep retries every `WA_LOCK_HEARTBEAT_MS` (default 10s) until it claims — worst case ~`WA_LOCK_TTL_MS` (default 30s) if the old instance died without a clean SIGTERM). Each session's in-flight Signal key/creds writes are also FLUSHED (bounded by `WA_SHUTDOWN_FLUSH_TIMEOUT_MS`, default 5s) before that session's lease is released — every session flushes concurrently, so this adds at most ~one flush's worth of time to the redeploy, not one per session (`sessions.ts`'s `shutdownOneSession`/`shutdown()`, `src/pending-writes.ts`). Without this, a write killed mid-persist left the replacement container's Signal ratchet behind the real one — every client's OWN phone then showed "Waiting for this message" with `Bad MAC` in the logs, a real incident this fix closes. | None. Messages accepted-but-undispatched are failed with reason, never silently dropped, never double-sent. |
| Retry of an already-resolved send (same idempotencyKey, same `to`) | 200 `replay:true` with the stored row's true status | None — this is the whole point of the idempotency key. |
| Retry of an idempotencyKey with a DIFFERENT `to` (e.g. a corrected number reusing the same run id) | 422 `idempotency_conflict` naming the original recipient | Caller must mint a new idempotencyKey — the bridge refuses to guess which recipient was intended. |

## Inbound replies (Batch 1)

Baileys is a full WhatsApp client — this service already RECEIVES every
message on a linked device, not just the ones we send. `src/inbound.ts` is
the filter chain that turns that firehose into genuine prospect replies; see
its file header for the full ordered list (history/offline backfill,
`fromMe`, groups/status/newsletters, edits/reactions/protocol rows, and the
JID→E.164 mapping including WhatsApp's `@lid` routing). Two decisions worth
knowing about if you're reading this before the rest of the package lands:

- **The bridge writes reply rows directly to Supabase**
  (`whatsapp_inbound_messages`) with the same service-role
  client already used for sessions/keys/the send ledger — there is no web-app
  HTTP endpoint that accepts reply *data*. The only thing this service ever
  sends the portal is a CONTENTLESS "drain now" poke (`src/poke.ts`,
  `PORTAL_INBOUND_URL` / `WA_INBOUND_POKE_SECRET`, both optional and unset by
  default). This makes a forged reply structurally impossible: the only way
  a row can exist is that this service's service-role key inserted it.
  The same poke fires when a session reconnects (`recordReconnected`), so the
  portal releases held messages for that number straight away.
- **No ledger gate**: every tenant is a GHL location whose linked number is
  a dedicated business number, so cold inbound from a prospect who was never
  messaged first is the point. Every reply that passes the filter chain
  (`src/inbound.ts`) is stored and forwarded to GHL by the web app's drain;
  nothing is dropped for lack of a prior outbound message. The GHL-side
  rules (opt-in, dedicated-number disclosure) are operator policy, written
  in `docs/GO-LIVE-FOUNDATION.md`, not enforced here.

Replies sit in `whatsapp_inbound_messages` until the web app's poke-triggered
or hourly cron drain pushes them to GHL. This is safe and inert if the table
is empty or the poke is unset: `processInboundBatch` wraps every message in
its own try/catch, so a `recordInboundMessage` write failing (transient
Supabase error, whatever) is logged and dropped, never a crash. The message
still exists on the linked phone regardless.

## Group routes (`WA_GROUPS_ENABLED`)

Off by default. While off, every route below answers `404 groups_disabled`
(checked after the bearer gate, before the body is read). Same bearer auth and
strict-UUID `:coachId` as the other routes; group ids (`:jid`, URL-encoded)
must match `^[0-9]{5,20}(-[0-9]{5,20})?@g\.us$`.

| Route | Body | Success |
| --- | --- | --- |
| `POST /sessions/:coachId/groups` | `{ subject (1..100), description? (0..2048), participants (1..5 E.164), announceOnly?, adminAddOnly? }` | `201 { group, results }` |
| `POST /sessions/:coachId/groups/:jid/participants` | `{ add (1..50 E.164) }` | `202 { job: { id, status, requestedCount } }`; `429 group_add_cap_reached` |
| `GET /sessions/:coachId/groups/jobs/:jobId` | none | `200 { job }` with per-phone results |
| `POST /sessions/:coachId/groups/:jid/messages` | `{ text (1..4096), idempotencyKey }` | `202` fresh, `200` replay, `{ post }`; same pacer slot and daily cap as `/send` |
| `GET /sessions/:coachId/groups/:jid` | none | `200 { group }` (never participant phones) |
| `POST /sessions/:coachId/groups/:jid/invite/revoke` | none | `200 { inviteCode }` |

Errors use the uniform `{ ok: false, error: { code, message } }` shape:
`groups_disabled`, `invalid_group_jid`, `invalid_subject`, `invalid_description`,
`invalid_participants`, `group_create_cap_reached`, `group_add_cap_reached`,
`group_not_found`, `whatsapp_refused`, `session_not_connected`,
`daily_cap_reached`, `lease_unavailable`, `idempotency_conflict`.

## Safety invariants (do not weaken)

- Send targets must already be strict E.164 — the bridge refuses, it never
  normalises (`src/phone.ts`; `test/phone-contract.test.ts` pins the contract
  byte-for-byte to the portal's `src/lib/phone.ts`).
- Every dispatch is preceded by `onWhatsApp()` and sent to the JID WhatsApp
  returns; recipients without WhatsApp end `not_on_whatsapp`, terminal.
- `(coach_id, idempotency_key)` is unique (`coach_id` is the historical column name for the tenant id; for a GHL location it holds that location's tenant id); the only path to the wire is the
  atomic `accepted -> sending` claim. Interrupted `sending` rows are failed,
  never retried: at-most-once beats at-least-once when the recipient is human.
  `whatsapp_messages.dispatch_attempted` further splits a `failed` row into
  "never reached the send API, safe to reissue under a new key" (false) vs
  "dispatch was attempted, outcome UNCERTAIN — do not assume a retry is safe"
  (true, e.g. `sock.sendMessage` threw after the frame may already have hit
  WhatsApp).
- Pacing (`WA_SEND_MIN_GAP_MS` + jitter + `WA_DAILY_CAP`) is per tenant session
  and survives restarts (both the daily count AND the min-gap clock are
  seeded from the ledger — `store.getDailyActivity`). Budget is also
  RESERVED at accept time (`sentToday + queueLength`), not only counted at
  dispatch time, so a burst of due sends arriving faster than the pacer can
  drain (e.g. an hourly cron finding dozens of steps due at once) cannot
  blow through the cap before any of them has actually dispatched. A ban
  lands on the client's real business number — that is why these defaults
  are conservative.
- Two concurrent `/connect` calls for the same tenant (a double-clicked
  Connect button, or one landing mid-redeploy) collapse onto one in-flight
  attempt (`SessionManager.starting`) rather than racing two independent
  Baileys sockets — the split-brain lease alone cannot catch this because
  it's keyed per bridge *process*, not per attempt.
- `logout()` only wipes credentials when this instance holds a LIVE,
  freshly-confirmed lease for the session (`SessionLock.confirmHeld`, a real
  round trip — not the cached flag) — an instance that doesn't actually own
  the session no longer wipes it out from under the real owner.
- Credentials: AES-256-GCM, key only in this service's env, AAD-bound per row.
  Nothing credential-adjacent is ever logged (`LOG_LEVEL` floor for the
  Baileys child logger is `warn` for this reason).
- Group adds are batched (`WA_GROUP_ADD_BATCH`) with a paced gap, capped per
  day, and the bridge never sends private group invites; the portal sends
  invite links as ordinary paced 1:1 texts. Group routes never log phones,
  subjects, invite codes or secrets.

## Why outbound messages never render link previews

Every outbound text send goes out as `{ text, linkPreview: null }`
(`sessions.ts`'s `buildOutboundTextContent`), not plain `{ text }`. Baileys
only attempts preview generation (`generateWAMessageContent`,
`@whiskeysockets/baileys/lib/Utils/messages.js`) when `linkPreview` is
STRICTLY `undefined`; an explicit `null` skips its `getUrlInfo` call
entirely — the type this bridge targets allows exactly that shape
(`AnyRegularMessageContent`: `linkPreview?: WAUrlInfo | null`). Behaviour is
otherwise identical to a bare `{ text }` send.

This is deliberate, not a missing feature: making previews actually render
would require adding Baileys' optional `link-preview-js` dependency, which
would make this bridge server-side FETCH ARBITRARY URLs found in message
TEXT — attacker-reachable, since the text is whatever the portal forwarded
from a client's own typing — on every single outbound send. That is a brand
new SSRF / outbound-fetch surface for a purely cosmetic preview card, on a
service whose entire job is holding real clients' live WhatsApp sessions. Do
not add `link-preview-js` or delete `linkPreview: null` to "fix" a missing
preview — `test/sessions-text-content.test.ts` pins this decision.
