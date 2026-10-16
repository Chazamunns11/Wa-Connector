/**
 * Inbound WhatsApp message handling — Batch 1 of the reply/auto-stop/trigger
 * package (see the architecture plan, "Inbound WhatsApp: replies,
 * auto-stop-on-reply, and the whatsapp_reply trigger"). This module owns the
 * filter chain that turns Baileys' firehose (`messages.upsert` sees EVERY
 * message the linked device sends or receives, including our own bridge's
 * echoes, group chatter, status updates, reactions, edits, and offline
 * history backfill) into "genuine 1:1 replies from the prospect", plus the
 * ledger-gated write to `whatsapp_inbound_messages` (0048) and the
 * contentless poke that tells the portal to drain them.
 *
 * DESIGN: `classifyInboundMessage` is PURE — no Supabase, no HTTP, no
 * Baileys socket calls — so it is unit-testable with fabricated `WAMessage`
 * objects exactly like the rest of this package's suite (hard rule 5: no
 * network, no WhatsApp). `processInboundBatch` is the one impure function
 * here, and it takes its side effects as injected `InboundDeps` rather than
 * reaching for a store/poke singleton, so it too can be tested against fakes
 * without constructing a real `SessionManager`/`BridgeStore`.
 *
 * THE FILTER CHAIN, IN ORDER (each step's rejection reason is logged — never
 * the JID or the body, matching this package's "never log credential- or
 * conversation-adjacent detail" posture):
 *
 *   1. `type === 'append'` -> RECENCY-GATED, not a blanket drop (adversarial-
 *      review fix — see below). Baileys stamps EVERY batch delivered while
 *      `node.attrs.offline` was true as `'append'`, and that covers TWO very
 *      different things: (a) first-link HISTORY BACKFILL, which can be
 *      months old, and (b) genuine messages WhatsApp queued at its own
 *      servers while this bridge was briefly disconnected — which, for a
 *      hosted bridge, is routine (every Railway deploy/restart bounces the
 *      socket for seconds to low minutes). The ORIGINAL design dropped
 *      `'append'` wholesale to avoid (a), but that silently ate every genuine
 *      reply that happened to land during (b) — no row, no auto-stop, no
 *      redelivery ever (WhatsApp only offers a message once it's been acked).
 *      The fix: an `'append'` message is still processed as a candidate
 *      reply IFF its own `messageTimestamp` is within `APPEND_RECENCY_MS` of
 *      "now" — recent enough to plausibly be a missed-while-down message,
 *      not old enough to be history backfill. Anything else with
 *      `type !== 'notify'` (i.e. an `'append'` message older than the
 *      recency window, or any future Baileys type this code doesn't know
 *      about) is still dropped wholesale, unstored, unforwarded — this
 *      remains the single most dangerous default to get wrong, so it is
 *      still checked first, before anything else.
 *   2. `key.fromMe === true` -> drop (hard rule 3). Baileys stamps this
 *      reliably for the linked device's own sends — including a coach
 *      texting their own prospect by hand, AND our own bridge's
 *      `sock.sendMessage` calls echoing back through this same event.
 *      Neither is a reply.
 *   3. `remoteJid` must be a 1:1 chat: `isPnUser(jid) || isLidUser(jid)`.
 *      (`isPnUser` is Baileys 7.x's rename of what 6.7.x called `isJidUser`
 *      — byte-identical predicate, `jid?.endsWith('@s.whatsapp.net')`; do
 *      NOT reach for `isLidUser` alone here, tsc's "did you mean" suggestion
 *      when the old name goes missing is a trap — a PN-only check would
 *      silently stop accepting the phone-addressed side of every 1:1 chat.)
 *      This is, by construction (different JID server suffixes — see
 *      WABinary/jid-utils), already exclusive of groups (`@g.us`), status
 *      broadcasts and the general broadcast list (`isJidStatusBroadcast` /
 *      `isJidBroadcast`), newsletters, and bot JIDs — a reply from any of
 *      those shapes never reaches the phone-mapping step at all.
 *   4. `!msg.message` -> drop. A pure stub/system row (e.g. a "message
 *      deleted for everyone" placeholder with `messageStubType` set) carries
 *      no `message` payload whatsoever.
 *   5. Content-key check BEFORE normalisation, AT EVERY WRAPPER DEPTH
 *      (`containsRejectedContentAtAnyDepth` — adversarial-review fix, lens 2
 *      finding 4): `protocolMessage` (edits/revokes/app-state),
 *      `reactionMessage`, `pollUpdateMessage`, or an `editedMessage` wrapper
 *      all drop here, whether they appear at the TOP level or hidden behind
 *      any depth of `ephemeralMessage`/`viewOnceMessage(V2/V2Extension)`/
 *      `documentWithCaptionMessage` wrapping. Order matters: Baileys'
 *      `normalizeMessageContent` unwraps ALL of those wrapper types
 *      (`editedMessage` included) on the way to genuine content, so an edit
 *      hidden one layer inside an ephemeral wrapper would otherwise
 *      masquerade as a brand-new reply if only the top level were checked,
 *      or if the check ran after normalisation had already stripped the
 *      `editedMessage` layer away.
 *   6. `normalizeMessageContent` (unwraps `ephemeralMessage` / `viewOnceMessage`
 *      wrappers — a disappearing-mode reply is still a reply) then
 *      `getContentType`. A message whose only field is something Baileys
 *      itself never surfaces a content type for (e.g. a bare
 *      `senderKeyDistributionMessage` with nothing else) drops here too.
 *      Text is extracted as `conversation ?? extendedTextMessage.text`;
 *      anything else (voice note, image, sticker, …) is STILL a genuine
 *      reply — recorded with `body = null` and `messageType` set to whatever
 *      content-type key Baileys reports, because auto-stop must fire when a
 *      prospect answers with a voice note, which is extremely common.
 *
 *      MEDIA PLAN (docs/MEDIA-PLAN.md §6) — a message surviving to this point
 *      whose content type is `imageMessage`/`videoMessage`/`audioMessage`/
 *      `documentMessage` ALSO gets `InboundReply.mediaRef` populated with the
 *      raw downloadable descriptor (`mediaKey`/`directPath`/`url`) plus the
 *      SENDER'S CLAIMED mimetype/length (both untrusted — see
 *      `src/media.ts`'s sniffing note). `stickerMessage` is deliberately
 *      EXCLUDED from this set (plan decision: stickers are noise, never
 *      captured) — `mediaRef` simply stays `null` for it, same as any
 *      non-capturable type. View-once media (plan decision: the sender chose
 *      ephemerality) is ALSO excluded — `isViewOnceAtAnyDepth` (below) checks
 *      for a view-once wrapper BEFORE normalisation strips it away, mirroring
 *      `containsRejectedContentAtAnyDepth`'s own recursive-wrapper-check
 *      shape. Populating this is PURE — no download happens here; the actual
 *      fetch/sniff/store pipeline (`src/media-capture.ts`) only ever runs
 *      when `processInboundBatch` decides this row is eligible (ghl_location
 *      tenant + `WA_MEDIA_INBOUND_ENABLED` + a non-null `mediaRef`).
 *   7. JID -> E.164 (the Phase 0 contract, never loosened; see
 *      `resolveSenderE164`). Baileys 7.x removed `key.senderPn` (the 6.7.x
 *      field this used to read) — the replacement is `key.remoteJidAlt`,
 *      and it is BIDIRECTIONAL: on a LID-addressed message it holds the
 *      sender's PN, but on a PN-addressed message it holds the sender's LID
 *      instead. A phone-JID `remoteJid` (`@s.whatsapp.net`) therefore yields
 *      `+${user}` DIRECTLY and never consults `remoteJidAlt` at all (it
 *      would be the LID on that path, not a second phone number). A
 *      LID-JID `remoteJid` (`@lid`) has no phone number of its own — it
 *      must take `remoteJidAlt` instead, but ONLY once that alt has ITSELF
 *      been decoded and confirmed to end in `@s.whatsapp.net`.
 *
 *      THE TRAP THIS SERVER-SUFFIX CHECK PREVENTS: a WhatsApp LID user
 *      string is <=15 digits, so `+` + a bare LID digit-string PASSES this
 *      bridge's own `isE164` regex (`+159553891131584` matches
 *      `^\+[1-9]\d{6,14}$` — test/phone-contract.test.ts pins this as a
 *      permanent regression case). `isE164` alone therefore CANNOT
 *      distinguish a real phone number from a fabricated one built out of a
 *      LID — only the JID's own server suffix can, which is why
 *      `resolveSenderE164` decodes and checks `.server` before ever
 *      building a `+` candidate, and never trusts Baileys' `addressingMode`
 *      string (attacker/server-supplied metadata, not a structural
 *      guarantee) as a substitute for that check. Skipping this and reading
 *      whatever "looks like an alt phone field" would, with the right
 *      inbound message, file a client's replies under a fabricated phone
 *      number that happens to satisfy every downstream validator.
 *
 *      A LID message with no alt that passes this check is not necessarily
 *      unmappable forever: `classifyInboundMessage` returns a distinct
 *      `needs_lid_resolution` outcome for it, and `processInboundBatch` gets
 *      one more shot via the optional `InboundDeps.resolvePnForLid` (backed
 *      by Baileys' own `LIDMappingStore` — see sessions.ts) BEFORE finally
 *      giving up. Either way, the RESULT must still pass this bridge's own
 *      strict `isE164` (src/phone.ts) — no normalisation, no repair, exactly
 *      the 0045 contract. Guessing wrong here would message (or worse,
 *      attribute a reply to) a stranger.
 *
 * THE LEDGER GATE (privacy — hard rule 4, and its own file-header note in
 * 0048): even a message that survives every step above is dropped, unstored
 * and unforwarded, unless this coach's OWN send ledger
 * (`whatsapp_messages`, 0046) shows a `status = 'sent'` row to this exact
 * phone number (`BridgeStore.wasProspectSent`). The linked WhatsApp number is
 * the coach's REAL PERSONAL PHONE — family, friends, and existing clients
 * all message it too. Only threads the PORTAL itself opened are eligible to
 * ever enter this database. `ProspectLedgerCache` exists purely so this
 * check is not one Supabase query per inbound message — it is not a
 * correctness mechanism (the DB read behind it is still the source of
 * truth), only a hot-path optimisation. Its negative-result TTL is
 * deliberately short (adversarial-review fix, lens 2 finding 5) and is also
 * proactively CLEARED the instant this coach's own session confirms a send
 * to a number (`ProspectLedgerCache.markSent`, called from `sessions.ts`'s
 * dispatch path) — without that, a prospect who DMs cold seconds before the
 * portal's own sequence messages them for the first time could have their
 * very next reply swallowed by a stale cached "not eligible" answer.
 *
 * GHL CUSTOM CONVERSATION PROVIDER, PHASE 3 AMENDMENT (docs/GHL-PROVIDER-PLAN.md,
 * decision D4) — the ledger gate above is SKIPPED for a `kind = 'ghl_location'`
 * session (`InboundDeps.bypassLedgerGate`, read once at session start from
 * `whatsapp_tenants.kind` — see `sessions.ts`'s `doStartSession`). This is
 * the ONLY safety invariant in this package Phase 3 is permitted to change —
 * see `processInboundBatch`'s own in-code comment at the branch for the full
 * scope/rationale argument, and this package's README "Safety invariants"
 * section for the amended, restated invariant. Every OTHER step in this
 * filter chain (1-7 above) is untouched for every session, GHL or coach.
 *
 * DEDUPE: Baileys redelivers on reconnect/offline-resync, so intake must be
 * idempotent on `key.id`. The AUTHORITATIVE mechanism is 0048's unique
 * `(coach_id, wa_message_id)` constraint — `BridgeStore.recordInboundMessage`
 * inserts-or-ignores against it and reports `fresh: false` on a duplicate
 * (the exact `acceptMessage` shape this package already uses for the send
 * ledger, 0046). `processInboundBatch` only pokes the portal when a row was
 * genuinely fresh, so a redelivered message becomes a harmless silent no-op
 * rather than a second poke or a second anything.
 */
import {
  getContentType,
  isLidUser,
  isPnUser,
  jidDecode,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import type { MessageUpsertType, WAMessage } from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import { isE164 } from "./phone.js";

/** Fixed-string drop reasons — logged, never the JID or body (see file header). */
export type InboundDropReason =
  | "not_notify"
  | "stale_history_backfill"
  | "from_me"
  | "not_one_to_one"
  | "no_content"
  | "edit_reaction_or_system"
  | "unmappable_sender";

/** Baileys' own download-type vocabulary (`downloadContentFromMessage`'s second argument) for the four content types the media plan ever captures. */
export type InboundMediaKind = "image" | "video" | "audio" | "document";

/**
 * Media plan (docs/MEDIA-PLAN.md §6) — the raw, UNTRUSTED descriptor needed
 * to download this message's media later, plus the sender's own claims
 * (never trusted for classification — see `src/media.ts`'s sniffing note).
 * `null` on `InboundReply.mediaRef` means "not a capturable type" (text,
 * sticker, or a view-once-wrapped media message) — the capture pipeline
 * never runs for those regardless of any other flag/tenant-kind check.
 */
export interface InboundMediaRef {
  kind: InboundMediaKind;
  /** `{ mediaKey, directPath, url }` exactly as Baileys' `DownloadableMessage` shape wants it — opaque to this module. */
  downloadable: { mediaKey?: Uint8Array | null; directPath?: string | null; url?: string | null };
  /** The sender's claimed mimetype — a hint only; the capture pipeline sniffs magic bytes and never trusts this. */
  claimedMimetype: string | null;
  /** The sender's claimed byte length (Baileys' `fileLength`, when present) — informational only; the actual download is still byte-capped regardless. */
  claimedFileLength: number | null;
}

/** A genuine, filter-surviving inbound reply — everything `recordInboundMessage` needs. */
export interface InboundReply {
  /** Strict E.164 — the Phase 0 contract, never loosened. */
  fromPhone: string;
  /** Baileys' own message id (`key.id`) — the dedupe key. */
  waMessageId: string;
  /** ISO timestamp — from Baileys' `messageTimestamp` when present, else "now". */
  receivedAt: string;
  /** Truncated to 500 chars (0048's CHECK) — null for a non-text message. */
  body: string | null;
  /** The Baileys content-type key (`'conversation'`, `'imageMessage'`, …). */
  messageType: string;
  /** Media plan (docs/MEDIA-PLAN.md §6) — see `InboundMediaRef`'s own JSDoc. `null` for text, stickers, and view-once media. */
  mediaRef: InboundMediaRef | null;
}

/**
 * `needs_lid_resolution` — a LID-routed 1:1 message (file header step 7)
 * that survived every OTHER filter but has no alt directly usable as a
 * phone number. `classifyInboundMessage` stays PURE and synchronous (module
 * header) so it cannot itself attempt the async `resolvePnForLid` lookup —
 * it hands back everything ELSE about the message (`pending`, everything
 * `InboundReply` needs except `fromPhone`) so `processInboundBatch` can
 * finish the job with one more resolution attempt before finally dropping
 * it as `unmappable_sender`. `lidJid` is `remoteJid` itself (already known
 * to end `@lid` — this is the only kind for which that's true).
 */
export type ClassifyResult =
  | { kind: "reply"; reply: InboundReply }
  | { kind: "dropped"; reason: InboundDropReason }
  | { kind: "needs_lid_resolution"; lidJid: string; pending: Omit<InboundReply, "fromPhone"> };

const MAX_BODY_CHARS = 500;

/**
 * How recent an `'append'`-type message's own `messageTimestamp` must be to
 * be treated as offline-resync rather than history backfill (file header
 * step 1). Generous relative to a routine Railway deploy/restart (seconds to
 * low minutes of downtime); tiny relative to "weeks-old first-link history",
 * which is what this window still exists to keep dropping.
 */
const APPEND_RECENCY_MS = 15 * 60_000;

/**
 * Content-type keys that must be rejected BEFORE `normalizeMessageContent`
 * runs — see file header step 5 for why the ordering (raw check first) is
 * load-bearing rather than cosmetic.
 */
const PRE_NORMALISE_REJECT_KEYS: ReadonlySet<string> = new Set([
  "protocolMessage",
  "reactionMessage",
  "pollUpdateMessage",
  "editedMessage",
]);

/**
 * Wrapper keys `normalizeMessageContent` unwraps TRANSPARENTLY on the way to
 * genuine content (i.e. the wrapped content keeps being whatever it really
 * is — an ephemeral text message is still just text). `editedMessage` is
 * deliberately NOT in this set even though Baileys' own normaliser also
 * unwraps it: unlike the others, an edit's wrapped content must never be
 * treated as fresh (it's already caught directly by `PRE_NORMALISE_REJECT_KEYS`
 * at whatever layer it appears).
 *
 * `associatedChildMessage`, `groupStatusMessage`, and `groupStatusMessageV2`
 * are Baileys 7.x additions — verified against this bridge's own installed
 * `lib/Utils/messages.js`, whose `normalizeMessageContent` unwraps all three
 * exactly like `ephemeralMessage`/`viewOnceMessage*`. Omitting them here
 * would NOT make messages wrapped in them un-unwrappable (Baileys still
 * unwraps them either way) — it would only make `containsRejectedContentAtAnyDepth`
 * and `isViewOnceAtAnyDepth` (below) blind to that depth: an `editedMessage`
 * nested inside e.g. `{ associatedChildMessage: { message: { editedMessage:
 * {...} } } }` would sail past the pre-normalisation reject check (which only
 * recurses through the wrappers THIS list knows about), get unwrapped by
 * Baileys' normaliser anyway, and surface its own inner content as if it
 * were a brand-new reply — the exact "edit masquerading as fresh" failure
 * mode `containsRejectedContentAtAnyDepth`'s own JSDoc already documents for
 * `ephemeralMessage`, just reached via a wrapper this set didn't know about
 * yet.
 */
const TRANSPARENT_WRAPPER_KEYS: readonly string[] = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
];

/**
 * Adversarial-review fix (lens 2, finding 4) — the original check only
 * inspected `msg.message`'s TOP-LEVEL keys, so `{ ephemeralMessage: {
 * message: { editedMessage: {...} } } }` (an edit inside a disappearing-mode
 * chat) sailed past it: `normalizeMessageContent` would unwrap the
 * `ephemeralMessage` layer, hit `editedMessage` — ALSO one of the wrapper
 * types Baileys' own normaliser transparently unwraps — and keep going,
 * surfacing the edit's OWN inner content (e.g. plain `conversation` text) as
 * if it were a brand-new reply, with a content-type key that no longer even
 * mentions `editedMessage` for a post-normalisation check to catch. This
 * function recurses through the SAME transparent wrappers Baileys' own
 * normaliser does, checking for a reject-listed key AT EVERY LAYER on the
 * way down — so an edit/protocol/reaction/poll hidden behind any depth of
 * ephemeral/view-once/document-with-caption wrapping is rejected the moment
 * it's found, before ever reaching whatever it wraps. Depth-capped at 5,
 * mirroring `normalizeMessageContent`'s own unwrap limit — matching Baileys'
 * own bound rather than inventing a different one.
 */
function containsRejectedContentAtAnyDepth(message: object, depth = 0): boolean {
  if (depth > 5) return false;
  const asRecord = message as Record<string, unknown>;
  const keys = Object.keys(asRecord);
  if (keys.some((key) => PRE_NORMALISE_REJECT_KEYS.has(key))) return true;
  for (const wrapperKey of TRANSPARENT_WRAPPER_KEYS) {
    const wrapped = asRecord[wrapperKey] as { message?: unknown } | undefined;
    const inner = wrapped?.message;
    if (inner && typeof inner === "object") {
      if (containsRejectedContentAtAnyDepth(inner as Record<string, unknown>, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Media plan (docs/MEDIA-PLAN.md §6.3) — content-type keys eligible for
 * capture, mapped to Baileys' download-type vocabulary. `stickerMessage` is
 * deliberately absent (decision: stickers are noise, never captured) — every
 * OTHER content type this bridge ever records (`conversation`,
 * `extendedTextMessage`, anything unrecognised) simply has no entry here,
 * which is exactly "not capturable".
 */
const CAPTURABLE_CONTENT_TYPES: Readonly<Record<string, InboundMediaKind>> = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
};

/** The same three view-once wrapper keys `TRANSPARENT_WRAPPER_KEYS` already knows about — split out so the media-capture check can name them without also matching `ephemeralMessage`/`documentWithCaptionMessage` (a disappearing-mode OR captioned-document reply is still capturable; a view-once one is not — plan §6.3's stated decision). */
const VIEW_ONCE_WRAPPER_KEYS: readonly string[] = ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"];

/**
 * Media plan (docs/MEDIA-PLAN.md §6.3) — "View-once media: not stored
 * (decision: the sender chose ephemerality; persisting it to a CRM is the
 * one clearly wrong call)". `normalizeMessageContent` unwraps a view-once
 * wrapper transparently on the way to the real content type, so by the time
 * `getContentType` sees `imageMessage` it can no longer tell the wrapper was
 * ever there — this function checks BEFORE normalisation, recursing through
 * the same transparent-wrapper set `containsRejectedContentAtAnyDepth` does
 * (an ephemeral, view-once photo is still view-once), so it is found at
 * whatever depth it appears. Depth-capped at 5, same bound as its sibling.
 */
function isViewOnceAtAnyDepth(message: object, depth = 0): boolean {
  if (depth > 5) return false;
  const asRecord = message as Record<string, unknown>;
  if (VIEW_ONCE_WRAPPER_KEYS.some((key) => key in asRecord)) return true;
  for (const wrapperKey of TRANSPARENT_WRAPPER_KEYS) {
    const wrapped = asRecord[wrapperKey] as { message?: unknown } | undefined;
    const inner = wrapped?.message;
    if (inner && typeof inner === "object") {
      if (isViewOnceAtAnyDepth(inner as Record<string, unknown>, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Builds `InboundReply.mediaRef` for a content type in `CAPTURABLE_CONTENT_TYPES`
 * — `null` for anything else, or when the raw message was view-once-wrapped
 * (checked by the caller before this is invoked). Reads the sender's own
 * claimed `mimetype`/`fileLength` off the normalised content object — both
 * are UNTRUSTED hints only (see `InboundMediaRef`'s own JSDoc).
 */
function buildMediaRef(contentType: string, content: unknown): InboundMediaRef | null {
  const kind = CAPTURABLE_CONTENT_TYPES[contentType];
  if (!kind) return null;
  const media = content as {
    mediaKey?: Uint8Array | null;
    directPath?: string | null;
    url?: string | null;
    mimetype?: string | null;
    fileLength?: number | { toNumber?: () => number } | null;
  };
  return {
    kind,
    downloadable: { mediaKey: media.mediaKey ?? null, directPath: media.directPath ?? null, url: media.url ?? null },
    claimedMimetype: media.mimetype ?? null,
    claimedFileLength: coerceFileLength(media.fileLength),
  };
}

/** `fileLength` is `number | Long | null` in the Baileys protobuf, same shape as `messageTimestamp` — see `timestampToMs` for why `Long`-like objects need `.toNumber()` rather than a raw `Number()` cast. */
function coerceFileLength(value: number | { toNumber?: () => number } | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/** Pure classifier — see the file header for the full, ordered filter chain. */
export function classifyInboundMessage(msg: WAMessage, batchType: MessageUpsertType): ClassifyResult {
  if (batchType !== "notify") {
    // Anything that isn't 'notify' and isn't 'append' either (there is no
    // third value today, but never assume the union can't grow) is dropped
    // outright — same as the original behaviour.
    if (batchType !== "append") return { kind: "dropped", reason: "not_notify" };
    // 'append' — recency-gated, see file header step 1. A stale timestamp
    // (or none at all, which `timestampToMs` also treats as unusable here)
    // means this is history backfill, not a missed live message — still
    // dropped wholesale.
    const tsMs = timestampToMs(msg.messageTimestamp);
    if (tsMs === null || Date.now() - tsMs > APPEND_RECENCY_MS) {
      return { kind: "dropped", reason: "stale_history_backfill" };
    }
    // Recent enough to be a genuine offline-resync reply — fall through and
    // run the exact same filter chain a 'notify' message would.
  }
  if (msg.key.fromMe) return { kind: "dropped", reason: "from_me" };

  const remoteJid = msg.key.remoteJid ?? undefined;
  if (!remoteJid) return { kind: "dropped", reason: "not_one_to_one" };
  if (!isPnUser(remoteJid) && !isLidUser(remoteJid)) {
    // Excludes groups, status/general broadcast, newsletters, and bots by
    // construction — see file header step 3. `isPnUser` (NOT `isLidUser`
    // alone — see that step's own comment) is Baileys 7.x's rename of what
    // 6.7.x exported as `isJidUser`; same predicate, new name.
    return { kind: "dropped", reason: "not_one_to_one" };
  }

  if (!msg.message) return { kind: "dropped", reason: "no_content" }; // stub/system row.

  // Step 5 — see `containsRejectedContentAtAnyDepth`'s own JSDoc (adversarial-
  // review fix, lens 2 finding 4): recurses through the same transparent
  // wrappers `normalizeMessageContent` itself would, so an edit/protocol/
  // reaction/poll hidden behind any depth of ephemeral/view-once/document
  // wrapping is caught here, BEFORE normalisation ever runs — not just at
  // the top level.
  if (containsRejectedContentAtAnyDepth(msg.message)) {
    return { kind: "dropped", reason: "edit_reaction_or_system" };
  }

  const normalised = normalizeMessageContent(msg.message);
  const contentType = normalised ? getContentType(normalised) : undefined;
  if (!normalised || !contentType) return { kind: "dropped", reason: "no_content" };
  // Belt-and-braces: a content-type key that STILL matches the reject set
  // after normalisation (possible if some future Baileys version surfaces
  // one differently than the recursive check above anticipates) is caught
  // here too — never rely on only one of these two checks.
  if (PRE_NORMALISE_REJECT_KEYS.has(contentType)) {
    return { kind: "dropped", reason: "edit_reaction_or_system" };
  }

  const waMessageId = msg.key.id;
  if (!waMessageId) return { kind: "dropped", reason: "no_content" }; // should be impossible in practice; never persist without a dedupe key.

  const text = normalised.conversation ?? normalised.extendedTextMessage?.text ?? null;
  const body = text ? sanitizeBody(text) : null;

  // Media plan (docs/MEDIA-PLAN.md §6.3) — view-once media is never
  // captured regardless of content type (checked on the RAW pre-normalised
  // message, since normalisation already stripped the wrapper away by this
  // point). Everything else about this reply (body/messageType/dedupe) is
  // completely unaffected — only `mediaRef` is forced null.
  const mediaRef = isViewOnceAtAnyDepth(msg.message) ? null : buildMediaRef(contentType, normalised[contentType as keyof typeof normalised]);

  const pending: Omit<InboundReply, "fromPhone"> = {
    waMessageId,
    receivedAt: timestampToIso(msg.messageTimestamp),
    body,
    messageType: contentType,
    mediaRef,
  };

  const resolution = resolveSenderE164(remoteJid, msg.key.remoteJidAlt ?? undefined);
  if (resolution.kind === "unmappable") return { kind: "dropped", reason: "unmappable_sender" };
  if (resolution.kind === "unresolved_lid") {
    // See file header step 7 / `ClassifyResult`'s own JSDoc — this classifier
    // stays pure/synchronous, so the LAST resort (`InboundDeps.resolvePnForLid`)
    // is `processInboundBatch`'s job, not this function's.
    return { kind: "needs_lid_resolution", lidJid: remoteJid, pending };
  }

  return { kind: "reply", reply: { ...pending, fromPhone: resolution.phone } };
}

/**
 * The result of trying to turn a message's `remoteJid` (+ its possibly
 * BIDIRECTIONAL `remoteJidAlt` — see file header step 7) into the strict
 * E.164 this bridge stores. `"unresolved_lid"` is deliberately NOT `null` —
 * it is a distinct outcome from `"unmappable"` because, unlike a genuine
 * dead end, `processInboundBatch` gets one more resolution attempt for it
 * (`InboundDeps.resolvePnForLid`) before the message is finally dropped.
 */
type SenderResolution = { kind: "resolved"; phone: string } | { kind: "unresolved_lid" } | { kind: "unmappable" };

/**
 * THE ONE PLACE a `s.whatsapp.net`-suffixed JID is ever turned into the
 * strict E.164 this bridge stores — used identically by every caller in
 * this file (a directly PN-addressed `remoteJid`, a LID message's
 * already-server-checked `remoteJidAlt`, and `processInboundBatch`'s
 * `resolvePnForLid` result) so there is exactly one server-check-then-gate
 * implementation to get right, not three. `null` for anything whose server
 * suffix isn't `s.whatsapp.net` (see file header's "THE TRAP" paragraph for
 * why that check runs BEFORE `isE164` ever sees a candidate, not instead of
 * it) or whose resulting `+${user}` still fails this bridge's own strict
 * `isE164` gate (src/phone.ts) — this bridge REFUSES, it never repairs.
 */
function pnJidToE164(jid: string): string | null {
  const decoded = jidDecode(jid);
  if (decoded?.server !== "s.whatsapp.net") return null;
  const candidate = `+${decoded.user}`;
  return isE164(candidate) ? candidate : null;
}

/**
 * Resolution order (file header step 7 — never loosen this):
 *
 *   1. `remoteJid` itself decodes to `s.whatsapp.net` -> `pnJidToE164(remoteJid)`
 *      directly. `remoteJidAlt` is NEVER consulted on this path — on a
 *      PN-addressed message it holds the sender's LID, not a second phone
 *      number (`remoteJidAlt` is bidirectional; see file header).
 *   2. `remoteJid` decodes to `lid` AND `remoteJidAlt` is present AND
 *      `remoteJidAlt` ITSELF decodes to `s.whatsapp.net` -> `pnJidToE164(remoteJidAlt)`.
 *      This is the wire's own answer — if `pnJidToE164` still rejects it
 *      (fails `isE164`), that is a FIRM `"unmappable"`, not a reason to
 *      fall through to case 3: a `s.whatsapp.net`-suffixed JID already told
 *      us who the sender is; a store lookup could never contradict that,
 *      only fail to improve on it.
 *   3. Anything else on the `lid` path (alt absent, or alt itself decodes to
 *      some OTHER server — most notably `@lid`, THE TRAP this whole function
 *      exists to close: a bare LID digit-string passes `isE164` on its own,
 *      see file header) -> `"unresolved_lid"`, not a bare failure. This is
 *      the only case `processInboundBatch` gets a further resolution
 *      attempt for.
 *
 * Trust the JID's own decoded `.server` suffix at every step — NEVER
 * `msg.key.addressingMode` (attacker/server-supplied metadata, not a
 * structural guarantee) as a substitute for actually decoding the JID being
 * consulted.
 */
function resolveSenderE164(remoteJid: string, remoteJidAlt: string | undefined): SenderResolution {
  const decoded = jidDecode(remoteJid);
  if (!decoded) return { kind: "unmappable" };

  if (decoded.server === "s.whatsapp.net") {
    const phone = pnJidToE164(remoteJid);
    return phone ? { kind: "resolved", phone } : { kind: "unmappable" };
  }

  if (decoded.server === "lid") {
    if (remoteJidAlt) {
      const altDecoded = jidDecode(remoteJidAlt);
      if (altDecoded?.server === "s.whatsapp.net") {
        const phone = pnJidToE164(remoteJidAlt);
        return phone ? { kind: "resolved", phone } : { kind: "unmappable" };
      }
    }
    return { kind: "unresolved_lid" };
  }

  return { kind: "unmappable" };
}

/**
 * Baileys' `messageTimestamp` is `number | Long | null` (protobuf int64) —
 * never assume `number`. Returns epoch milliseconds, or `null` when the
 * field is absent/unparseable/non-positive — the ONE case that matters to
 * the `'append'` recency gate above (step 1): "we cannot tell how old this
 * is" must be treated as "assume it's old", never as "now".
 */
function timestampToMs(ts: unknown): number | null {
  if (ts === null || ts === undefined) return null;
  let seconds: number;
  if (typeof ts === "number") {
    seconds = ts;
  } else if (typeof ts === "object" && typeof (ts as { toNumber?: unknown }).toNumber === "function") {
    seconds = (ts as { toNumber: () => number }).toNumber();
  } else {
    seconds = Number(ts);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/** `timestampToMs`, defaulting to "now" — used once a message has already survived recency gating and just needs an ISO stamp for `InboundReply.receivedAt`. */
function timestampToIso(ts: unknown): string {
  const ms = timestampToMs(ts);
  return new Date(ms ?? Date.now()).toISOString();
}

/**
 * Adversarial-review fix (lens 1, finding 1) — a body containing a NUL byte,
 * or one truncated mid-surrogate-pair, makes the Supabase INSERT fail with a
 * non-`23505` error. `processInboundBatch`'s catch-all then drops the WHOLE
 * message silently and permanently (no redelivery — WhatsApp never re-offers
 * an already-acked message), taking auto-stop down with it. Postgres `text`
 * cannot store a NUL byte at all, and naive `.slice(0, N)` on a UTF-16 string
 * can split an astral character (any emoji outside the BMP) into a lone
 * trailing surrogate, which Postgres's UTF-8 encoder also rejects.
 * `Array.from` iterates BY CODE POINT (each surrogate pair counts as one
 * element), so slicing that array can never produce a lone surrogate — and
 * it also matches 0048's CHECK constraint semantics (`char_length(body) <=
 * 500`, itself code-point-based, not UTF-16-code-unit-based) more precisely
 * than the original `.slice` did.
 */
function sanitizeBody(text: string): string {
  // NUL_CHAR is built at runtime (String.fromCharCode), never typed as a
  // literal/escaped control character in this source file.
  const NUL_CHAR = String.fromCharCode(0);
  const noNul = text.split(NUL_CHAR).join("");
  return Array.from(noNul).slice(0, MAX_BODY_CHARS).join("");
}

// ---------------------------------------------------------------------------
// Ledger gate cache — see file header. NOT a correctness mechanism: a cache
// miss (or a false negative that hasn't expired yet) just costs one extra
// Supabase read next time; it can never turn an ineligible sender eligible.
// ---------------------------------------------------------------------------

/**
 * Per-session cache in front of `BridgeStore.wasProspectSent`. A coach
 * cannot "un-send" a message, so a positive result is cached forever; a
 * negative result (this number has never been sent to) is cached only
 * briefly, so a genuine first-contact send moments later is still picked up
 * promptly rather than blocked by a stale negative for the cache's whole
 * lifetime.
 */
export class ProspectLedgerCache {
  private readonly confirmed = new Set<string>();
  private readonly negativeUntil = new Map<string, number>();

  constructor(private readonly negativeTtlMs: number = 5 * 60_000) {}

  async check(coachId: string, phone: string, lookup: (coachId: string, phone: string) => Promise<boolean>): Promise<boolean> {
    const key = `${coachId}:${phone}`;
    if (this.confirmed.has(key)) return true;
    const negExpiry = this.negativeUntil.get(key);
    if (negExpiry !== undefined && negExpiry > Date.now()) return false;

    const result = await lookup(coachId, phone);
    if (result) {
      this.confirmed.add(key);
      this.negativeUntil.delete(key);
    } else {
      this.negativeUntil.set(key, Date.now() + this.negativeTtlMs);
    }
    return result;
  }

  /**
   * Adversarial-review fix (lens 2, finding 5) — without this, a genuine
   * FIRST reply could be permanently swallowed: a prospect DMs cold (negative
   * cached for `negativeTtlMs`), the portal's OWN sequence sends them a
   * message moments later (which really does make them ledger-eligible from
   * that instant on), and a reply arriving before the stale negative expires
   * would still be dropped by `check` above without ever consulting the DB
   * again. `sessions.ts`'s send path calls this the moment `markMessageSent`
   * confirms a send — seeding the SAME positive-forever entry a fresh
   * `wasProspectSent` read would itself populate, instead of waiting out the
   * TTL. Idempotent and safe to call even when no negative was ever cached.
   */
  markSent(coachId: string, phone: string): void {
    const key = `${coachId}:${phone}`;
    this.confirmed.add(key);
    this.negativeUntil.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Batch processing — the impure half, deps-injected so it is testable
// against fakes (see module header).
// ---------------------------------------------------------------------------

export interface RecordInboundInput {
  coachId: string;
  fromPhone: string;
  waMessageId: string;
  body: string | null;
  messageType: string;
  receivedAt: string;
  /**
   * Media plan (docs/MEDIA-PLAN.md §6.1/§7a) — `true` iff this row is about
   * to be handed to media capture, so the store should insert it with
   * `media_status = 'pending'` rather than leaving the column `NULL`.
   * Omitted (or `false`) means exactly today's insert — every media_status
   * column stays untouched/NULL, byte-identical to pre-media-plan behaviour.
   * NEVER set for a coach-tenant row (see `processInboundBatch`'s own
   * `shouldCaptureMedia` computation — the hard boundary lives there, not
   * here; this field is just what the store insert reads).
   */
  captureMedia?: boolean;
}

/**
 * Media plan (docs/MEDIA-PLAN.md §6.1) — the one thing `processInboundBatch`
 * needs to hand off a fresh, capture-eligible row to the actual
 * download/sniff/store pipeline (`src/media-capture.ts`'s `runMediaCapture`,
 * wired in by `sessions.ts`). Deliberately FIRE-AND-FORGET from this
 * module's point of view (never awaited — see the plan's "never blocking the
 * batch loop" rule): `beginCapture` itself owns the eventual poke once the
 * capture resolves (stored/too_large/rate_limited/failed), so
 * `processInboundBatch` must NOT also call `schedulePoke()` for a row routed
 * here (see the branch below).
 */
export interface MediaCaptureHook {
  beginCapture(input: { coachId: string; fromPhone: string; waMessageId: string; mediaRef: InboundMediaRef }): void;
}

export interface InboundDeps {
  /** `BridgeStore.wasProspectSent`, or a fake in tests. */
  wasProspectSent(coachId: string, fromPhone: string): Promise<boolean>;
  /** `BridgeStore.recordInboundMessage`, or a fake in tests. Must report `fresh` accurately (see file header's DEDUPE note). */
  recordInboundMessage(input: RecordInboundInput): Promise<{ fresh: boolean }>;
  /** Fire-and-forget "drain now" request to the portal — never awaited, never throws (see src/poke.ts). */
  schedulePoke(): void;
  /**
   * GHL custom conversation provider, Phase 3 (docs/GHL-PROVIDER-PLAN.md's
   * Phase 3 follow-on, decision D4) — `true` iff this session's own
   * `whatsapp_tenants.kind` is `'ghl_location'` (read once by
   * `sessions.ts`'s `doStartSession`, cached on the `Session` object,
   * default `'coach'` on any lookup failure — see that call site's own
   * comment for the fail-closed justification). When `true`, `processInboundBatch`
   * SKIPS the ledger-gate check below entirely — see the branch itself for
   * the full scope argument. `false` for every coach session, always — this
   * bypass is opt-in on a positive `'ghl_location'` read, never the other
   * way round.
   */
  bypassLedgerGate: boolean;
  /**
   * Media plan (docs/MEDIA-PLAN.md §2 rule 4/§8) — `undefined` means media
   * capture is ENTIRELY INERT for this session: either `WA_MEDIA_INBOUND_ENABLED`
   * is `false` (the global dark switch), or `sessions.ts` simply never
   * constructs this for a coach session in the first place (belt-and-braces
   * — see `processInboundBatch`'s `shouldCaptureMedia`, which ALSO requires
   * `bypassLedgerGate: true` before ever touching this, so even a
   * hypothetically-miswired coach session cannot trigger a download). When
   * `undefined`, every fresh row pokes immediately — byte-identical to the
   * pre-media-plan behaviour, regardless of message type or tenant kind.
   */
  media?: MediaCaptureHook;
  /**
   * Baileys 7.x LID machinery (file header step 7 / `ClassifyResult`'s
   * `needs_lid_resolution` kind) — the LAST resort for a LID-routed message
   * whose `remoteJidAlt` was absent or itself not `@s.whatsapp.net`-suffixed.
   * `sessions.ts` wires this to `sock.signalRepository.lidMapping.getPNForLID`,
   * which this bridge's own installed `node_modules/@whiskeysockets/baileys/
   * lib/Signal/lid-mapping.js` confirms is STORE/CACHE-ONLY — an in-memory
   * LRU plus this session's own `'lid-mapping'` auth-state rows, no USync/
   * network round trip — which is exactly why it's safe to `await` inline on
   * this hot path rather than needing its own fire-and-forget treatment like
   * `MediaCaptureHook`. `undefined` (tests, or a session with no live socket
   * yet) means a LID message with no usable alt is simply dropped
   * `unmappable_sender`, identical to pre-LID-machinery behaviour. A
   * resolved result is NOT trusted as-is — `processInboundBatch` re-runs it
   * through the exact same server-check + `isE164` gate every other
   * resolution path uses (`pnJidToE164`), because the returned PN JID can
   * carry a `:0` device suffix (`LIDMappingStore.getPNForLID`'s own reverse-
   * lookup shape) that a naive string check would choke on.
   */
  resolvePnForLid?: (lidJid: string) => Promise<string | null>;
  log: Logger;
}

/**
 * Runs the full pipeline (classify -> ledger gate -> record -> poke) over
 * one `messages.upsert` batch for one coach. Entirely self-wrapped: a throw
 * from ANY step for ONE message is caught and logged, never propagated —
 * one malformed message must never take down the batch, let alone the
 * Baileys event loop that invoked this (see sessions.ts's wiring).
 */
export async function processInboundBatch(
  messages: WAMessage[],
  batchType: MessageUpsertType,
  coachId: string,
  cache: ProspectLedgerCache,
  deps: InboundDeps
): Promise<void> {
  for (const msg of messages) {
    try {
      const result = classifyInboundMessage(msg, batchType);
      if (result.kind === "dropped") {
        deps.log.debug({ coachId, reason: result.reason }, "inbound message dropped");
        continue;
      }

      let reply: InboundReply;
      if (result.kind === "needs_lid_resolution") {
        // LAST resort for a LID-routed message with no directly-usable alt
        // (file header step 7 / `InboundDeps.resolvePnForLid`'s own JSDoc).
        // Deliberately no extra try/catch HERE — a throw from the resolver
        // propagates to this function's own per-message catch below, which
        // already logs and moves on to the next message; that's "dropped,
        // batch continues" via the SAME mechanism every other failure in
        // this loop uses, not a special case.
        const resolvedPnJid = deps.resolvePnForLid ? await deps.resolvePnForLid(result.lidJid) : null;
        // Re-validated through the SAME server-check + isE164 gate as every
        // other resolution path (`pnJidToE164`) — never trust the resolver's
        // answer as pre-validated, and note it may carry a `:0` device part
        // (`LIDMappingStore.getPNForLID`'s own reverse-lookup shape), which
        // `pnJidToE164`'s `jidDecode` already strips before the `+` build.
        const fromPhone = resolvedPnJid ? pnJidToE164(resolvedPnJid) : null;
        if (!fromPhone) {
          deps.log.debug({ coachId, reason: "unmappable_sender" }, "inbound message dropped");
          continue;
        }
        reply = { ...result.pending, fromPhone };
      } else {
        reply = result.reply;
      }
      // GHL custom conversation provider, Phase 3, decision D4 — SCOPED,
      // JUSTIFIED-IN-CODE ledger-gate bypass. This is the ONLY safety
      // invariant in this file's package that Phase 3 is permitted to
      // change (README "Safety invariants" section) — everything else about
      // the filter chain above (fromMe, groups, edits/reactions, the
      // JID->E.164 mapping) is untouched for EVERY session, GHL or coach.
      //
      // WHY THIS IS SAFE, RESTATED HERE (not just in the plan doc) —
      // SCOPE: `deps.bypassLedgerGate` is read once at session start
      // (`sessions.ts`'s `doStartSession`) from `whatsapp_tenants.kind`, a
      // column this bridge never writes and the portal never updates after
      // insert (0069's `whatsapp_tenants_kind_shape` CHECK pins `kind =
      // 'coach'` to rows where `id = coach_id = coaches.id`, with no UPDATE
      // path to `kind` anywhere in the schema). A coach tenant is therefore
      // PHYSICALLY INCAPABLE of ever reading back `'ghl_location'` — this
      // bypass cannot leak onto a coach's session by any code path, present
      // or future, short of a hand-written migration that changes the CHECK
      // itself.
      //
      // WHY THIS IS SAFE — THE RATIONALE ITSELF: the ledger-gate invariant's
      // stated rule (this file's own header, "THE LEDGER GATE") is that "the
      // linked WhatsApp number is the coach's REAL PERSONAL PHONE — family,
      // friends, and existing clients all message it too". For a
      // `'ghl_location'` tenant that rationale does not apply AT ALL: the
      // number is, contractually (the operator go-live checklist requires
      // it), a DEDICATED BUSINESS NUMBER the client is paying specifically
      // for WAGHL-parity two-way WhatsApp — cold inbound from a prospect who
      // has never been messaged first is the ENTIRE PRODUCT for this tenant
      // kind, not an edge case to filter out.
      //
      // WHY THIS IS SAFE — FAIL-CLOSED ON DOUBT: `doStartSession` defaults
      // to `'coach'` (the STRICTER gate) on any lookup failure/null/throw,
      // never to the looser bypass — a Supabase blip at session start
      // degrades a GHL session to "cold inbound dropped until the next
      // session restart", never a coach session to "cold inbound now
      // accepted". See that call site's own comment.
      //
      // WHAT THIS DOES NOT CHANGE: the bypass skips EXACTLY this one check —
      // every filter above (fromMe/groups/status-broadcast/reactions/edits/
      // protocol messages/unmappable senders) still runs identically for a
      // GHL session. This is not a "let everything through for GHL" switch;
      // it is "one specific eligibility check, whose entire premise doesn't
      // hold for this tenant kind, is skipped".
      const eligible = deps.bypassLedgerGate ? true : await cache.check(coachId, reply.fromPhone, deps.wasProspectSent);
      if (!eligible) {
        // Ledger gate (hard rule 4) — this number is not a thread the portal
        // ever opened. Never stored, never forwarded. No phone/body logged.
        deps.log.debug({ coachId }, "inbound message dropped: sender not on this coach's send ledger");
        continue;
      }

      // Media plan (docs/MEDIA-PLAN.md §2 rule 4/§6.1) — THE hard boundary,
      // enforced in code, not a config default: media capture requires ALL
      // THREE of (a) this session bypassing the ledger gate at all (i.e. a
      // confirmed 'ghl_location' tenant — never true for a coach session,
      // see `InboundDeps.bypassLedgerGate`'s own fail-closed JSDoc), (b) the
      // media capture deps actually being wired in (`sessions.ts` only ever
      // constructs `deps.media` when `WA_MEDIA_INBOUND_ENABLED` is true), and
      // (c) this specific reply having a capturable `mediaRef` (text,
      // stickers, and view-once media never do — see `classifyInboundMessage`).
      // Any one of the three being false/absent means EXACTLY today's
      // behaviour: `media_status` untouched (stays NULL) and an immediate
      // poke on every fresh row, regardless of message type or tenant kind.
      const shouldCaptureMedia = deps.bypassLedgerGate && deps.media !== undefined && reply.mediaRef !== null;

      const { fresh } = await deps.recordInboundMessage({
        coachId,
        fromPhone: reply.fromPhone,
        waMessageId: reply.waMessageId,
        body: reply.body,
        messageType: reply.messageType,
        receivedAt: reply.receivedAt,
        captureMedia: shouldCaptureMedia,
      });

      if (fresh) {
        if (shouldCaptureMedia) {
          // `beginCapture` owns the poke once the download/sniff/store
          // pipeline resolves (plan §6.1 point 3: "poke the portal only
          // AFTER media resolves — otherwise the drain races the upload and
          // pushes a placeholder for a file that lands seconds later"). Never
          // await here — see `MediaCaptureHook`'s own JSDoc ("never blocking
          // the batch loop").
          deps.media!.beginCapture({ coachId, fromPhone: reply.fromPhone, waMessageId: reply.waMessageId, mediaRef: reply.mediaRef! });
        } else {
          deps.schedulePoke();
        }
      }
      // !fresh => a redelivered message (Baileys reconnect/offline-resync) —
      // 0048's unique (coach_id, wa_message_id) constraint already absorbed
      // it as a no-op insert. Nothing further to do; no second poke, no
      // second capture attempt (the row's media_status, if any, was already
      // set on first insert and is never touched by a duplicate delivery).
    } catch (err) {
      // The store write failing (or anything else throwing) must never lose
      // the whole batch, and must never reach the Baileys event loop — the
      // message still exists on the coach's phone, which remains the source
      // of truth regardless of what the portal ever learns about it.
      deps.log.error({ coachId, err: (err as Error).message }, "inbound message processing failed (non-fatal)");
    }
  }
}
