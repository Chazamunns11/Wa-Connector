/**
 * Voice notes at dispatch (docs/superpowers/plans/2026-10-17-voice-notes.md,
 * Task 3). Drives the REAL `SessionManager` accept + drain path against a
 * fake session, socket and store (the test/groups.test.ts pattern), with a
 * fake `resolveAttachment` (no network — it runs the real sniff + mapping on
 * the fixture bytes) and a fake `transcode` (no ffmpeg).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionManager } from "../src/sessions.js";
import { GROUP_SYNC_OFF_REASON } from "../src/groups.js";
import { SessionPacer } from "../src/pacing.js";
import { PendingWrites } from "../src/pending-writes.js";
import { mapMimeToBaileysShape, sniffMime, type SniffedMime } from "../src/media.js";
import type { ResolveOutboundAttachmentResult, resolveOutboundAttachment } from "../src/media-fetch.js";
import { realFfmpegRunner, transcodeToVoiceNote, type TranscodeResult } from "../src/voice-transcode.js";
import type { BridgeStore, MessageRecord } from "../src/store.js";
import type { BridgeConfig } from "../src/config.js";

const silentLog = pino({ level: "silent" });
const TENANT = "11111111-1111-4111-8111-111111111111";
const TO = "+447700900123";

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 1)]);
const OPUS_OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead"), Buffer.alloc(28, 1)]);
const TRANSCODED = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead"), Buffer.from("transcoded")]);
const WAVEFORM = new Uint8Array([0, 50, 100]);

function makeConfig(): BridgeConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    credsKey: Buffer.alloc(32),
    credsKeyPrevious: null,
    bridgeSecret: "bridge-secret-0123456789-0123456789-0123456789",
    port: 8080,
    sendMinGapMs: 0,
    sendJitterMs: 0,
    dailyCap: 10,
    warmupEnabled: false,
    typingIndicatorEnabled: false,
    typingMaxMs: 0,
    lockHeartbeatMs: 60_000,
    lockTtlMs: 180_000,
    shutdownFlushTimeoutMs: 500,
    maxQrReconnectAttempts: 5,
    logLevel: "silent",
    portalInboundUrl: null,
    waInboundPokeSecret: null,
    portalOutboundUrl: null,
    mediaOutboundEnabled: true,
    mediaInboundEnabled: false,
    mediaFetchTimeoutMs: 30_000,
    mediaMaxImageBytes: 1000,
    mediaMaxAudioBytes: 1000,
    mediaMaxVideoBytes: 1000,
    mediaMaxDocumentBytes: 1000,
    inboundMediaMaxBytes: 1,
    inboundMediaPerSenderDaily: 20,
    inboundMediaPerTenantDaily: 300,
    mediaBucket: "wa-media",
    voiceTranscodeEnabled: true,
  } as BridgeConfig;
}

const GROUP_JID = "120363418570879210@g.us";

function makeRecord(idempotencyKey: string, groupJid: string | null = null): MessageRecord {
  return {
    id: `id-${idempotencyKey}`,
    coachId: TENANT,
    idempotencyKey,
    toPhone: groupJid === null ? TO : null,
    groupJid,
    status: "accepted",
    waMessageId: null,
    error: null,
    dispatchAttempted: false,
    createdAt: "2026-10-17T10:00:00.000Z",
    sentAt: null,
    kind: "media",
  };
}

type TranscodeFn = (buf: Buffer, mime: SniffedMime) => Promise<TranscodeResult>;

function makeHarness(opts: { bytes: Buffer; transcode?: TranscodeFn | null; leaseHeld?: boolean; group?: boolean; log?: typeof silentLog }) {
  const calls: { method: string; args: unknown[] }[] = [];
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => (resolveTerminal = resolve));
  const store = {
    getMessage: async () => null,
    acceptMessage: async (_coachId: string, key: string) => ({ record: makeRecord(key, opts.group ? GROUP_JID : null), fresh: true }),
    claimMessage: async () => true,
    markMessageFailed: async (...args: unknown[]) => {
      calls.push({ method: "markMessageFailed", args });
      resolveTerminal();
    },
    markMessageSent: async (...args: unknown[]) => {
      calls.push({ method: "markMessageSent", args });
      resolveTerminal();
    },
    markMessageNotOnWhatsapp: async (...args: unknown[]) => {
      calls.push({ method: "markMessageNotOnWhatsapp", args });
      resolveTerminal();
    },
    listEnabledGroupJids: async () => [],
  } as unknown as BridgeStore;

  const sent: { jid: string; content: Record<string, unknown> }[] = [];
  const sock = {
    user: { id: "447700900001:12@s.whatsapp.net" },
    onWhatsApp: async (phone: string) => [{ exists: true, jid: `${phone.slice(1)}@s.whatsapp.net` }],
    sendPresenceUpdate: async () => {},
    groupMetadata: async () => ({ participants: [{ id: "447700900001@s.whatsapp.net" }] }),
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sent.push({ jid, content });
      return { key: { id: "WAID1" } };
    },
  };

  // No network: the real sniff + mapping (and the transcode-candidate audio cap) on the fixture bytes.
  const resolveOpts: { voiceTranscode?: boolean }[] = [];
  const resolveAttachment = (async (_url: string, o: { voiceTranscode?: boolean; caps: { audio: number } }): Promise<ResolveOutboundAttachmentResult> => {
    resolveOpts.push({ voiceTranscode: o.voiceTranscode });
    const mime = sniffMime(opts.bytes);
    const mapped = mapMimeToBaileysShape(mime, { bytes: opts.bytes, voiceTranscode: o.voiceTranscode === true });
    if (!mapped || !mime) return { ok: false, reason: "unsupported_type" };
    return { ok: true, kind: mapped.kind, mimetype: mime, buffer: opts.bytes, ptt: mapped.ptt, ...(mapped.transcodeCandidate ? { transcodeCandidate: true } : {}) };
  }) as unknown as typeof resolveOutboundAttachment;

  const transcodeCalls: { mime: SniffedMime; sentTodayAtCall: number; inFlightAtCall: number }[] = [];
  let session!: Record<string, unknown> & { enabledGroups: Set<string>; pacer: SessionPacer; status: string; draining: boolean; queue: unknown[] };
  const wrapped: TranscodeFn | null =
    opts.transcode === undefined || opts.transcode === null
      ? null
      : async (buf, mime) => {
          transcodeCalls.push({ mime, sentTodayAtCall: session.pacer.sentTodayCount(), inFlightAtCall: session.inFlightUnits as number });
          return opts.transcode!(buf, mime);
        };

  const manager = new SessionManager(store, makeConfig(), opts.log ?? silentLog, null, null, { resolveAttachment, transcode: wrapped });
  let leaseHeld = opts.leaseHeld ?? true;
  session = {
    coachId: TENANT,
    sock,
    lock: { isHeld: () => leaseHeld, confirmHeld: async () => true, release: async () => {} },
    pacer: new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 10 }, 0, Date.now, () => 0),
    status: "connected",
    phoneNumber: "+447700900001",
    qr: null,
    qrAt: 0,
    queue: [] as unknown[],
    draining: false,
    reconnectAttempts: 0,
    stopping: false,
    pendingWrites: new PendingWrites(),
    mediaAbuseGate: null,
    enabledGroups: new Set<string>(opts.group ? [GROUP_JID] : []),
    enabledGroupsLoad: 0,
    inFlightUnits: 0,
  };
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(TENANT, session);
  return {
    manager,
    session,
    calls,
    terminal,
    sent,
    transcodeCalls,
    resolveOpts,
    setLeaseHeld: (held: boolean) => (leaseHeld = held),
    drain: () => (manager as unknown as { drainQueue: (s: unknown) => Promise<void> }).drainQueue(session),
  };
}

const ok = (seconds = 7): TranscodeFn => async () => ({ ok: true, buffer: TRANSCODED, seconds, waveform: WAVEFORM });

async function sendAndSettle(h: ReturnType<typeof makeHarness>, fileName?: string) {
  const outcome = await h.manager.sendAttachment(TENANT, TO, { url: "https://example.com/a", ...(fileName ? { fileName } : {}) }, "k-1");
  assert.equal(outcome.kind, "accepted");
  await h.terminal;
}

test("drain: an mp3 attachment is transcoded and sent as a voice note", async () => {
  const h = makeHarness({ bytes: MP3, transcode: ok(7) });
  await sendAndSettle(h);
  assert.equal(h.sent.length, 1);
  const content = h.sent[0].content;
  assert.equal(content.ptt, true);
  assert.equal(content.mimetype, "audio/ogg; codecs=opus");
  assert.equal(content.seconds, 7);
  assert.equal(content.waveform, WAVEFORM);
  assert.equal(content.audio, TRANSCODED);
  assert.deepEqual(h.transcodeCalls.map((c) => c.mime), ["audio/mpeg"]);
  assert.equal(h.calls.filter((c) => c.method === "markMessageSent").length, 1);
  assert.equal(h.session.pacer.sentTodayCount(), 1);
  assert.deepEqual(h.resolveOpts, [{ voiceTranscode: true }]);
});

test("drain: transcode is called before recordSend", async () => {
  const h = makeHarness({ bytes: MP3, transcode: ok() });
  await sendAndSettle(h);
  assert.equal(h.transcodeCalls.length, 1);
  assert.equal(h.transcodeCalls[0].sentTodayAtCall, 0);
  assert.equal(h.transcodeCalls[0].inFlightAtCall, 1, "the item's units are in flight while ffmpeg runs");
});

test("drain: a transcode timeout sends the original as an audio file", async () => {
  const h = makeHarness({ bytes: MP3, transcode: async () => ({ ok: false, reason: "timeout" }) });
  await sendAndSettle(h);
  assert.deepEqual(h.sent[0].content, { audio: MP3, mimetype: "audio/mpeg", ptt: false });
  assert.equal(h.calls.filter((c) => c.method === "markMessageSent").length, 1);
  assert.equal(h.calls.filter((c) => c.method === "markMessageFailed").length, 0);
});

test("drain: every transcode failure reason (too_long and busy included) falls back to a sent audio file", async () => {
  for (const reason of ["too_long", "busy", "bad_output", "unavailable", "ffmpeg_failed"] as const) {
    const h = makeHarness({ bytes: MP3, transcode: async () => ({ ok: false, reason }) });
    await sendAndSettle(h);
    assert.deepEqual(h.sent[0].content, { audio: MP3, mimetype: "audio/mpeg", ptt: false }, reason);
    assert.equal(h.calls.filter((c) => c.method === "markMessageSent").length, 1, reason);
  }
});

test("drain: a webm whose transcode fails goes as a document, never failed", async () => {
  const h = makeHarness({ bytes: WEBM, transcode: async () => ({ ok: false, reason: "bad_output" }) });
  await sendAndSettle(h, "GHL recording 2026-10-17.webm");
  assert.equal(h.sent.length, 1);
  const content = h.sent[0].content;
  assert.equal(content.document, WEBM);
  assert.equal(content.mimetype, "audio/webm");
  assert.equal(content.fileName, "voice-note.webm", "GHL's filename is overridden for the voice-note fallback");
  assert.equal(h.calls.filter((c) => c.method === "markMessageFailed").length, 0);
});

test("drain: has_video sends the original as a document under GHL's own filename, not voice-note.<ext>", async () => {
  const h = makeHarness({ bytes: WEBM, transcode: async () => ({ ok: false, reason: "has_video" }) });
  await sendAndSettle(h, "Client walkthrough.webm");
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].content, { document: WEBM, mimetype: "audio/webm", fileName: "Client walkthrough.webm" });
  assert.equal(h.calls.filter((c) => c.method === "markMessageSent").length, 1);
});

test("drain: has_video with no GHL filename is a generic attachment.<ext>, still not voice-note.<ext>", async () => {
  const h = makeHarness({ bytes: WEBM, transcode: async () => ({ ok: false, reason: "has_video" }) });
  await sendAndSettle(h);
  assert.equal(h.sent[0].content.fileName, "attachment.webm");
});

test("drain: has_video on audio whose fallback is an audio file still goes as a document", async () => {
  const h = makeHarness({ bytes: MP3, transcode: async () => ({ ok: false, reason: "has_video" }) });
  await sendAndSettle(h, "clip.mp3");
  assert.deepEqual(h.sent[0].content, { document: MP3, mimetype: "audio/mpeg", fileName: "clip.mp3" });
});

test("drain (real ffmpeg): a VP8+Opus webm goes as a document with its original name, never a voice note", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    t.skip("ffmpeg not on PATH");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "voice-note-drain-it-"));
  try {
    const src = path.join(dir, "av.webm");
    const gen = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libvpx", "-c:a", "libopus", "-shortest", "-f", "webm", src,
    ]);
    if (gen.status !== 0) {
      t.skip("no libvpx");
      return;
    }
    const bytes = await readFile(src);
    const outcomes: TranscodeResult[] = [];
    const h = makeHarness({
      bytes,
      transcode: async (buf, mime) => {
        const result = await transcodeToVoiceNote(buf, mime, { maxInputBytes: 16 * 1024 * 1024, run: realFfmpegRunner });
        outcomes.push(result);
        return result;
      },
    });
    await sendAndSettle(h, "Screen recording.webm");
    assert.deepEqual(outcomes, [{ ok: false, reason: "has_video" }]);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0].content, { document: bytes, mimetype: "audio/webm", fileName: "Screen recording.webm" });
    assert.equal(h.calls.filter((c) => c.method === "markMessageSent").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function captureLog(): { log: typeof silentLog; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) }) };
}

const SAFARI_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(52, 1)]);

test("drain: every outbound attachment logs one `outbound attachment` line — sniffed type, final kind/ptt, no names or URLs", async () => {
  const cases = [
    { bytes: MP3, transcode: ok(), want: { sniffedMime: "audio/mpeg", kind: "audio", ptt: true } },
    { bytes: OPUS_OGG, transcode: ok(), want: { sniffedMime: "audio/ogg", kind: "audio", ptt: true } },
    { bytes: MP3, transcode: null, want: { sniffedMime: "audio/mpeg", kind: "audio", ptt: false } },
    { bytes: WEBM, transcode: async () => ({ ok: false, reason: "bad_output" }) as const, want: { sniffedMime: "audio/webm", kind: "document", ptt: false } },
    { bytes: SAFARI_MP4, transcode: ok(), want: { sniffedMime: "video/mp4", ftypBrand: "mp42", kind: "video", ptt: false } },
  ] as const;
  for (const c of cases) {
    const { log, lines } = captureLog();
    const h = makeHarness({ bytes: c.bytes, transcode: c.transcode, log });
    await sendAndSettle(h, "Secret Client Name.webm");
    const found = lines.filter((l) => l.msg === "outbound attachment");
    assert.equal(found.length, 1, c.want.sniffedMime);
    const { level: _level, time: _time, pid: _pid, hostname: _hostname, msg: _msg, ...fields } = found[0]!;
    assert.deepEqual(fields, { coachId: TENANT, messageId: "id-k-1", ...c.want }, c.want.sniffedMime);
    const all = JSON.stringify(lines);
    assert.doesNotMatch(all, /Secret Client Name/, "no file name in any log line");
    assert.doesNotMatch(all, /example\.com/, "no URL in any log line");
  }
});

test("drain: the `outbound attachment` line for a group send carries no group JID", async () => {
  const { log, lines } = captureLog();
  const h = makeHarness({ bytes: MP3, transcode: ok(), group: true, log });
  const outcome = await h.manager.sendAttachmentToGroup(TENANT, GROUP_JID, { url: "https://example.com/a" }, "k-1");
  assert.equal(outcome.kind, "accepted");
  await h.terminal;
  const found = lines.filter((l) => l.msg === "outbound attachment");
  assert.equal(found.length, 1);
  assert.doesNotMatch(JSON.stringify(found[0]), new RegExp(GROUP_JID.split("@")[0]!));
});

test("drain: transcode off (no mediaDeps.transcode) leaves mp3 exactly as today", async () => {
  const h = makeHarness({ bytes: MP3, transcode: null });
  await sendAndSettle(h);
  assert.deepEqual(h.sent[0].content, { audio: MP3, mimetype: "audio/mpeg", ptt: false });
  assert.equal(h.transcodeCalls.length, 0);
  assert.deepEqual(h.resolveOpts, [{ voiceTranscode: false }]);
});

test("drain: transcode off keeps webm refused, as today", async () => {
  const h = makeHarness({ bytes: WEBM, transcode: null });
  await sendAndSettle(h);
  assert.equal(h.sent.length, 0);
  const failed = h.calls.find((c) => c.method === "markMessageFailed");
  assert.deepEqual(failed?.args, ["id-k-1", "attachment type is not supported for WhatsApp delivery", false]);
});

test("drain: genuine ogg/opus is not transcoded", async () => {
  const h = makeHarness({ bytes: OPUS_OGG, transcode: ok() });
  await sendAndSettle(h);
  assert.equal(h.transcodeCalls.length, 0);
  assert.equal(h.sent[0].content.ptt, true);
  assert.equal(h.sent[0].content.audio, OPUS_OGG);
});

test("drain: the socket drops during the transcode", async () => {
  let h!: ReturnType<typeof makeHarness>;
  h = makeHarness({
    bytes: MP3,
    transcode: async () => {
      h.session.status = "disconnected";
      return { ok: true, buffer: TRANSCODED, seconds: 3, waveform: WAVEFORM };
    },
  });
  await sendAndSettle(h);
  assert.equal(h.sent.length, 0);
  const failed = h.calls.find((c) => c.method === "markMessageFailed");
  assert.deepEqual(failed?.args, ["id-k-1", "session disconnected before sending — not dispatched", false]);
  assert.equal(h.session.pacer.sentTodayCount(), 0, "nothing dispatched, no pacer slot used");
});

test("drain: a held message released by the app reaches the same branch", async () => {
  // Lease not held: the accept queues the message and the drain leaves it (as while reconnecting).
  const h = makeHarness({ bytes: MP3, transcode: ok(), leaseHeld: false });
  const outcome = await h.manager.sendAttachment(TENANT, TO, { url: "https://example.com/a" }, "k-1");
  assert.equal(outcome.kind, "accepted");
  for (let i = 0; i < 20 && h.session.draining; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.session.queue.length, 1);
  assert.equal(h.transcodeCalls.length, 0);
  h.setLeaseHeld(true);
  await h.drain(); // what the 'open' handler does on reconnect
  await h.terminal;
  assert.equal(h.transcodeCalls.length, 1);
  assert.equal(h.sent[0].content.ptt, true);
});

test("drain: a group voice note is transcoded and sent to the group, counting 5 units", async () => {
  const h = makeHarness({ bytes: MP3, transcode: ok(), group: true });
  const outcome = await h.manager.sendAttachmentToGroup(TENANT, GROUP_JID, { url: "https://example.com/a" }, "k-1");
  assert.equal(outcome.kind, "accepted");
  await h.terminal;
  assert.equal(h.sent[0].jid, GROUP_JID);
  assert.equal(h.sent[0].content.ptt, true);
  assert.equal(h.session.pacer.sentTodayCount(), 5);
  assert.equal(h.transcodeCalls.length, 1);
  assert.equal(h.transcodeCalls[0].inFlightAtCall, 5);
});

test("drain: a group switched off during the transcode fails not dispatched", async () => {
  let h!: ReturnType<typeof makeHarness>;
  h = makeHarness({
    bytes: MP3,
    group: true,
    transcode: async () => {
      h.session.enabledGroups.delete(GROUP_JID);
      return { ok: true, buffer: TRANSCODED, seconds: 3, waveform: WAVEFORM };
    },
  });
  const outcome = await h.manager.sendAttachmentToGroup(TENANT, GROUP_JID, { url: "https://example.com/a" }, "k-1");
  assert.equal(outcome.kind, "accepted");
  await h.terminal;
  assert.equal(h.sent.length, 0);
  const failed = h.calls.find((c) => c.method === "markMessageFailed");
  assert.equal(failed?.args[2], false, "dispatchAttempted=false");
  assert.equal(failed?.args[1], GROUP_SYNC_OFF_REASON);
  assert.equal(h.session.pacer.sentTodayCount(), 0);
});
