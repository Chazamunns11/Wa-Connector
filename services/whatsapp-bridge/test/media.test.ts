/**
 * src/media.ts — the shared, PURE media-plan primitives (docs/MEDIA-PLAN.md):
 * magic-byte sniffing, the allowlist, the outbound MIME->Baileys mapping, the
 * SSRF guard, and the byte-cap streaming collector. No network, no Baileys,
 * no Supabase — fixture buffers/fake streams only (README.md's convention).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  buildBaileysMediaContent,
  collectWithByteCap,
  extensionForMime,
  isAllowedMime,
  isDisallowedResolvedAddress,
  isValidWaMessageId,
  mapMimeToBaileysShape,
  maxBytesForKind,
  sniffMime,
} from "../src/media.js";

// ---------------------------------------------------------------------------
// sniffMime — magic-byte fixtures (test checklist: "jpeg/png/webp/gif/mp4/
// ogg/mp3/pdf/zip-office/exe/unknown -> correct MIME").
// ---------------------------------------------------------------------------

function bytes(...hex: number[]): Buffer {
  return Buffer.from(hex);
}

test("sniffMime: jpeg magic bytes", () => {
  assert.equal(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)), "image/jpeg");
});

test("sniffMime: png magic bytes", () => {
  assert.equal(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)), "image/png");
});

test("sniffMime: webp (RIFF....WEBP)", () => {
  const buf = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
  assert.equal(sniffMime(buf), "image/webp");
});

test("sniffMime: gif87a and gif89a", () => {
  assert.equal(sniffMime(Buffer.from("GIF87a")), "image/gif");
  assert.equal(sniffMime(Buffer.from("GIF89a")), "image/gif");
});

test("sniffMime: mp4 (ISO-BMFF ftyp box)", () => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from("mp42")]);
  assert.equal(sniffMime(buf), "video/mp4");
});

test("sniffMime: ogg (OggS)", () => {
  assert.equal(sniffMime(Buffer.from("OggS\x00\x02")), "audio/ogg");
});

test("sniffMime: mp3 via ID3 tag", () => {
  assert.equal(sniffMime(Buffer.from("ID3\x03\x00")), "audio/mpeg");
});

test("sniffMime: mp3 via bare frame sync", () => {
  assert.equal(sniffMime(bytes(0xff, 0xfb, 0x90, 0x00)), "audio/mpeg");
});

test("sniffMime: pdf (%PDF)", () => {
  assert.equal(sniffMime(Buffer.from("%PDF-1.4")), "application/pdf");
});

test("sniffMime: zip / office documents (PK local-file-header)", () => {
  assert.equal(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04)), "application/zip");
});

test("sniffMime: exe (MZ header) is recognised but never allowlisted", () => {
  const sniffed = sniffMime(bytes(0x4d, 0x5a, 0x90, 0x00));
  assert.equal(sniffed, "application/x-msdownload");
  assert.equal(isAllowedMime(sniffed), false);
});

test("sniffMime: unrecognised bytes -> null, treated as denylisted", () => {
  const sniffed = sniffMime(Buffer.from("not a real file at all"));
  assert.equal(sniffed, null);
  assert.equal(isAllowedMime(sniffed), false);
});

test("sniffMime: header/extension disagreement — sniff always wins (caller never even sees the extension here, proving the module has no such input)", () => {
  // sniffMime's signature takes only bytes — there is no extension/Content-Type
  // parameter it could possibly be swayed by. A jpeg's magic bytes sniff as
  // jpeg regardless of what filename or header a caller might have seen.
  const jpegBytesNamedAsPdf = bytes(0xff, 0xd8, 0xff, 0xe1);
  assert.equal(sniffMime(jpegBytesNamedAsPdf), "image/jpeg");
});

// ---------------------------------------------------------------------------
// isAllowedMime / extensionForMime
// ---------------------------------------------------------------------------

test("isAllowedMime: every sniffable image/video/audio/pdf/zip type is allowed", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "audio/ogg", "audio/mpeg", "application/pdf", "application/zip"] as const) {
    assert.equal(isAllowedMime(mime), true, mime);
  }
});

test("extensionForMime: every allowed type maps to a sane extension", () => {
  assert.equal(extensionForMime("image/jpeg"), "jpg");
  assert.equal(extensionForMime("video/mp4"), "mp4");
  assert.equal(extensionForMime("audio/ogg"), "ogg");
  assert.equal(extensionForMime("application/pdf"), "pdf");
  assert.equal(extensionForMime("application/zip"), "zip");
});

// ---------------------------------------------------------------------------
// isValidWaMessageId (QA Major 4) — guards the inbound storage path
// (`{coachId}/{waMessageId}.{ext}`) against a hostile sender-controlled id.
// ---------------------------------------------------------------------------

test("isValidWaMessageId: a genuine WhatsApp-shaped id (base64url-ish) is accepted", () => {
  assert.equal(isValidWaMessageId("3EB0" + "A".repeat(16)), true);
  assert.equal(isValidWaMessageId("abc_DEF-123=="), true);
});

test("isValidWaMessageId: a path-traversal id ('../') is refused", () => {
  assert.equal(isValidWaMessageId("../../etc/passwd"), false);
});

test("isValidWaMessageId: an id containing a bare '/' is refused", () => {
  assert.equal(isValidWaMessageId("other-tenant/secret"), false);
});

test("isValidWaMessageId: an empty id is refused", () => {
  assert.equal(isValidWaMessageId(""), false);
});

test("isValidWaMessageId: an id over 128 characters is refused", () => {
  assert.equal(isValidWaMessageId("A".repeat(129)), false);
});

test("isValidWaMessageId: an id at exactly 128 characters is accepted (boundary is inclusive)", () => {
  assert.equal(isValidWaMessageId("A".repeat(128)), true);
});

test("isValidWaMessageId: other path-hostile characters (backslash, null byte, space) are refused", () => {
  assert.equal(isValidWaMessageId("a\\b"), false);
  assert.equal(isValidWaMessageId("a\0b"), false);
  assert.equal(isValidWaMessageId("a b"), false);
});

// ---------------------------------------------------------------------------
// mapMimeToBaileysShape / maxBytesForKind / buildBaileysMediaContent (plan
// §5.4's table) — incl. "ptt: true ONLY for ogg/opus".
// ---------------------------------------------------------------------------

test("mapMimeToBaileysShape: images -> image kind", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif"] as const) {
    assert.deepEqual(mapMimeToBaileysShape(mime), { kind: "image" });
  }
});

test("mapMimeToBaileysShape: video/mp4 -> video kind", () => {
  assert.deepEqual(mapMimeToBaileysShape("video/mp4"), { kind: "video" });
});

test("mapMimeToBaileysShape: audio/ogg -> audio kind WITH ptt:true (genuine voice note)", () => {
  assert.deepEqual(mapMimeToBaileysShape("audio/ogg"), { kind: "audio", ptt: true });
});

test("mapMimeToBaileysShape: audio/mpeg -> audio kind WITHOUT ptt (not a voice note)", () => {
  assert.deepEqual(mapMimeToBaileysShape("audio/mpeg"), { kind: "audio", ptt: false });
});

test("mapMimeToBaileysShape: pdf and zip -> document kind", () => {
  assert.deepEqual(mapMimeToBaileysShape("application/pdf"), { kind: "document" });
  assert.deepEqual(mapMimeToBaileysShape("application/zip"), { kind: "document" });
});

test("mapMimeToBaileysShape: denylisted (exe) or unrecognised (null) -> null, terminal", () => {
  assert.equal(mapMimeToBaileysShape("application/x-msdownload"), null);
  assert.equal(mapMimeToBaileysShape(null), null);
});

test("maxBytesForKind: looks up the correct per-type cap", () => {
  const caps = { image: 10, video: 50, audio: 16, document: 100 };
  assert.equal(maxBytesForKind("image", caps), 10);
  assert.equal(maxBytesForKind("video", caps), 50);
  assert.equal(maxBytesForKind("audio", caps), 16);
  assert.equal(maxBytesForKind("document", caps), 100);
});

test("buildBaileysMediaContent: image/video shapes carry only buffer+mimetype", () => {
  const buf = Buffer.from("x");
  assert.deepEqual(buildBaileysMediaContent({ kind: "image", mimetype: "image/jpeg", buffer: buf }), { image: buf, mimetype: "image/jpeg" });
  assert.deepEqual(buildBaileysMediaContent({ kind: "video", mimetype: "video/mp4", buffer: buf }), { video: buf, mimetype: "video/mp4" });
});

test("buildBaileysMediaContent: audio carries ptt, defaulting false when unset", () => {
  const buf = Buffer.from("x");
  assert.deepEqual(buildBaileysMediaContent({ kind: "audio", mimetype: "audio/ogg", buffer: buf, ptt: true }), { audio: buf, mimetype: "audio/ogg", ptt: true });
  assert.deepEqual(buildBaileysMediaContent({ kind: "audio", mimetype: "audio/mpeg", buffer: buf }), { audio: buf, mimetype: "audio/mpeg", ptt: false });
});

test("buildBaileysMediaContent: document carries the caller's fileName, or a sniffed-extension default", () => {
  const buf = Buffer.from("x");
  assert.deepEqual(buildBaileysMediaContent({ kind: "document", mimetype: "application/pdf", buffer: buf }, "invoice.pdf"), {
    document: buf,
    mimetype: "application/pdf",
    fileName: "invoice.pdf",
  });
  assert.deepEqual(buildBaileysMediaContent({ kind: "document", mimetype: "application/pdf", buffer: buf }), {
    document: buf,
    mimetype: "application/pdf",
    fileName: "attachment.pdf",
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — plan §5.4's exact list: 10/8, 172.16/12, 192.168/16, 127/8,
// 169.254/16, ::1, fc00::/7.
// ---------------------------------------------------------------------------

test("isDisallowedResolvedAddress: every listed private/reserved range is blocked", () => {
  const blocked = [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.1.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
  ];
  for (const addr of blocked) assert.equal(isDisallowedResolvedAddress(addr), true, addr);
});

test("isDisallowedResolvedAddress: 172.x OUTSIDE the 16-31 second-octet range is NOT blocked by the 172.16/12 rule", () => {
  assert.equal(isDisallowedResolvedAddress("172.15.0.1"), false);
  assert.equal(isDisallowedResolvedAddress("172.32.0.1"), false);
});

test("isDisallowedResolvedAddress: ordinary public addresses are allowed", () => {
  for (const addr of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isDisallowedResolvedAddress(addr), false, addr);
  }
});

test("isDisallowedResolvedAddress: IPv4-mapped IPv6 loopback is blocked exactly like the plain IPv4 form (a common guard-bypass)", () => {
  assert.equal(isDisallowedResolvedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isDisallowedResolvedAddress("::ffff:10.0.0.5"), true);
});

test("isDisallowedResolvedAddress: unspecified addresses (0.0.0.0, ::) are blocked", () => {
  assert.equal(isDisallowedResolvedAddress("0.0.0.0"), true);
  assert.equal(isDisallowedResolvedAddress("::"), true);
});

// ---------------------------------------------------------------------------
// QA Minor 9 — SSRF range-list gaps beyond the plan's originally-stated list.
// Everything the plan promised was already implemented and tested above;
// these close the additional gaps the QA pass identified.
// ---------------------------------------------------------------------------

test("isDisallowedResolvedAddress: 100.64.0.0/10 (CGNAT) is blocked, and the boundaries just outside it are not", () => {
  assert.equal(isDisallowedResolvedAddress("100.64.0.1"), true);
  assert.equal(isDisallowedResolvedAddress("100.100.0.1"), true);
  assert.equal(isDisallowedResolvedAddress("100.127.255.255"), true);
  assert.equal(isDisallowedResolvedAddress("100.63.255.255"), false);
  assert.equal(isDisallowedResolvedAddress("100.128.0.1"), false);
});

test("isDisallowedResolvedAddress: 198.18.0.0/15 (benchmarking) is blocked", () => {
  assert.equal(isDisallowedResolvedAddress("198.18.0.1"), true);
  assert.equal(isDisallowedResolvedAddress("198.19.255.255"), true);
  assert.equal(isDisallowedResolvedAddress("198.17.255.255"), false);
  assert.equal(isDisallowedResolvedAddress("198.20.0.1"), false);
});

test("isDisallowedResolvedAddress: 192.0.0.0/24 (IETF protocol assignments) is blocked, but the rest of 192.0.x/16 is not", () => {
  assert.equal(isDisallowedResolvedAddress("192.0.0.1"), true);
  assert.equal(isDisallowedResolvedAddress("192.0.0.255"), true);
  assert.equal(isDisallowedResolvedAddress("192.0.1.1"), false);
});

test("isDisallowedResolvedAddress: 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved, incl. 255.255.255.255 broadcast) are blocked", () => {
  assert.equal(isDisallowedResolvedAddress("224.0.0.1"), true);
  assert.equal(isDisallowedResolvedAddress("239.255.255.255"), true);
  assert.equal(isDisallowedResolvedAddress("240.0.0.1"), true);
  assert.equal(isDisallowedResolvedAddress("255.255.255.255"), true);
  assert.equal(isDisallowedResolvedAddress("223.255.255.255"), false, "just below the multicast range");
});

test("isDisallowedResolvedAddress: IPv6 ::a.b.c.d (deprecated IPv4-compatible form) applies the SAME IPv4 range checks to the embedded address", () => {
  assert.equal(isDisallowedResolvedAddress("::10.0.0.5"), true, "embeds a private v4 address");
  assert.equal(isDisallowedResolvedAddress("::127.0.0.1"), true, "embeds a loopback v4 address");
  assert.equal(isDisallowedResolvedAddress("::1.1.1.1"), false, "embeds a genuinely public v4 address — must not be confused with ::1 loopback");
});

test("isDisallowedResolvedAddress: NAT64 (64:ff9b::/96) is refused outright, regardless of what it wraps", () => {
  assert.equal(isDisallowedResolvedAddress("64:ff9b::808:808"), true, "wraps a public v4 (8.8.8.8) — still refused, whole prefix is blocked");
  assert.equal(isDisallowedResolvedAddress("64:ff9b::a00:1"), true);
});

test("isDisallowedResolvedAddress: 6to4 (2002::/16) applies the SAME IPv4 range checks to its embedded address — only blocks when that embedded address is itself private/reserved", () => {
  assert.equal(isDisallowedResolvedAddress("2002:a00:1::"), true, "embeds 10.0.0.1 — private");
  assert.equal(isDisallowedResolvedAddress("2002:7f00:1::"), true, "embeds 127.0.0.1 — loopback");
  assert.equal(isDisallowedResolvedAddress("2002:101:101::"), false, "embeds 1.1.1.1 — genuinely public, not itself a bypass");
});

// ---------------------------------------------------------------------------
// collectWithByteCap — fixture streams, no network (test checklist: "Stream
// cap: fixture stream longer than cap aborts mid-stream, partial data
// discarded, fixed reason returned").
// ---------------------------------------------------------------------------

test("collectWithByteCap: a stream under the cap collects fully", async () => {
  const stream = new PassThrough();
  const resultPromise = collectWithByteCap(stream, 1024);
  stream.write(Buffer.from("hello "));
  stream.write(Buffer.from("world"));
  stream.end();
  const result = await resultPromise;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.buffer.toString("utf8"), "hello world");
});

test("collectWithByteCap: a stream that exceeds the cap aborts mid-stream — partial data discarded, fixed reason returned", async () => {
  const stream = new PassThrough();
  const resultPromise = collectWithByteCap(stream, 10);
  let destroyed = false;
  stream.on("close", () => {
    destroyed = true;
  });
  stream.write(Buffer.from("0123456789")); // exactly at the cap — still ok
  stream.write(Buffer.from("X")); // pushes over — must abort here
  const result = await resultPromise;
  assert.deepEqual(result, { ok: false, reason: "too_large" });
  // The stream must actually have been destroyed (aborted), not merely ignored.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(destroyed, true);
});

test("collectWithByteCap: a stream error is reported, not thrown", async () => {
  const stream = new PassThrough();
  const resultPromise = collectWithByteCap(stream, 1024);
  stream.emit("error", new Error("simulated network failure"));
  const result = await resultPromise;
  assert.deepEqual(result, { ok: false, reason: "stream_error" });
});

test("collectWithByteCap: an exactly-at-cap stream is accepted (boundary is inclusive)", async () => {
  const stream = new PassThrough();
  const resultPromise = collectWithByteCap(stream, 5);
  stream.end(Buffer.from("12345"));
  const result = await resultPromise;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.buffer.length, 5);
});
