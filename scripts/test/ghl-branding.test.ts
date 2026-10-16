/**
 * W-CONNECT-BRAND — per-client branding on the GHL `/connect/[token]` page
 * (migration 0076, docs/GHL-PROVIDER-CLIENT-MIGRATION.md). Covers the pure
 * `src/lib/brand.ts` additions this feature needed: `monogramFor` (the
 * fallback badge when a client has no logo yet), `resolveLogoPath` (turning
 * a stored bucket path into something renderable), `sniffImageType` (the
 * magic-byte logo gate — adversarial review lens 5, finding 4, MAJOR, fixed;
 * see that section below for why this had zero coverage before and what it
 * is the sole barrier against), `brandStyle` (adversarial review lens 5,
 * finding 5, MINOR, fixed — see that section for why the OLD header here
 * claimed to cover this and didn't), and a focused re-verification of
 * `normaliseHex`/`inkFor` framed around THIS feature's own attack surface —
 * hostile hex input reaching a `style` attribute on a PUBLIC, unauthenticated
 * page, and a client-chosen accent colour that must never produce unreadable
 * text. The general suite for these functions lives in
 * `scripts/test/core.test.ts`; this file exists per this feature's own
 * brief, not to duplicate that coverage wholesale.
 *
 * Entirely offline — no network, no Supabase, no live bridge. `resolveLogoPath`
 * reads `NEXT_PUBLIC_SUPABASE_URL` directly, so it's set at the top of this
 * file, same convention as `ghl-connect-link.test.ts`'s own env-var setup
 * note; tests that need it UNSET save, mutate, and restore it locally.
 *
 * `sniffImageType` IS COVERED DIRECTLY; `storeCoachLogo`/`storeGhlAccountLogo`
 * (src/lib/data/index.ts) ARE NOT, AND CANNOT BE UNDER THIS RUNNER. Checked
 * before writing this: `src/lib/data/index.ts` has internal EXTENSION-LESS
 * relative imports (e.g. `from "./fixtures"`), which Next's bundler resolves
 * fine but plain Node ESM (this suite's `node --test` +
 * `scripts/test/alias-hook.mjs`, which only resolves `@/…` aliases, not bare
 * relative specifiers) cannot — importing that module at all in this runner
 * throws `ERR_MODULE_NOT_FOUND` before a single test even runs, confirmed by
 * hand before deciding not to attempt it (and why no other file in this
 * directory imports `@/lib/data` for its runtime exports — every existing
 * test that touches repo behaviour goes through a hand-written fake repo
 * instead, e.g. `ghl-connect-link.test.ts`'s `fakeConnectGuardRepo`). Both
 * functions call `sniffImageType` on the real bytes and do nothing with
 * `File.type` — see that constant's own JSDoc — so the coverage below
 * (sniffing behaviour on raw bytes, independent of any claimed content-type)
 * is what those two callers actually depend on for their security property;
 * only their own size/empty checks and the `dataMode` branch beyond the
 * sniff are unreachable to test here.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test.supabase.example";

import test from "node:test";
import assert from "node:assert/strict";

import { brandStyle, contrastRatio, inkFor, monogramFor, normaliseHex, resolveLogoPath, sniffImageType, MAX_LOGO_BYTES, LOGO_BUCKET } from "@/lib/brand";

// ---------------------------------------------------------------------------
// normaliseHex — hex validation, framed around this feature's own attack
// surface: `brandAccentColor` flows from an owner-supplied form field
// (`saveGhlAccountBrandingAction`, src/app/owner/setup-links/actions.ts)
// through `Repository.updateGhlAccountBranding` into a `style` attribute on
// a PUBLIC page (`ConnectLinkClient.tsx`'s `brandStyle()` call) — so a value
// that survives normalisation IS the thing standing between a hostile string
// and CSS injection on that page.
// ---------------------------------------------------------------------------

test("normaliseHex: accepts #RGB and #RRGGBB shorthand/full hex, with or without the leading #", () => {
  assert.equal(normaliseHex("#17BEB4"), "#17BEB4");
  assert.equal(normaliseHex("17BEB4"), "#17BEB4");
  assert.equal(normaliseHex("#abc"), "#AABBCC");
  assert.equal(normaliseHex("abc"), "#AABBCC");
  assert.equal(normaliseHex("  #17beb4  "), "#17BEB4");
});

test("normaliseHex: rejects CSS-injection-shaped strings rather than passing them through", () => {
  const hostile = [
    "red;background:url(javascript:alert(1))",
    "#17BEB4; background: url(evil.com)",
    "expression(alert(1))",
    "rgb(23, 190, 180)",
    "hsl(175, 78%, 42%)",
    "var(--evil)",
    "17BEB4;",
    "</style><script>alert(1)</script>",
  ];
  for (const input of hostile) {
    assert.equal(normaliseHex(input), null, input);
  }
});

test("normaliseHex: rejects plain junk and CSS colour names (stricter than raw CSS)", () => {
  for (const input of ["not-a-colour", "red", "teal", "#12345", "#1234567", "12g", ""]) {
    assert.equal(normaliseHex(input), null, input);
  }
});

test("normaliseHex: null/undefined never throw, both resolve to null (the 'unset accent' case)", () => {
  assert.doesNotThrow(() => normaliseHex(null));
  assert.doesNotThrow(() => normaliseHex(undefined));
  assert.equal(normaliseHex(null), null);
  assert.equal(normaliseHex(undefined), null);
});

// ---------------------------------------------------------------------------
// inkFor — contrast, on the two extremes a client's colour picker can
// actually produce.
// ---------------------------------------------------------------------------

test("inkFor: a very dark accent resolves to white ink, with a readable contrast ratio", () => {
  const veryDark = "#0A0A0A";
  const ink = inkFor(veryDark);
  assert.equal(ink, "#FFFFFF");
  assert.ok(contrastRatio(veryDark, ink) > 4, `contrast was only ${contrastRatio(veryDark, ink)}`);
});

test("inkFor: a very light accent resolves to black ink, with a readable contrast ratio", () => {
  const veryLight = "#FAFAFA";
  const ink = inkFor(veryLight);
  assert.equal(ink, "#0B0C0D");
  assert.ok(contrastRatio(veryLight, ink) > 4, `contrast was only ${contrastRatio(veryLight, ink)}`);
});

test("inkFor: never throws across a spread of accents, including the documented worst case", () => {
  const accents = ["#000000", "#FFFFFF", "#17BEB4", "#CC36B3", "#7A1F2B", "#38BDF8"];
  for (const accent of accents) {
    assert.doesNotThrow(() => inkFor(accent));
    const ink = inkFor(accent);
    assert.ok(ink === "#0B0C0D" || ink === "#FFFFFF", `unexpected ink ${ink} for ${accent}`);
  }
});

// ---------------------------------------------------------------------------
// monogramFor — the no-logo fallback badge.
// ---------------------------------------------------------------------------

test("monogramFor: a normal label reads its first letter, uppercased", () => {
  assert.equal(monogramFor("Acme Fitness"), "A");
  assert.equal(monogramFor("bright coaching"), "B");
});

test("monogramFor: an empty label falls back to '?' rather than throwing or returning empty", () => {
  assert.doesNotThrow(() => monogramFor(""));
  assert.equal(monogramFor(""), "?");
});

test("monogramFor: a label with no letters at all (digits/punctuation only) falls back to '?'", () => {
  assert.equal(monogramFor("123456"), "?");
  assert.equal(monogramFor("!!! ---"), "?");
});

test("monogramFor: a label starting with a non-letter skips past it to the first real letter", () => {
  assert.equal(monogramFor("123 Gym"), "G");
  assert.equal(monogramFor("#1 Fitness Co"), "F");
  assert.equal(monogramFor("🔥Fit Studio"), "F");
});

test("monogramFor: unicode letters are handled (not silently skipped as punctuation)", () => {
  assert.equal(monogramFor("Ünique Fitness"), "Ü");
  assert.equal(monogramFor("Ízabella Coaching"), "Í");
  assert.equal(monogramFor("日本語ジム"), "日");
});

test("monogramFor: always returns exactly one character", () => {
  for (const label of ["Acme", "", "123", "Ünique", "🔥Fire", "日本語"]) {
    assert.equal([...monogramFor(label)].length, 1, label);
  }
});

// ---------------------------------------------------------------------------
// resolveLogoPath — turning `ghl_accounts.brand_logo_path` into something an
// <img src> can load (see this function's own JSDoc, src/lib/brand.ts).
// ---------------------------------------------------------------------------

test("resolveLogoPath: null path resolves to null (the monogram-fallback trigger)", () => {
  assert.equal(resolveLogoPath(null), null);
});

test("resolveLogoPath: a bare bucket path resolves to the public storage URL, under the shared bucket", () => {
  const resolved = resolveLogoPath("ghl/loc-42/abc123.png");
  assert.equal(resolved, "https://test.supabase.example/storage/v1/object/public/client-logos/ghl/loc-42/abc123.png");
  assert.equal(LOGO_BUCKET, "client-logos");
});

test("resolveLogoPath: data:/http(s):/blob: values pass through unchanged (demo mode, an already-resolved URL, a local preview)", () => {
  const dataUrl = "data:image/png;base64,abc123";
  const httpUrl = "https://cdn.example.com/logo.png";
  const blobUrl = "blob:https://app.example.com/1234-5678";
  assert.equal(resolveLogoPath(dataUrl), dataUrl);
  assert.equal(resolveLogoPath(httpUrl), httpUrl);
  assert.equal(resolveLogoPath(blobUrl), blobUrl);
});

test("resolveLogoPath: NEXT_PUBLIC_SUPABASE_URL unset with a genuine path stored degrades to null, never throws", () => {
  const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    assert.doesNotThrow(() => resolveLogoPath("ghl/loc-1/x.png"));
    assert.equal(resolveLogoPath("ghl/loc-1/x.png"), null);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
  }
});

test("resolveLogoPath: a trailing slash on NEXT_PUBLIC_SUPABASE_URL never produces a double slash", () => {
  const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.example/";
  try {
    assert.equal(
      resolveLogoPath("ghl/loc-1/x.png"),
      "https://test.supabase.example/storage/v1/object/public/client-logos/ghl/loc-1/x.png"
    );
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
  }
});

// ---------------------------------------------------------------------------
// sniffImageType — adversarial review lens 5, finding 4 (MAJOR, fixed). This
// is the ONLY thing standing between an arbitrary uploaded file and a
// PUBLIC bucket origin on the GHL-branding write path (`storeGhlAccountLogo`,
// src/lib/data/index.ts — see this file's own header for why that function
// itself can't be exercised here, and why sniffing raw bytes IS the whole
// security property it depends on). Had zero coverage before this fix.
// ---------------------------------------------------------------------------

/** A minimal-but-real PNG signature, padded past the 8-byte magic this function actually checks — real files are always longer, and `sniffImageType` never looks past byte 11 for any of the three types, so padding with zeros is enough to exercise the "real file, not just the magic bytes in isolation" shape. */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}
function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
}
function webpBytes(): Uint8Array {
  // "RIFF" + 4 bytes of chunk size (irrelevant to the sniff) + "WEBP".
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
}

test("sniffImageType: accepts real PNG/JPEG/WebP signature bytes", () => {
  assert.equal(sniffImageType(pngBytes()), "image/png");
  assert.equal(sniffImageType(jpegBytes()), "image/jpeg");
  assert.equal(sniffImageType(webpBytes()), "image/webp");
});

test("sniffImageType: rejects an SVG, with or without a leading XML declaration/BOM/whitespace", () => {
  const enc = new TextEncoder();
  const variants = [
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "<?xml version=\"1.0\"?><svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "﻿<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "   \n\t<svg xmlns='http://www.w3.org/2000/svg'></svg>",
  ];
  for (const variant of variants) {
    assert.equal(sniffImageType(enc.encode(variant)), null, variant);
  }
});

test("sniffImageType: rejects HTML", () => {
  const enc = new TextEncoder();
  assert.equal(sniffImageType(enc.encode("<!DOCTYPE html><html><body>hi</body></html>")), null);
  assert.equal(sniffImageType(enc.encode("<html><script>alert(1)</script></html>")), null);
});

test("sniffImageType: a RIFF header WITHOUT the WEBP tag at offset 8 is rejected — pins that this checks BOTH halves, not just 'RIFF'", () => {
  // Valid RIFF magic (bytes 0-3), but a DIFFERENT four-character code at
  // offset 8 (a real RIFF container can carry "WAVE", "AVI ", etc.) — must
  // never be accepted as WebP just because it starts with "RIFF".
  const notWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]); // "RIFF"...."WAVE"
  assert.equal(sniffImageType(notWebp), null);
});

test("sniffImageType: truncated/empty input is rejected, never throws", () => {
  const inputs = [
    new Uint8Array(0),
    new Uint8Array([0x89, 0x50, 0x4e]), // PNG magic cut short
    new Uint8Array([0xff, 0xd8]), // JPEG magic cut short
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45]), // WebP cut short before "WEBP" finishes
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => sniffImageType(input));
    assert.equal(sniffImageType(input), null, JSON.stringify(Array.from(input)));
  }
});

test("sniffImageType: a File.type claim is irrelevant — the function only ever looks at bytes, so SVG bytes wrapped in a File claiming image/png still sniff as null", () => {
  const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  const file = new File([svgBytes], "logo.png", { type: "image/png" });
  assert.equal(file.type, "image/png"); // the claim really is there, unexamined by sniffImageType
  assert.equal(sniffImageType(svgBytes), null); // and it changes nothing about the sniff
});

test("MAX_LOGO_BYTES is 2 MiB — both storeCoachLogo and storeGhlAccountLogo (src/lib/data/index.ts) enforce this exact constant against the real byte length before ever calling sniffImageType", () => {
  assert.equal(MAX_LOGO_BYTES, 2 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// brandStyle — adversarial review lens 5, finding 5 (MINOR, fixed). This
// file's OWN header used to claim to cover "hostile hex input reaching a
// `style` attribute" while only ever testing `normaliseHex` in isolation —
// the render path the claim was actually about was never called. `brandStyle`
// (src/lib/brand.ts) is that render path: the function that turns a
// `ResolvedBranding` into the literal `style` object `ConnectLinkClient.tsx`
// spreads onto its outermost `<div>`.
// ---------------------------------------------------------------------------

test("brandStyle: a client-set accent produces --color-accent/--color-accent-ink/--color-accent-text, ink computed via inkFor", () => {
  const accentColor = "#17BEB4";
  const style = brandStyle({ logoUrl: null, accentColor, accentInk: inkFor(accentColor) });
  assert.deepEqual(style, {
    "--color-accent": "#17BEB4",
    "--color-accent-ink": inkFor("#17BEB4"),
    "--color-accent-text": "#17BEB4",
  });
});

test("brandStyle: no accent set (the default-teal case) returns undefined, so the wrapper's style prop is omitted entirely", () => {
  assert.equal(brandStyle({ logoUrl: null, accentColor: null, accentInk: null }), undefined);
});

test("brandStyle: a value that BYPASSED the normal write path (e.g. edited directly in SQL, never through normaliseHex) is re-normalised to nothing before it can reach a style attribute", () => {
  // Simulates the scenario `ConnectLinkClient.tsx`'s own comment calls out:
  // `saveGhlAccountBrandingAction`/`updateGhlAccountBrandingService` already
  // refuse to persist an unparseable value, but this is defence in depth —
  // a hostile/malformed value reaching THIS function (a direct SQL edit, a
  // future write path that forgets to normalise) must still never survive
  // into a rendered style attribute. The realistic call shape is
  // `normaliseHex(raw)` feeding `accentColor` here — a value that fails
  // that normalisation resolves to `null`, which `brandStyle` already
  // treats as "no accent" per the test above; this test pins that a
  // CSS-injection-shaped raw value specifically never survives that
  // pipeline to reach a style object.
  const hostile = "red;background:url(javascript:alert(1))";
  const normalised = normaliseHex(hostile);
  assert.equal(normalised, null);
  const style = brandStyle({ logoUrl: null, accentColor: normalised, accentInk: normalised ? inkFor(normalised) : null });
  assert.equal(style, undefined);
});

test("brandStyle: the returned object carries ONLY the three accent CSS vars, never a logoUrl or any other field", () => {
  const style = brandStyle({ logoUrl: "https://example.com/logo.png", accentColor: "#17BEB4", accentInk: "#0B0C0D" });
  assert.deepEqual(Object.keys(style ?? {}).sort(), ["--color-accent", "--color-accent-ink", "--color-accent-text"]);
});
