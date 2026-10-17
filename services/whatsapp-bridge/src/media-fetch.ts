/**
 * Outbound attachment fetch (docs/MEDIA-PLAN.md §5.4) — the ONE place this
 * package opens an HTTP connection to a URL it did not choose (a GHL
 * workflow's attachment URL, carried in the webhook payload). Everything
 * here is INTEGRATION glue around the pure pieces in `src/media.ts`
 * (`isDisallowedResolvedAddress`, `collectWithByteCap`) — the guard/cap
 * DECISIONS are pure and unit-tested there; this module wires them to real
 * `dns`/`http`/`https`, with both wired dependencies injectable so the
 * pipeline itself (redirects, timeout, cap-abort) is also testable without
 * a real network call (a loopback `http` server, exactly like
 * `test/server.test.ts` already spins up).
 *
 * SSRF GUARD ENFORCEMENT POINT (plan §5.4 point 1 — load-bearing): the guard
 * runs on the RESOLVED address via a custom `lookup` function passed to
 * `http(s).request` for every HOSTNAME url — never on the hostname string
 * alone (a DNS answer can differ from whatever a hostname "looks like", and
 * a TOCTOU re-resolve between "check" and "connect" is exactly the bypass
 * this closes). A blocked resolution makes the lookup callback error, which
 * `http(s).request` surfaces as a request `error` event — never a partial
 * connection.
 *
 * LITERAL-IP URLS DO NOT GO THROUGH THAT CALLBACK (QA Major 3 fix): Node's
 * `net.Socket` short-circuits its own `lookup` call whenever the host is
 * already an IP literal (`net.isIP(host) !== 0`) — `dns.lookup`, and by
 * extension `buildGuardedLookup` below, is simply never invoked for
 * `https://10.0.0.5/x`, `https://[fd00::1]/x`, or `https://2130706433/x`
 * (WHATWG `URL` normalises the decimal form to `127.0.0.1`, itself still a
 * literal). A redirect hop landing on a literal-IP URL bypasses identically.
 * `fetchAttachment`'s per-hop loop below therefore runs the SAME guard
 * function directly against `parsed.hostname` (bracket-stripped) BEFORE
 * ever calling `singleRequest`, whenever that hostname is itself a literal
 * IP — the one case the lookup callback structurally cannot cover. This is
 * belt-and-braces with, not a replacement for, the lookup-callback path:
 * ordinary hostnames still rely entirely on the resolved-address check
 * inside `buildGuardedLookup`.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import {
  collectWithByteCap,
  isDisallowedResolvedAddress,
  mapMimeToBaileysShape,
  maxBytesForKind,
  sniffMime,
  type BaileysMediaKind,
  type SniffedMime,
} from "./media.js";
import type { TranscodeFailureReason, TranscodeResult } from "./voice-transcode.js";

export type FetchAttachmentResult =
  | { ok: true; buffer: Buffer; sniffedMime: SniffedMime | null }
  | { ok: false; reason: "not_https" | "url_too_long" | "ssrf_blocked" | "too_large" | "timeout" | "too_many_redirects" | "fetch_failed" };

export interface FetchAttachmentOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** Injectable for tests — defaults to the real SSRF guard (`isDisallowedResolvedAddress`). Tests that need to reach a loopback fixture server inject a permissive stand-in and separately unit-test the real guard directly. */
  isBlockedAddress?: (address: string) => boolean;
  /** Injectable for tests — defaults to `dns.lookup`. */
  lookup?: typeof dnsLookup;
  /** Enforced by default (plan: "https only"); tests targeting a loopback `http` fixture server pass `false`. */
  requireHttps?: boolean;
}

const MAX_URL_LENGTH = 2048; // plan §5.3 — same bound the bridge API validates on the send route.
const DEFAULT_MAX_REDIRECTS = 3;

export async function fetchAttachment(url: string, opts: FetchAttachmentOptions): Promise<FetchAttachmentResult> {
  if (url.length > MAX_URL_LENGTH) return { ok: false, reason: "url_too_long" };
  const requireHttps = opts.requireHttps ?? true;
  const isBlockedAddress = opts.isBlockedAddress ?? isDisallowedResolvedAddress;
  const lookupFn = opts.lookup ?? dnsLookup;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = url;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
    if (requireHttps && parsed.protocol !== "https:") return { ok: false, reason: "not_https" };
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, reason: "fetch_failed" };

    // QA Major 3 fix — literal-IP hosts never reach `buildGuardedLookup`
    // (see this file's header): `net.isIP` is the same check Node's own
    // `net.Socket` uses to decide whether to skip `dns.lookup` entirely, so
    // it is the correct test for "would the lookup callback have been
    // bypassed". IPv6 literals arrive bracketed in `parsed.hostname`
    // (`[::1]`) — strip the brackets before handing it to the guard, which
    // expects the same bare-address shape `dns.lookup` resolves to.
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && isBlockedAddress(host)) return { ok: false, reason: "ssrf_blocked" };

    const outcome = await singleRequest(parsed, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, isBlockedAddress, lookup: lookupFn });
    if (outcome.kind === "redirect") {
      currentUrl = outcome.location;
      continue;
    }
    if (outcome.kind === "result") return outcome.result;
  }
  return { ok: false, reason: "too_many_redirects" };
}

type SingleRequestOutcome = { kind: "redirect"; location: string } | { kind: "result"; result: FetchAttachmentResult };

/**
 * The SSRF-guard enforcement point (file header) — a custom `lookup`
 * matching `dns.lookup`'s callback signature, built once per request and
 * handed to `http(s).request` as its `lookup` option. Runs on every
 * connection attempt Node's `net.Socket` actually resolves via `dns.lookup`
 * — which is every HOSTNAME target, including the TLS handshake target for
 * https. It is NOT invoked for a literal-IP host (`net.isIP(host) !== 0`):
 * `net.Socket` short-circuits straight past `lookup` in that case, which is
 * why `fetchAttachment` also runs the guard directly against literal-IP
 * hosts before ever reaching this code path (see the file header, QA
 * Major 3).
 *
 * Node's own `net.Socket` calls `lookup` with an OPTIONS object whose shape
 * varies by Node version/settings (notably `{ all: true }` under Happy-
 * Eyeballs/`autoSelectFamily`, which expects the callback to receive an
 * ARRAY of `{address, family}` rather than a single `(address, family)`
 * pair) — this wrapper passes the caller's own options straight through to
 * the injected/real `lookup` (rather than hard-coding `{ all: false }`,
 * which silently mismatched the shape `net.Socket` actually asked for and
 * made EVERY real request fail, blocked or not — not just blocked ones) and
 * normalises whichever shape comes back into a flat list. EVERY resolved
 * address is checked against the guard, not just the first — a hostname
 * that resolves to both a public and a private address must not sneak a
 * private one through just because it wasn't first in the list.
 *
 * Extracted as its own top-level, exported function (rather than inlined in
 * `singleRequest` below) specifically so `test/media-fetch.test.ts` can
 * exercise the `{ all: true }` array-shape branch DIRECTLY — invoking it
 * with a fake underlying `lookup` and asserting on exactly what options it
 * was called with, and exactly what shape the outer callback receives —
 * rather than only indirectly through a real Node request, whose choice to
 * call this with `{ all: true }` at all depends on Node version and
 * `autoSelectFamily` defaults neither this file nor its tests control.
 */
export function buildGuardedLookup(opts: { isBlockedAddress: (address: string) => boolean; lookup: typeof dnsLookup }): typeof dnsLookup {
  return ((hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const hasOptions = typeof optionsOrCallback !== "function";
    const lookupOptions = hasOptions ? (optionsOrCallback as object) : {};
    const callback = (hasOptions ? maybeCallback : optionsOrCallback) as (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

    opts.lookup(hostname, lookupOptions as never, ((err: NodeJS.ErrnoException | null, address: LookupAddress | LookupAddress[] | string, family?: number) => {
      if (err) {
        callback(err);
        return;
      }
      const resolvedList: { address: string; family: number }[] = Array.isArray(address)
        ? address.map((a) => ({ address: a.address, family: a.family }))
        : [{ address: typeof address === "string" ? address : address.address, family: typeof address === "string" ? (family ?? 4) : address.family }];

      const blocked = resolvedList.find((a) => opts.isBlockedAddress(a.address));
      if (blocked) {
        const blockedErr = new Error("ssrf_blocked") as NodeJS.ErrnoException;
        blockedErr.code = "SSRF_BLOCKED";
        callback(blockedErr);
        return;
      }

      // Output shape must match what THIS caller (net.js) actually asked
      // for via `lookupOptions.all` — NOT merely mirror whatever shape the
      // underlying lookup happened to hand back (an injected test double
      // may ignore `all` entirely and always return one shape; the real
      // `dns.lookup` honours it, but relying on that coincidence would
      // make this code correct only against the real implementation).
      const wantsAll = (lookupOptions as { all?: boolean }).all === true;
      if (wantsAll) {
        callback(null, resolvedList);
      } else {
        callback(null, resolvedList[0]?.address, resolvedList[0]?.family);
      }
    }) as never);
  }) as unknown as typeof dnsLookup;
}

function singleRequest(
  url: URL,
  opts: { timeoutMs: number; maxBytes: number; isBlockedAddress: (address: string) => boolean; lookup: typeof dnsLookup }
): Promise<SingleRequestOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SingleRequestOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const guardedLookup = buildGuardedLookup({ isBlockedAddress: opts.isBlockedAddress, lookup: opts.lookup });

    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(url, { method: "GET", lookup: guardedLookup }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain — we're not reading this body.
        settle({ kind: "redirect", location: new URL(res.headers.location, url).toString() });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        settle({ kind: "result", result: { ok: false, reason: "fetch_failed" } });
        return;
      }
      void collectWithByteCap(res, opts.maxBytes).then((collected) => {
        if (!collected.ok) {
          settle({ kind: "result", result: { ok: false, reason: collected.reason === "too_large" ? "too_large" : "fetch_failed" } });
          return;
        }
        settle({ kind: "result", result: { ok: true, buffer: collected.buffer, sniffedMime: sniffMime(collected.buffer) } });
      });
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "SSRF_BLOCKED") {
        settle({ kind: "result", result: { ok: false, reason: "ssrf_blocked" } });
        return;
      }
      settle({ kind: "result", result: { ok: false, reason: "fetch_failed" } });
    });

    const timer = setTimeout(() => {
      req.destroy();
      settle({ kind: "result", result: { ok: false, reason: "timeout" } });
    }, opts.timeoutMs);
    // Never keep the process alive on a stuck timer (mirrors sessions.ts's `.unref()` convention).
    timer.unref?.();

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Outbound attachment resolution (plan §5.4) — fetch + sniff + type-cap +
// map, one call. `sessions.ts`'s dispatch path calls this AFTER the
// onWhatsApp existence check and BEFORE `pacer.recordSend()` (plan's exact
// ordering — a fetch/sniff/cap/type failure never consumes a pacer slot,
// since the send API was never invoked for it; `dispatch_attempted` stays
// `false` for every failure this function can produce).
// ---------------------------------------------------------------------------

export interface OutboundAttachmentCaps {
  image: number;
  video: number;
  audio: number;
  document: number;
}

export type ResolveOutboundAttachmentResult =
  | {
      ok: true;
      kind: BaileysMediaKind;
      mimetype: SniffedMime;
      buffer: Buffer;
      ptt?: boolean;
      /** Non-opus audio while voice transcoding is on: `kind`/`ptt` are the fallback shape (see `mapMimeToBaileysShape`). */
      transcodeCandidate?: boolean;
    }
  | { ok: false; reason: "fetch_failed" | "too_large_for_type" | "unsupported_type" };

export type ResolvedOutboundAttachment = Extract<ResolveOutboundAttachmentResult, { ok: true }>;

/**
 * The per-type cap (plan §5.4's table) can't be applied UNTIL the type is
 * known, and the type isn't known until the bytes are sniffed — so the fetch
 * itself is bounded by the LARGEST configured cap across all four types
 * (never unbounded), and the type-specific cap is re-checked against the
 * actual downloaded size once sniffing resolves it. A file that is, say, a
 * 40MB image (over the 10MB image cap but under the 100MB document cap) is
 * still refused post-sniff — never silently accepted because it fit under
 * some OTHER type's larger cap.
 *
 * `voiceTranscode` (WA_VOICE_TRANSCODE_ENABLED with ffmpeg present) marks
 * non-opus audio as a transcode candidate and admits webm/wav. A candidate is
 * always capped at `caps.audio` — the transcoder's input cap — even when its
 * fallback kind is `document`, so oversized audio is refused here, before
 * ffmpeg could ever see it. The sniffed bytes go to the mapping so Ogg Vorbis
 * is never sent as a voice note.
 */
export async function resolveOutboundAttachment(
  url: string,
  opts: Omit<FetchAttachmentOptions, "maxBytes"> & { caps: OutboundAttachmentCaps; voiceTranscode?: boolean }
): Promise<ResolveOutboundAttachmentResult> {
  const outerCap = Math.max(opts.caps.image, opts.caps.video, opts.caps.audio, opts.caps.document);
  const fetched = await fetchAttachment(url, { ...opts, maxBytes: outerCap });
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason === "too_large" ? "too_large_for_type" : "fetch_failed" };
  }
  const mapped = mapMimeToBaileysShape(fetched.sniffedMime, { bytes: fetched.buffer, voiceTranscode: opts.voiceTranscode === true });
  if (!mapped || !fetched.sniffedMime) return { ok: false, reason: "unsupported_type" };
  const cap = mapped.transcodeCandidate ? opts.caps.audio : maxBytesForKind(mapped.kind, opts.caps);
  if (fetched.buffer.length > cap) return { ok: false, reason: "too_large_for_type" };
  const resolved: ResolvedOutboundAttachment = { ok: true, kind: mapped.kind, mimetype: fetched.sniffedMime, buffer: fetched.buffer, ptt: mapped.ptt };
  if (mapped.transcodeCandidate) resolved.transcodeCandidate = true;
  return resolved;
}

/**
 * Voice notes: turns a transcode candidate into an ogg/opus voice note. Any
 * failure — whatever the reason, including ones added later, and a thrown
 * error (counted as `ffmpeg_failed`) — returns `resolved` unchanged, i.e. the
 * fallback shape (an audio file, or a document for webm/wav). The one
 * exception is `has_video`: the same original bytes, but always as a
 * document, since a video must never play as audio. It never fails the
 * message. Not a candidate → `not_needed`, untouched.
 */
export async function prepareOutboundAudio(
  resolved: ResolvedOutboundAttachment,
  deps: { transcode: (buf: Buffer, mime: SniffedMime) => Promise<TranscodeResult> }
): Promise<{
  content: ResolvedOutboundAttachment & { seconds?: number; waveform?: Uint8Array };
  outcome: "transcoded" | "not_needed" | TranscodeFailureReason;
}> {
  if (!resolved.transcodeCandidate) return { content: resolved, outcome: "not_needed" };
  let result: TranscodeResult;
  try {
    result = await deps.transcode(resolved.buffer, resolved.mimetype);
  } catch {
    result = { ok: false, reason: "ffmpeg_failed" };
  }
  if (!result.ok && result.reason === "has_video") {
    return { content: { ok: true, kind: "document", mimetype: resolved.mimetype, buffer: resolved.buffer }, outcome: "has_video" };
  }
  if (!result.ok) return { content: resolved, outcome: result.reason };
  return {
    content: { ok: true, kind: "audio", mimetype: "audio/ogg", ptt: true, buffer: result.buffer, seconds: result.seconds, waveform: result.waveform },
    outcome: "transcoded",
  };
}
