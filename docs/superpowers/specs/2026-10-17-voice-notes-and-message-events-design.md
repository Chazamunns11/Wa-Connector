# Voice notes, quoted replies, edits, reactions and deletes: design

17 Oct 2026. Roadmap item F (`docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`). Draft for Charlie's review.

No GHL WhatsApp rival claims to sync reactions, quoted replies, edits or deletes into GHL Conversations, so this is a differentiator. Voice notes are expected (GoGHL, Wazzap, WAGHL all advertise them).

## What happens today

- **Inbound** (`services/whatsapp-bridge/src/inbound.ts`, filter step 5): `protocolMessage` (edits, deletes), `reactionMessage`, `pollUpdateMessage` and `editedMessage` wrappers are **dropped**. A quoted reply arrives as ordinary text; its quote (`contextInfo.quotedMessage`) is ignored.
- `whatsapp_inbound_messages.body` is capped at 500 characters.
- **Outbound audio** (`src/media.ts`): only genuine ogg/opus is sent as a voice note (`ptt: true`). Anything else goes as an audio file.

## The one rule that shapes everything

Anything posted to GHL as an **inbound message** fires GHL's "Customer replied" triggers. A 👍 reaction or a deleted message firing a sales follow-up workflow would be a bug that customers notice. So:

| Event | Posted to GHL as an inbound message? | Default |
|---|---|---|
| Quoted reply | Yes. It's a real reply. | On |
| Edit | Yes, as a new message. The contact really did send new text. | On |
| Reaction | Only if the account turns it on | **Off** |
| Delete for everyone | Only if the account turns it on | **Off** |

If GHL's API can add an **internal note or comment** to a conversation without firing reply triggers, reactions and deletes should go there instead and default on. Confirm this against GHL's Conversations API during planning. It's the first open question below.

## Rendering (fixed formats)

- **Quoted reply:** `↩ "<first 80 characters of the quoted text>"` on its own line, then the reply. If the quoted message has no text (media), `↩ (photo)`, `↩ (voice note)` and so on.
- **Edit:** `✏️ Edited: <new text>`.
- **Reaction:** `<emoji> reacted to "<first 80 characters of the original>"`. The original comes from `whatsapp_inbound_messages.body` when the contact reacted to their own message, and from the ledger otherwise. Outbound text isn't stored in the bridge ledger, so a reaction to one of our messages renders as `<emoji> reacted to your message`. A removed reaction (empty emoji) is ignored.
- **Delete:** `🗑 Deleted a message`.
- The prefix counts towards the 500-character body cap, and the reply text is truncated first.

## Bridge changes (`inbound.ts`)

- Step 5 stops dropping these types outright and classifies them instead: `{ kind: "event", event: "edit" | "reaction" | "delete", targetWaMessageId, text?, emoji? }`. Polls stay dropped.
- Wrappers at every depth are still checked before normalisation (the existing `containsRejectedContentAtAnyDepth` reasoning applies unchanged).
- A new column `whatsapp_inbound_messages.event_kind text null check (event_kind in ('edit','reaction','delete'))` plus `target_wa_message_id text null`. Event rows use their own `wa_message_id`, so the `(coach_id, wa_message_id)` dedupe still holds.
- Feature flag `WA_INBOUND_EVENTS_ENABLED` (default off until tested on a real account), so the current behaviour is the off state.

## App changes (`src/lib/ghl-inbound.ts`)

- The drain renders event rows with the formats above before `addGhlInboundMessage`.
- Reactions and deletes are skipped (marked with a new resolution, `event_suppressed`) unless the account's setting allows them.
- Account settings: two toggles on the dashboard, "Show reactions in GHL" and "Show deleted-message notices in GHL", each with the line "These appear as new messages and can trigger 'Customer replied' workflows."

## Outbound voice notes

- When GHL sends an audio attachment that isn't ogg/opus (GHL's own recorder output: confirm whether it's webm or mp3), the bridge transcodes it to ogg/opus and sends it with `ptt: true`, so it shows as a voice note with a waveform.
- Transcoding uses ffmpeg, so the Railway image needs it. Run it as a child process with a hard timeout (10 seconds) and an input size cap (the existing `WA_MEDIA_MAX_AUDIO_BYTES`). It reads from a buffer, never a URL. Any failure falls back to today's behaviour (send as an audio file), never to a failed message.
- Flag `WA_VOICE_TRANSCODE_ENABLED`, default off until ffmpeg is in the image.

## Tests (to be planned)

- Classifier: each event type at top level and inside ephemeral and view-once wrappers; a removed reaction is ignored; polls still dropped.
- Rendering: each format, truncation to 500 characters, media quote placeholders, reaction to an outbound message.
- Suppression: reactions and deletes skipped when the setting is off, posted when on.
- Transcode: a webm input becomes ogg/opus with `ptt: true`; a timeout or corrupt input falls back to a plain audio send; oversized input is refused before ffmpeg runs.

## Open questions for planning

1. Can GHL's Conversations API post an internal comment that doesn't fire reply triggers?
2. What format does GHL's in-app voice recorder produce?
3. Do edits of our own outbound messages (made on the phone) need syncing? Proposed: no. `fromMe` stays dropped.
