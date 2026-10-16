/**
 * src/inbound.ts — the media plan's additions (docs/MEDIA-PLAN.md §6):
 * `classifyInboundMessage`'s `mediaRef` construction (incl. sticker and
 * view-once exclusion), and `processInboundBatch`'s capture-routing branch
 * (the hard boundary — ghl_location + WA_MEDIA_INBOUND_ENABLED + a
 * capturable mediaRef, ALL THREE, before a download is ever considered).
 * No network, no Baileys, no Supabase — fabricated WAMessage objects and
 * fake deps, exactly this package's existing convention (test/inbound.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import type { WAMessage } from "@whiskeysockets/baileys";
import { classifyInboundMessage, processInboundBatch, ProspectLedgerCache, type InboundDeps, type RecordInboundInput } from "../src/inbound.js";

const log = pino({ level: "silent" });
const COACH_A = "coach-a";
const PROSPECT_JID = "447700900123@s.whatsapp.net";
const PROSPECT_PHONE = "+447700900123";

function makeMsg(overrides: {
  key?: Partial<{ remoteJid: string; fromMe: boolean; id: string; remoteJidAlt: string }>;
  message?: Record<string, unknown> | null;
  messageTimestamp?: number;
} = {}): WAMessage {
  return {
    key: { remoteJid: PROSPECT_JID, fromMe: false, id: "MSG1", ...overrides.key },
    message: overrides.message === undefined ? { conversation: "hey, got your message" } : overrides.message,
    messageTimestamp: overrides.messageTimestamp ?? 1_800_000_000,
  } as unknown as WAMessage;
}

// ---------------------------------------------------------------------------
// classifyInboundMessage — mediaRef construction.
// ---------------------------------------------------------------------------

test("classify: an imageMessage gets a populated mediaRef with the sender's (untrusted) claims carried through", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { imageMessage: { mediaKey: new Uint8Array([1]), directPath: "/v/x", url: "https://x", mimetype: "image/jpeg", fileLength: 12345 } } }),
    "notify"
  );
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.deepEqual(result.reply.mediaRef, {
      kind: "image",
      downloadable: { mediaKey: new Uint8Array([1]), directPath: "/v/x", url: "https://x" },
      claimedMimetype: "image/jpeg",
      claimedFileLength: 12345,
    });
  }
});

test("classify: videoMessage/audioMessage/documentMessage all get a mediaRef with the correct kind", () => {
  const cases: [string, string][] = [
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
  ];
  for (const [messageType, expectedKind] of cases) {
    const result = classifyInboundMessage(makeMsg({ message: { [messageType]: {} } }), "notify");
    assert.equal(result.kind, "reply", messageType);
    if (result.kind === "reply") assert.equal(result.reply.mediaRef?.kind, expectedKind, messageType);
  }
});

test("classify: text replies never get a mediaRef", () => {
  const result = classifyInboundMessage(makeMsg(), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.mediaRef, null);
});

test("classify: a sticker never gets a mediaRef — stickers are deliberately excluded from capture (plan decision: noise)", () => {
  const result = classifyInboundMessage(makeMsg({ message: { stickerMessage: { mediaKey: new Uint8Array([1]) } } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.equal(result.reply.messageType, "stickerMessage");
    assert.equal(result.reply.mediaRef, null);
  }
});

test("classify: a view-once-wrapped image never gets a mediaRef — the sender chose ephemerality (plan decision)", () => {
  const result = classifyInboundMessage(makeMsg({ message: { viewOnceMessageV2: { message: { imageMessage: { mediaKey: new Uint8Array([1]) } } } } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.equal(result.reply.messageType, "imageMessage", "the reply itself is still recorded normally — only capture is declined");
    assert.equal(result.reply.mediaRef, null);
  }
});

test("classify: a view-once image hidden inside an ephemeralMessage wrapper (nested) still gets no mediaRef", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { ephemeralMessage: { message: { viewOnceMessage: { message: { imageMessage: { mediaKey: new Uint8Array([1]) } } } } } } }),
    "notify"
  );
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.mediaRef, null);
});

// Baileys 7.x addition (verified against this bridge's installed
// `lib/Utils/messages.js`) — `normalizeMessageContent` unwraps
// `associatedChildMessage` transparently, exactly like `ephemeralMessage`.
// `isViewOnceAtAnyDepth` recurses through the SAME `TRANSPARENT_WRAPPER_KEYS`
// list `containsRejectedContentAtAnyDepth` does (src/inbound.ts), so a
// view-once image hidden inside one is caught here too, not just inside an
// ephemeral wrapper.
test("classify: a view-once image hidden inside an associatedChildMessage wrapper still gets no mediaRef", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { associatedChildMessage: { message: { viewOnceMessage: { message: { imageMessage: { mediaKey: new Uint8Array([1]) } } } } } } }),
    "notify"
  );
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.mediaRef, null);
});

test("classify: an ephemeral (disappearing-mode) image WITHOUT view-once still gets a mediaRef — only view-once is excluded, not every wrapper", () => {
  const result = classifyInboundMessage(makeMsg({ message: { ephemeralMessage: { message: { imageMessage: { mediaKey: new Uint8Array([1]) } } } } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.equal(result.reply.messageType, "imageMessage");
    assert.equal(result.reply.mediaRef?.kind, "image");
  }
});

test("classify: a Long-shaped fileLength (protobuf int64) is coerced via toNumber, mirroring messageTimestamp's own handling", () => {
  const longLike = { toNumber: () => 999 };
  const result = classifyInboundMessage(makeMsg({ message: { imageMessage: { fileLength: longLike } } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.mediaRef?.claimedFileLength, 999);
});

// ---------------------------------------------------------------------------
// processInboundBatch — the capture-routing hard boundary.
// ---------------------------------------------------------------------------

interface FakeHarness {
  recordCalls: RecordInboundInput[];
  pokeCalls: number;
  beginCaptureCalls: { coachId: string; fromPhone: string; waMessageId: string; mediaRefKind: string }[];
  deps: InboundDeps;
}

function makeHarness(opts: { bypassLedgerGate: boolean; withMediaDeps: boolean }): FakeHarness {
  const h: FakeHarness = { recordCalls: [], pokeCalls: 0, beginCaptureCalls: [], deps: null as unknown as InboundDeps };
  h.deps = {
    async wasProspectSent() {
      return true;
    },
    async recordInboundMessage(input) {
      h.recordCalls.push(input);
      return { fresh: true };
    },
    schedulePoke() {
      h.pokeCalls += 1;
    },
    bypassLedgerGate: opts.bypassLedgerGate,
    media: opts.withMediaDeps
      ? {
          beginCapture(input) {
            h.beginCaptureCalls.push({ coachId: input.coachId, fromPhone: input.fromPhone, waMessageId: input.waMessageId, mediaRefKind: input.mediaRef.kind });
          },
        }
      : undefined,
    log,
  };
  return h;
}

const IMAGE_MSG = makeMsg({ message: { imageMessage: { mediaKey: new Uint8Array([1]), mimetype: "image/jpeg" } } });

test("processInboundBatch: ghl_location + media deps + capturable image -> beginCapture called, NOT an immediate poke", async () => {
  const h = makeHarness({ bypassLedgerGate: true, withMediaDeps: true });
  await processInboundBatch([IMAGE_MSG], "notify", COACH_A, new ProspectLedgerCache(), h.deps);
  assert.equal(h.recordCalls.length, 1);
  assert.equal(h.recordCalls[0]?.captureMedia, true, "the store insert must be told to set media_status='pending'");
  assert.equal(h.beginCaptureCalls.length, 1);
  assert.equal(h.beginCaptureCalls[0]?.mediaRefKind, "image");
  assert.equal(h.pokeCalls, 0, "beginCapture owns the eventual poke — processInboundBatch must not ALSO poke immediately");
});

test("processInboundBatch: ghl_location + media deps + TEXT reply -> pokes immediately, exactly like today (media routing only ever applies to capturable media)", async () => {
  const h = makeHarness({ bypassLedgerGate: true, withMediaDeps: true });
  await processInboundBatch([makeMsg()], "notify", COACH_A, new ProspectLedgerCache(), h.deps);
  assert.equal(h.beginCaptureCalls.length, 0);
  assert.equal(h.recordCalls[0]?.captureMedia, false);
  assert.equal(h.pokeCalls, 1);
});

test("processInboundBatch: media deps present but bypassLedgerGate FALSE (a coach session) -> media capture NEVER runs, even for a capturable image — the hard boundary holds", async () => {
  // Belt-and-braces: sessions.ts is only ever supposed to construct `deps.media`
  // for a confirmed ghl_location session, but this proves processInboundBatch
  // ITSELF refuses to route to capture without bypassLedgerGate true, so a
  // hypothetical future mis-wiring still cannot download media for a coach.
  const h = makeHarness({ bypassLedgerGate: false, withMediaDeps: true });
  await processInboundBatch([IMAGE_MSG], "notify", COACH_A, new ProspectLedgerCache(), h.deps);
  assert.equal(h.beginCaptureCalls.length, 0, "capture must never run for a coach session regardless of deps.media being set");
  assert.equal(h.recordCalls[0]?.captureMedia, false);
  assert.equal(h.pokeCalls, 1, "falls through to the ordinary immediate-poke path, exactly like today");
});

test("processInboundBatch: ghl_location but media deps UNDEFINED (WA_MEDIA_INBOUND_ENABLED=false) -> capture never runs, immediate poke, byte-identical to pre-media-plan behaviour", async () => {
  const h = makeHarness({ bypassLedgerGate: true, withMediaDeps: false });
  await processInboundBatch([IMAGE_MSG], "notify", COACH_A, new ProspectLedgerCache(), h.deps);
  assert.equal(h.beginCaptureCalls.length, 0);
  assert.equal(h.recordCalls[0]?.captureMedia, false);
  assert.equal(h.pokeCalls, 1);
});

test("processInboundBatch: a sticker under ghl_location + media deps is never routed to capture (no mediaRef) — pokes immediately", async () => {
  const h = makeHarness({ bypassLedgerGate: true, withMediaDeps: true });
  const sticker = makeMsg({ message: { stickerMessage: { mediaKey: new Uint8Array([1]) } } });
  await processInboundBatch([sticker], "notify", COACH_A, new ProspectLedgerCache(), h.deps);
  assert.equal(h.beginCaptureCalls.length, 0);
  assert.equal(h.recordCalls[0]?.captureMedia, false);
  assert.equal(h.pokeCalls, 1);
});

test("processInboundBatch: a view-once image under ghl_location + media deps is never routed to capture — pokes immediately", async () => {
  const h = makeHarness({ bypassLedgerGate: true, withMediaDeps: true });
  const viewOnce = makeMsg({ message: { viewOnceMessageV2: { message: { imageMessage: { mediaKey: new Uint8Array([1]) } } } } });
  await processInboundBatch([viewOnce], "notify", COACH_A, new ProspectLedgerCache(), h.deps);
  assert.equal(h.beginCaptureCalls.length, 0);
  assert.equal(h.recordCalls[0]?.captureMedia, false);
  assert.equal(h.pokeCalls, 1);
});

test("processInboundBatch: a redelivered (non-fresh) capturable media row never re-invokes beginCapture", async () => {
  const h = makeHarness({ bypassLedgerGate: true, withMediaDeps: true });
  h.deps = {
    ...h.deps,
    async recordInboundMessage(input) {
      h.recordCalls.push(input);
      return { fresh: false }; // simulates a Baileys redelivery — already recorded.
    },
  };
  await processInboundBatch([IMAGE_MSG], "notify", COACH_A, new ProspectLedgerCache(), h.deps);
  assert.equal(h.beginCaptureCalls.length, 0);
  assert.equal(h.pokeCalls, 0);
});
