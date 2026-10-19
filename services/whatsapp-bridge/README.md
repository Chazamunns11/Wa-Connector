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
liveness only). For voice notes the image also needs ffmpeg; see "Voice notes" below. Set every variable in `.env.example`; the service refuses to
boot with any secret missing. **One Railway service, one replica** — the
session lease (`src/lock.ts`) makes an accidental second replica harmless
(it idles, unable to claim), but it is waste, not capacity.

Deploy order for the first live run: apply `supabase/migrations/0001_init.sql`
then every later migration in number order (`0005_…` adds
`whatsapp_sessions.phone_linked_at`, which `wipeCreds` writes)
→ deploy bridge → set `WHATSAPP_BRIDGE_URL`/`WHATSAPP_BRIDGE_SECRET` on Vercel.
Migrations `0006` (numbers), `0007` (groups), `0008`
(`whatsapp_messages.group_jid`, `to_phone` nullable) and `0009` (group action
log, used for the daily create and add limits) should all be applied
before this version of the bridge is deployed. The bridge tolerates running
before them: one-to-one sending and receiving are unaffected, and groups fail
closed (the enabled-group set cannot load, so group traffic is dropped in
both directions), and group create and add refuse with "Group limits are
unavailable right now. Try again shortly." until 0009 is in. The app is
different: its build must not go live before 0006 to 0009 are applied, or every GHL outbound message fails before it is
recorded, the GHL inbound drain fails on every pass, and a GHL install
(OAuth) errors after it has already written the account.


## Missed WhatsApp calls

The bridge notices calls that ring out unanswered and records each as an
inbound row (`event_kind = 'missed_call'`, no body, message type
`missedVoiceCall` or `missedVideoCall`), which the app posts to GoHighLevel. It
only observes: it never answers or rejects a call.

- **Flag:** `WA_MISSED_CALLS_ENABLED` (default `false`). Apply migration
  `0010_missed_calls_and_receipts.sql` first.
- A call is missed only if the bridge saw the ring (`offer`) for it and it then
  ends (`timeout`, `reject`, `terminate`) with no `accept` from any device. A
  call that rang while the bridge was restarting, or one answered and longer
  than 10 minutes, is never logged as missed. Group calls and calls from the number itself are
  ignored.
- The caller is resolved like a message sender (phone JID, or a LID that
  the session's LID mapping resolves); unresolvable callers are dropped.
- The caller and voice/video type come from the ring (`offer`), not from the
  event that ends the call: a decline on the coach's own phone can name the
  number itself as `from`.
- At most one row per caller per 10 minutes.
- The app does not post a missed call that is more than 6 hours old when its
  drain reaches it (resolution `missed_call_stale`), so a reconnect after a
  long outage never sets off a very late text-back.
- A missed call is not a message: it never makes the caller eligible for a
  direct group add (see "Group management limits and rules" below).
- Logs carry fixed strings only: no phones, JIDs or call ids.

## Delivered and read receipts

The bridge records when a message we sent is delivered and read
(`whatsapp_messages.delivered_at` / `read_at`), from Baileys' `messages.update`
events.

- **Flag:** `WA_READ_RECEIPTS_ENABLED` (default `false`). Apply migration
  `0010_missed_calls_and_receipts.sql` first.
- Each timestamp is set once and never moves backwards. A read also sets
  `delivered_at` if it is empty.
- Receipts are tracked for one-to-one messages only. Group updates are ignored
  (Baileys reports group receipts through a different event).
- An ack that arrives before the ledger row has its WhatsApp message id is held
  in memory for 60 seconds (at most 1,000 entries) and applied once the send is
  recorded.
- The app reports `read` to GHL only when `GHL_READ_RECEIPTS_ENABLED=true` is set on the app (Vercel). Leave both flags off until the real-device check passes.
- The absence of a read receipt means nothing: people turn read receipts off.
- Logs carry fixed strings and error names only: no message ids or JIDs.

## Messages sent from the phone

Without this, a message the business types on the connected phone (or
WhatsApp Web) never reaches GoHighLevel, so a GHL conversation only shows the
contact's side plus whatever GHL itself sent.

- **Flag:** `WA_MIRROR_PHONE_SENT_ENABLED` (default `false`). On, a plain
  one-to-one `fromMe` message is recorded with `direction = 'outbound'` and
  `from_phone` set to the contact, and the app posts it to the contact's GHL
  conversation as an outbound message. Group messages, reactions, edits and
  deletes by the business are still dropped, and media is never captured.
- **Never mirrored:** the bridge's own sends (each send's id is chosen and
  registered before `sendMessage`, so its echo is recognised; the app also
  re-checks the send ledger), and the "message yourself" chat.
- **Deploy order:** apply migration `0016_whatsapp_phone_sent_mirror.sql`,
  deploy the app, then set the flag.

## Edits, reactions, deletes and quoted replies

The bridge records a contact's edits, reactions and "delete for everyone" as
inbound event rows, and puts a quoted reply's quote in front of its body. The
app decides what to post to GoHighLevel (reactions and deletes only when the
sub-account turns them on).

- **Flag:** `WA_INBOUND_EVENTS_ENABLED` (default `false`). Off means today's
  behaviour exactly: events are dropped and quotes are ignored.
- **Deploy order:** apply migration `0011_message_events.sql`, deploy the app,
  and only then set `WA_INBOUND_EVENTS_ENABLED=true`. Never roll the app back
  while the flag is on: an older app posts reactions as plain messages. Turn
  the flag off first.
- Each event row has its own `wa_message_id` (so redelivery still dedupes),
  `message_type = 'event'`, no media, `event_kind` and `target_wa_message_id`
  (the message it acts on):
  - `reaction`: body is the emoji. `target_from_me` is true for a reaction to
    one of our messages. A removed reaction (empty emoji) is ignored.
  - `edit`: body is the new text (or new caption). An edit with no text is
    ignored.
  - `delete`: no body.
- An event is found inside any wrapper (disappearing messages, view-once,
  and the rest) and is never treated as a fresh message. Polls and other
  protocol messages stay dropped. Our own edits, reactions and deletes stay
  dropped. A bare `editedMessage` wrapper with no `MESSAGE_EDIT` inside stays
  dropped: Baileys only emits that shape on `messages.update`. Real edits
  arrive as a `MESSAGE_EDIT` protocol message, bare or wrapped.
- Quoted reply (text replies only): the body starts with `↩ "<first 80 characters of the quoted
  text>"` (line breaks in the quote become one space), or `↩ (photo)`, `↩ (video)`, `↩ (voice note)`, `↩ (audio)`,
  `↩ (document)`, `↩ (sticker)`, otherwise `↩ (message)`, then a newline and
  the reply. The reply text is cut to fit 500 characters, never the prefix. A
  media reply keeps today's placeholder: captions were never read into the
  body, so no prefix is added.
- Logs carry fixed drop reasons only: no text, emoji, ids, phones or JIDs.

## Voice notes (ffmpeg)

Audio that GHL sends and that is not ogg/opus (an mp3, an m4a, GHL's own
browser recording as webm or wav) can be transcoded to ogg/opus and sent with
`ptt: true`, so it shows on the phone as a voice note with duration and
waveform. It is off by default.

- **Flag:** `WA_VOICE_TRANSCODE_ENABLED` (default `false`). Off, outbound media
  behaves as before, except that m4a is now sent as an audio file rather than
  as a video.
- **ffmpeg** must be in the image. `nixpacks.toml` (Nixpacks) and
  `railpack.json` (Railpack) both add it; each builder ignores the other's
  file. To see which builder the service uses: Railway dashboard, the service,
  **Settings**, **Build**, **Builder**. Deploy logs also name it at the top of
  the build. A Dockerfile, if one is ever added, has to install `ffmpeg` itself.
- **Boot probe:** with the flag on, startup runs one `ffmpeg` probe (10 s
  limit) before listening. If ffmpeg or libopus is missing it logs
  `voice transcode enabled but ffmpeg with libopus was not found` once and the
  bridge carries on exactly as with the flag off. It never fails the boot.
- **Limits:** ffmpeg gets a 10 second hard timeout (`VOICE_TRANSCODE_TIMEOUT_MS`,
  a constant), at most 2 run at once, and input is capped at
  `WA_MEDIA_MAX_AUDIO_BYTES` (default 16777216). Oversized input is refused
  before ffmpeg runs. A voice note longer than 15 minutes is not cut short; it
  falls back. ffmpeg reads a private temp file the bridge wrote, never a URL.
- **ffmpeg missing at boot:** transcoding is off for that run, exactly as with
  the flag off: webm and wav are refused, everything else goes as before. The
  fallback below does not apply.
- **Fallback (ffmpeg was found at boot):** any transcode failure (timeout,
  busy, too long, bad output, ffmpeg failing on that file) sends the original
  and never fails the message:

  | Input | Flag off | Flag on, transcode fails |
  | --- | --- | --- |
  | ogg/opus | voice note | voice note (never transcoded) |
  | ogg Vorbis | audio file | audio file |
  | mp3 | audio file | audio file |
  | m4a | audio file | audio file |
  | webm, wav | refused | document `voice-note.webm` / `.wav` |
  | any of these with a video track | as above | document under GHL's own file name (never a voice note) |

- **Logs:** `outbound voice note prepared` (tenant id, message id, mime,
  outcome, elapsed ms) for each transcode, and `outbound attachment` (tenant
  id, message id, sniffed mime, the mp4 `ftypBrand`, kind, ptt) for every
  attachment sent. Never audio bytes, ffmpeg output, file names or the
  attachment URL.

Flip order:

1. Deploy with the flag off (the default) so ffmpeg is in the image.
2. Open a Railway shell on the service and run `ffmpeg -version`.
3. Set `WA_VOICE_TRANSCODE_ENABLED=true` and redeploy.
4. Check the boot log: there must be no `ffmpeg with libopus was not found`
   warning.
5. Run the real-device check in
   `docs/superpowers/specs/2026-10-17-voice-notes-real-device-check.md`.

To turn it off, set the flag to `false` and redeploy.

## Routes added for groups

All need the bearer secret, like every route except `/health`.

| Route | Does |
| --- | --- |
| `GET /sessions/:id/groups` | Lists the number's groups live from WhatsApp (`{ ok: true, groups: [{ jid, name, size }] }`). 409 `session_not_connected` if the session is down, 502 `groups_unavailable` if WhatsApp will not answer. Nothing is stored or logged. |
| `POST /sessions/:id/groups/refresh` | Reloads the enabled-group set from `whatsapp_groups`. The app calls it after the owner changes a group. 502 `groups_refresh_failed` if the load fails. |
| `POST /sessions/:id/send` with `groupJid` | Sends to an enabled group. Give exactly one of `to` or `groupJid` (both is 400 `invalid_body`). A `groupJid` that is not in the enabled set is 400 `group_not_enabled`. |
| `POST /sessions/:id/groups` | Creates a group. Body `{ requestId, name, description?, participants }` (`participants` are E.164 fallback members, up to 50). 200 `{ ok, jid, name, addedPhone, path, replayed? }` (`replayed: true` when a repeated `requestId` was served from the cache). |
| `GET /sessions/:id/groups/:jid` | Group details: `{ ok, group }`. `:jid` is URL-encoded. |
| `PATCH /sessions/:id/groups/:jid` | Body with at least one of `name` (1-100 characters), `description` (up to 512), `announcement`, `approval`. 200 `{ ok }`. |
| `POST /sessions/:id/groups/:jid/participants` | Body `{ action: "add", phones }` or `{ action: "remove" \| "promote" \| "demote", memberIds }` (1-50, never both lists). 200 `{ ok, results }`. |
| `GET /sessions/:id/groups/:jid/invite` | The invite link: `{ ok, link }`. |
| `POST /sessions/:id/groups/:jid/invite/reset` | Revokes the old link and returns the new one: `{ ok, link }`. |
| `POST /sessions/:id/groups/:jid/leave` | The number leaves the group. 200 `{ ok }`. |

Errors for the management routes: 400 `invalid_body`, `invalid_group_jid`, `group_not_enabled` or `too_many`; 409 `session_not_connected`; 403 `not_admin`; 422 `create_limit`, `add_limit`, `warmup` or `needs_member` (the fixed text is in `message`); 503 `limits_unavailable`; 502 `group_action_failed`.

### Group management limits and rules

| Variable | Default | Meaning |
| --- | --- | --- |
| `WA_GROUP_CREATE_DAILY` | `3` | Groups one number may create per UTC day |
| `WA_GROUP_ADD_DAILY` | `50` | People one number may add directly per UTC day |

- Limits count attempts. A create or add that reached WhatsApp is never
  refunded, even if it failed.
- A create tries an empty group first. If WhatsApp refuses, it retries with one
  eligible member (someone who messaged the number in the last 90 days). With
  nobody eligible it refuses with `needs_member`.
- A repeated create with the same `requestId` within 10 minutes returns the same
  result, marked `replayed: true`, and does not create a second group. Only a
  success, or a failure after WhatsApp's create was reached (the group may
  exist), is remembered. A refusal is never remembered: none made a group, so
  the same `requestId` runs the create again.
- Direct adds need the person to have messaged the number in the last 90 days.
  A missed call doesn't count (`event_kind` must be null).
  Warm-up refusals follow `WA_WARMUP_ENABLED` (off by default).
- Members are managed by `memberId` (from the group details). Phone numbers are
  only used to add. Removing the number's own member id is refused.
- Invites to a group are not sent by the bridge. The app sends them as normal
  messages, so pacing, the daily cap, STOP and the hold queue all apply.
- `scripts/group-sandbox.ts` walks the whole flow on a spare number. Run it by
  hand before go-live, never on a client's number.

A group send costs **5** daily-cap units (a normal send costs 1), and the
cap counts in-flight units, so a burst cannot overshoot it. The enabled-group
set fails closed: it is empty until it loads and after a failed load, so
group traffic is dropped, inbound and outbound, until a load succeeds.

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
  The poke also fires on every connection close (`recordClosed`), and once
  more 5 minutes 15 seconds after a close if the session is still not open
  (an `unref`'d timer, cancelled on open and at shutdown). The portal uses
  these to fire the "WhatsApp disconnected" / "WhatsApp reconnected" workflow
  triggers on time (`src/lib/session-triggers.ts`); the hourly cron is the
  backstop.
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

## Safety invariants (do not weaken)

- Send targets must already be strict E.164 — the bridge refuses, it never
  normalises (`src/phone.ts`; `test/phone-contract.test.ts` pins the contract
  byte-for-byte to the portal's `src/lib/phone.ts`).
- Every dispatch is preceded by `onWhatsApp()` and sent to the JID WhatsApp
  returns; recipients without WhatsApp end `not_on_whatsapp`, terminal.
- WhatsApp groups are opt-in (`src/groups.ts`). Only groups the owner enabled
  in `whatsapp_groups` pass, inbound or outbound; the bridge's in-memory set
  is empty until it loads (on connect and `POST /sessions/:id/groups/refresh`)
  and after a failed load, so unknown means dropped. A group send goes to the
  stored JID (from WhatsApp's own group list, `^[0-9]+(-[0-9]+)?@g\.us$`),
  replaces `onWhatsApp()` with a `groupMetadata()` participant check, and
  costs 5 daily-cap units. Group names and JIDs are never logged.
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
  RESERVED at accept time (`sentToday + in-flight units + queued units`,
  where in-flight is the send the worker is dispatching right now and a
  group send is 5 units), not only counted at
  dispatch time, so a burst of due sends arriving faster than the pacer can
  drain (e.g. an hourly cron finding dozens of steps due at once) cannot
  blow through the cap before any of them has actually dispatched. A ban
  lands on the client's real business number — that is why these defaults
  are conservative.
- Warm-up (`WA_WARMUP_ENABLED`, off by default): a newly linked number's
  daily cap ramps up with its age (`WARMUP_SCHEDULE` in `src/pacing.ts`:
  20/day for days 0-2, 50 for 3-6, 100 for 7-13, then `WA_DAILY_CAP`). Age
  comes from `whatsapp_sessions.phone_linked_at`, kept while the same number
  reconnects and cleared by `wipeCreds`. On connect the pacer assumes "linked
  now" until that read lands, so the gap is stricter, never looser. Leave it
  off while moving established numbers across: a re-scanned number counts as
  new.
- Before each outbound text part the worker shows "typing…" in the
  recipient's chat (`src/typing.ts`, `WA_TYPING_INDICATOR_ENABLED`,
  `WA_TYPING_MAX_MS`): 1s plus 30ms per character, ±20%, capped at 4s by
  default. It runs after the existence check (it needs WhatsApp's JID) and
  before the attempt is recorded. If the socket drops during the window the
  row fails as not dispatched, so it is safe to reissue. Presence errors are
  logged and never fail the send.
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
