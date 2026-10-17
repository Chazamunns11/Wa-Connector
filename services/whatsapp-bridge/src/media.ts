/**
 * Media plan (docs/MEDIA-PLAN.md) — the shared, PURE primitives both
 * directions build on: magic-byte MIME sniffing, the sniffed-type allowlist,
 * the MIME->Baileys send-shape mapping, the SSRF guard, and a byte-cap
 * streaming collector. Nothing in this file touches the network, Supabase,
 * or a Baileys socket — every function here is unit-testable with plain
 * buffers/fake streams, matching this package's "no network, no WhatsApp, no
 * Supabase" test convention (README.md).
 *
 * WHY SNIFF AT ALL (plan §5.4/§9/§10): the URL extension and any
 * caller-supplied/response `Content-Type` are hints only — never trusted.
 * GHL's storage serves `application/octet-stream` often enough that trusting
 * headers would misclassify constantly, and a mislabelled executable must
 * never go out as a "document" with a friendly name, nor get stored and
 * re-served from an inbound reply. Sniffed type wins on any disagreement.
 *
 * NO ANTIVIRUS IN v1 (plan §10, stated position, not an oversight) — the
 * sniffed-type ALLOWLIST is what compensates: images, mp4 video, ogg/mp3/
 * m4a/webm/wav audio, PDF, and zip-family office documents are allowed; anything
 * else (executables, scripts, APKs, unrecognised magic bytes) is refused,
 * both directions.
 */
import type { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Magic-byte sniffing — first ~16 bytes only, exactly the header table plan
// §5.4/§10 calls for. Order matters where one signature is a prefix check
// that could otherwise shadow a more specific one (none currently overlap,
// but each check is independent and returns immediately on match).
// ---------------------------------------------------------------------------

export type SniffedMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif"
  | "video/mp4"
  | "audio/ogg"
  | "audio/mpeg"
  | "audio/webm"
  | "audio/mp4"
  | "audio/wav"
  | "application/pdf"
  | "application/zip"
  | "application/x-msdownload";

/**
 * Reads magic bytes only — never the URL extension, never a caller-supplied
 * `Content-Type` (plan §5.4 point 2/§9 point 1). Returns `null` for anything
 * unrecognised — callers must treat `null` the same as a denylisted type
 * (refuse), never as "assume safe".
 */
export function sniffMime(bytes: Buffer): SniffedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  // WAV: the same RIFF container as webp, form type 'WAVE' (GHL's in-browser recorder can emit it).
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  // EBML header — Matroska/WebM. Sniffed as audio/webm because the WebM GHL
  // sends is its MediaRecorder voice clip; it is never sent as video.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  // ISO-BMFF (MP4 and its relatives): a 4-byte size field then 'ftyp' at
  // offset 4 — the same signature Baileys/every MP4 muxer produces. The
  // major brand (bytes 8–12) tells an audio-only m4a (iOS/Safari recordings)
  // apart from video; every other brand stays video/mp4.
  if (bytes.length >= 8 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const majorBrand = bytes.length >= 12 ? bytes.toString("ascii", 8, 12) : "";
    return M4A_MAJOR_BRANDS.has(majorBrand) ? "audio/mp4" : "video/mp4";
  }
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  // MP3: an ID3v2 tag, OR a bare frame sync (11 set bits: 0xFF Ex/Fx).
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
  // ZIP local-file-header signature — covers plain zips AND every Office
  // Open XML document (docx/xlsx/pptx are zip containers); plan §5.4/§10
  // deliberately does not attempt to distinguish the two at the byte-header
  // level ("ZIP-family for office docs").
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07))
    return "application/zip";
  // Windows PE/DOS executable — recognised specifically so it has a name in
  // logs/tests, but NEVER allowlisted (see isAllowedMime below).
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "application/x-msdownload";
  return null;
}

/** ISO-BMFF major brands that mean an audio-only MPEG-4 file (m4a, m4b audiobook, m4p protected). */
const M4A_MAJOR_BRANDS: ReadonlySet<string> = new Set(["M4A ", "M4B ", "M4P "]);

/**
 * True iff `bytes` is an Ogg stream whose first page carries an Opus id
 * header — the only ogg WhatsApp plays as a voice note. `OggS` at 0 and
 * `OpusHead` at 28 (27-byte page header + the 1-byte segment table every
 * first page has). An Ogg Vorbis file has `\x01vorbis` there instead.
 */
export function isOggOpus(bytes: Buffer): boolean {
  return bytes.length >= 36 && bytes.toString("ascii", 0, 4) === "OggS" && bytes.toString("ascii", 28, 36) === "OpusHead";
}

/**
 * The allowlist (plan §10) — everything else, including `null` (unrecognised), is refused. Both directions share this set.
 * webm, wav and m4a are here for outbound voice notes; that also makes them storable inbound
 * (media-capture.ts), which is intended and harmless — they are plain audio. Outbound webm/wav
 * are still refused unless voice transcoding is on (see mapMimeToBaileysShape).
 */
const ALLOWED_MIME_TYPES: ReadonlySet<SniffedMime> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "audio/ogg",
  "audio/mpeg",
  "audio/webm",
  "audio/mp4",
  "audio/wav",
  "application/pdf",
  "application/zip",
]);

export function isAllowedMime(mime: SniffedMime | null): mime is SniffedMime {
  return mime !== null && ALLOWED_MIME_TYPES.has(mime);
}

/** File extension for a storage object path (inbound, plan §6.1's `{tenantId}/{waMessageId}.{ext}`) — never derived from the sender's claimed filename. */
export function extensionForMime(mime: SniffedMime): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "m4a";
    case "audio/wav":
      return "wav";
    case "application/pdf":
      return "pdf";
    case "application/zip":
      return "zip";
    case "application/x-msdownload":
      return "bin"; // never reached in practice (not allowlisted) — defensive only.
  }
}

// ---------------------------------------------------------------------------
// Inbound storage-path sanitisation (QA Major 4) — `waMessageId` is Baileys'
// `msg.key.id` (src/inbound.ts), a stanza attribute a HOSTILE sender
// controls end to end. It is the one component of the inbound storage path
// (`{coachId}/{waMessageId}.{ext}`, plan §6.1) that isn't ours: `coachId` is
// our own session key (a UUID) and the extension comes from `extensionForMime`
// above (derived from the SNIFFED type, never the sender). Without this
// check, an id containing `/` or `..` yields a traversal-shaped object key —
// `supabase-js` puts the path straight into the storage request URL, where
// dot-segment normalisation can walk it outside the tenant's own prefix.
// Genuine WhatsApp message ids are always short alphanumeric-plus-`=`/`_`/`-`
// tokens (base64url-ish), so this allowlist never rejects a real id.
// ---------------------------------------------------------------------------

const WA_MESSAGE_ID_RE = /^[A-Za-z0-9_=-]{1,128}$/;

/** True iff `id` is safe to interpolate as a storage-object path segment (QA Major 4). Checked at BOTH the call site that builds the path (`media-capture.ts`) and inside `BridgeStore.uploadMediaObject` itself, as defence in depth. */
export function isValidWaMessageId(id: string): boolean {
  return WA_MESSAGE_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Outbound MIME -> Baileys send-shape mapping (plan §5.4's table). Kept here
// (not sessions.ts) so it is testable without a socket.
// ---------------------------------------------------------------------------

export type BaileysMediaKind = "image" | "video" | "audio" | "document";

export interface BaileysMediaMapping {
  kind: BaileysMediaKind;
  /** Voice-note rendering — ONLY true genuine audio/ogg is sent ptt:true (plan decision O5). Undefined for non-audio kinds. */
  ptt?: boolean;
  /**
   * Set only when voice transcoding is on and this audio isn't already ogg/opus: the
   * dispatcher should try transcoding it to an opus voice note. `kind`/`ptt` are then
   * the FALLBACK shape, used as-is if transcoding fails.
   */
  transcodeCandidate?: boolean;
}

/**
 * `null` -> not supported for WhatsApp delivery (plan §5.4's terminal-failure row) — the sniffed type is either unrecognised or not on the outbound allowlist.
 *
 * `opts.bytes` lets audio/ogg be checked for Opus: without it, ogg is assumed opus (the
 * pre-voice-notes behaviour); with it, Ogg Vorbis goes as a plain audio file. `opts.voiceTranscode`
 * (WA_VOICE_TRANSCODE_ENABLED) marks non-opus audio as a transcode candidate and accepts webm/wav,
 * which fall back to a document because WhatsApp can't play them as audio. With it off, webm/wav
 * stay refused, exactly as before.
 */
export function mapMimeToBaileysShape(
  mime: SniffedMime | null,
  opts: { bytes?: Buffer; voiceTranscode?: boolean } = {}
): BaileysMediaMapping | null {
  if (!isAllowedMime(mime)) return null;
  const voiceTranscode = opts.voiceTranscode === true;
  switch (mime) {
    case "image/jpeg":
    case "image/png":
    case "image/webp":
    case "image/gif":
      return { kind: "image" };
    case "video/mp4":
      return { kind: "video" };
    case "audio/ogg":
      if (opts.bytes === undefined || isOggOpus(opts.bytes)) return { kind: "audio", ptt: true }; // genuine opus voice note (plan O5).
      return voiceTranscode ? { kind: "audio", ptt: false, transcodeCandidate: true } : { kind: "audio", ptt: false }; // Ogg Vorbis.
    case "audio/mpeg":
    case "audio/mp4":
      return voiceTranscode ? { kind: "audio", ptt: false, transcodeCandidate: true } : { kind: "audio", ptt: false };
    case "audio/webm":
    case "audio/wav":
      return voiceTranscode ? { kind: "document", transcodeCandidate: true } : null;
    case "application/pdf":
    case "application/zip":
      return { kind: "document" };
    case "application/x-msdownload":
      return null; // never reached — isAllowedMime already excluded it above; kept for switch exhaustiveness.
  }
}

/**
 * Builds the actual Baileys `sock.sendMessage(jid, ...)` payload for a
 * resolved outbound attachment (plan §5.4 point 4). `fileName` — sanitised
 * by the caller (portal), never derived from the URL — is only meaningful
 * for `document`; every other kind ignores it (Baileys itself has no
 * fileName field on image/video/audio). Returns a plain object rather than
 * importing Baileys' own `AnyMessageContent` union here — this module stays
 * Baileys-import-free (matches its "pure, no network, no WhatsApp" header).
 *
 * A voice note (`ptt: true`) always goes as `audio/ogg; codecs=opus`, the mimetype WhatsApp
 * clients expect for one, with `seconds`/`waveform` (from the transcoder) when present. A
 * webm/wav document fallback is named `voice-note.<ext>` unless the caller supplies a name.
 */
export function buildBaileysMediaContent(
  resolved: { kind: BaileysMediaKind; mimetype: SniffedMime; buffer: Buffer; ptt?: boolean; seconds?: number; waveform?: Uint8Array },
  fileName?: string
): Record<string, unknown> {
  switch (resolved.kind) {
    case "image":
      return { image: resolved.buffer, mimetype: resolved.mimetype };
    case "video":
      return { video: resolved.buffer, mimetype: resolved.mimetype };
    case "audio": {
      if (!resolved.ptt) return { audio: resolved.buffer, mimetype: resolved.mimetype, ptt: false };
      const voiceNote: Record<string, unknown> = { audio: resolved.buffer, mimetype: "audio/ogg; codecs=opus", ptt: true };
      if (resolved.seconds !== undefined) voiceNote.seconds = resolved.seconds;
      if (resolved.waveform !== undefined) voiceNote.waveform = resolved.waveform;
      return voiceNote;
    }
    case "document": {
      const isVoiceFallback = resolved.mimetype === "audio/webm" || resolved.mimetype === "audio/wav";
      const defaultName = `${isVoiceFallback ? "voice-note" : "attachment"}.${extensionForMime(resolved.mimetype)}`;
      return { document: resolved.buffer, mimetype: resolved.mimetype, fileName: fileName ?? defaultName };
    }
  }
}

/** Outbound per-type byte cap lookup (plan §5.4's table) — pure, so the dispatch path and its tests share one source of truth. */
export function maxBytesForKind(
  kind: BaileysMediaKind,
  caps: { image: number; video: number; audio: number; document: number }
): number {
  switch (kind) {
    case "image":
      return caps.image;
    case "video":
      return caps.video;
    case "audio":
      return caps.audio;
    case "document":
      return caps.document;
  }
}

// ---------------------------------------------------------------------------
// SSRF guard (plan §5.4 point 1) — refuse private/reserved ranges on the
// RESOLVED address, not the hostname. Pure string/byte arithmetic; the
// caller (fetch integration, below) is responsible for actually resolving
// DNS and feeding the result here before ever opening a socket.
// ---------------------------------------------------------------------------

/**
 * True iff `address` (a literal IPv4 or IPv6 address, as returned by DNS
 * resolution) falls in a private/reserved/loopback/link-local range —
 * the plan's stated list (§5.4): 10/8, 172.16/12, 192.168/16, 127/8,
 * 169.254/16, ::1, fc00::/7, PLUS the QA Minor 9 additions below (everything
 * the plan promised was already implemented and tested; these close gaps
 * beyond that stated list). Also refuses the unspecified addresses
 * (0.0.0.0, ::) and IPv4-mapped IPv6 addresses whose embedded IPv4 is itself
 * disallowed (a common SSRF-guard bypass — `::ffff:127.0.0.1` must be
 * refused exactly like `127.0.0.1`).
 *
 * QA Minor 9 additions: 100.64.0.0/10 (CGNAT — RFC 6598), 198.18.0.0/15
 * (benchmarking — RFC 2544), 192.0.0.0/24 (IETF protocol assignments — RFC
 * 6890), 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved, which also
 * covers 255.255.255.255, the limited broadcast address) — all folded into
 * `isDisallowedIPv4` below; the deprecated IPv4-COMPATIBLE IPv6 form
 * (`::a.b.c.d`, distinct from the IPv4-MAPPED `::ffff:a.b.c.d` already
 * handled) — folded into `extractIPv4` below so it goes through the exact
 * same IPv4 range checks; the NAT64 well-known prefix (`64:ff9b::/96`,
 * RFC 6052) — refused outright, prefix-wide, since it can wrap an
 * arbitrary IPv4 destination and decoding-then-rechecking would just
 * reopen the same "resolves to something that looks safe" surface this
 * guard exists to close; and 6to4 (`2002::/16`, RFC 3056), whose second and
 * third hextets ARE an embedded IPv4 address — decoded and checked against
 * the SAME `isDisallowedIPv4`, so a 6to4 address only blocks when its
 * embedded v4 is itself private/reserved (a 6to4 address wrapping a
 * genuinely public v4 is not itself a bypass).
 */
export function isDisallowedResolvedAddress(address: string): boolean {
  const v4 = extractIPv4(address);
  if (v4) return isDisallowedIPv4(v4);

  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe80:")) return true; // link-local unicast, IPv6's 169.254 equivalent — belt and braces.
  if (lower.startsWith("64:ff9b::")) return true; // NAT64 well-known prefix (QA Minor 9).
  const sixToFour = extractSixToFourIPv4(lower);
  if (sixToFour && isDisallowedIPv4(sixToFour)) return true; // 6to4 wrapping a private/reserved v4 (QA Minor 9).
  return false;
}

/** Pulls the embedded IPv4 out of a plain dotted-quad, an IPv4-mapped IPv6 literal (`::ffff:a.b.c.d`), or the deprecated IPv4-compatible IPv6 form (`::a.b.c.d`, QA Minor 9); `null` for a genuine IPv6 address with no IPv4 form. */
function extractIPv4(address: string): [number, number, number, number] | null {
  const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address);
  const compatible = /^::(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const plain = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const m = mapped ?? compatible ?? plain;
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts;
}

/** Decodes the embedded IPv4 address from a 6to4 (`2002::/16`, RFC 3056) literal — its second and third hextets ARE the IPv4 address in hex. `null` for anything not `2002:`-prefixed or malformed (QA Minor 9). */
function extractSixToFourIPv4(lowerAddress: string): [number, number, number, number] | null {
  const m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(:|$)/.exec(lowerAddress);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isDisallowedIPv4(v4: [number, number, number, number]): boolean {
  const [a, b, c] = v4;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 0) return true; // 0.0.0.0/8, unspecified/"this network"
  // QA Minor 9 additions — beyond the plan's originally-stated list.
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT (RFC 6598).
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking (RFC 2544).
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — IETF protocol assignments (RFC 6890).
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 — multicast.
  if (a >= 240) return true; // 240.0.0.0/4 — reserved; also covers 255.255.255.255, the limited broadcast address.
  return false;
}

// ---------------------------------------------------------------------------
// Byte-cap streaming collector (plan §5.4 point 1 / §6.1) — used by BOTH the
// outbound attachment fetch and the inbound media download. Streams into a
// running total and ABORTS past the cap rather than buffering the whole
// response first — a fixture Readable in tests exercises this with zero
// network (test checklist: "Stream cap: fixture stream longer than cap
// aborts mid-stream, partial data discarded, fixed reason returned").
// ---------------------------------------------------------------------------

export type CollectResult = { ok: true; buffer: Buffer } | { ok: false; reason: "too_large" | "stream_error" };

/**
 * Consumes `stream` chunk by chunk, summing bytes as it goes. The instant
 * the running total would exceed `maxBytes`, the stream is destroyed
 * (`stream.destroy()`) and every byte collected so far is DISCARDED — never
 * returned partially, since a partial file is not a usable file and keeping
 * it around only invites a caller to accidentally store/send a truncated
 * one.
 */
export function collectWithByteCap(stream: Readable, maxBytes: number): Promise<CollectResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: CollectResult) => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      resolve(result);
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        chunks.length = 0; // discard everything collected so far — never a partial file.
        stream.destroy();
        finish({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    stream.on("error", () => finish({ ok: false, reason: "stream_error" }));
  });
}
