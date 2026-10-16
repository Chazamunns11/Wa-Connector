/*
 * COPIED from PortalHub `src/lib/brand.ts` (Task 4) — only what
 * `ConnectBrandHeader.tsx`, the connect page and `ghl-branding.test.ts` import.
 * NOT copied: `resolveBranding`, `UNBRANDED`, `isNearlyInvisibleOn` (Hub
 * booking-page / email branding; nothing here imports them). Bodies verbatim.
 */
import type { CSSProperties } from "react";
import type { LogoBackdrop } from "@/lib/types";

/**
 * W20 — PER-CLIENT BRANDING: the single place that decides what colour and
 * what logo a given public page or email shows.
 *
 * Charlie, 1 Aug 2026: "for each client they need to be able to upload their
 * own logo ... so we can keep it on the booking form and calendar link. The
 * form needs to be same colour etc as the logo."
 *
 * This module is deliberately PURE — no `next/*`, no data layer, no
 * `server-only`. It is imported by server components (the booking pages), by
 * client components (the uploader's live preview) and by the plain-HTML email
 * builder, and all three MUST agree on the answer. Anything that needed a
 * server import would force a second implementation somewhere, which is
 * exactly how a "why is the email a different colour to the page" bug starts.
 *
 * ===================== THE CONTRAST PROBLEM (AND A LIVE BUG THIS FIXES) =====================
 * Branding before W20 set ONE variable:
 *
 *     // src/app/book/branding.tsx, before this change
 *     return accentColor ? { "--color-accent": accentColor } : undefined;
 *
 * but the buttons on those pages are `bg-accent text-accent-ink`
 * (src/app/book/[slug]/BookingForm.tsx:238, reschedule/RescheduleForm.tsx:109),
 * and `--color-accent-ink` stayed at its global value of brand Ink #0B0C0D.
 * That pairing is only legible because the DEFAULT accent is a light teal. A
 * coach who picks a dark brand colour — navy, maroon, black, all extremely
 * common in fitness branding — gets near-black text on a near-black button:
 * an invisible "Book this slot" control on the one page whose entire job is
 * getting that click.
 *
 * It has not bitten yet purely by luck: only one page has an override set
 * live (12x-coaching, `#38bdf8`, a light sky blue where Ink happens to be
 * right). Letting clients pick their own colour — the whole point of this
 * feature — turns that latent bug into a likely one, so the ink is now
 * COMPUTED (`inkFor`) and always shipped alongside the accent, never assumed.
 *
 * The ink is deliberately NOT a stored column. A stored value can go stale
 * against its accent (someone edits the colour in SQL, or an older client
 * writes only one of the pair) and then it is silently wrong forever. Derived
 * per render, it cannot disagree with the colour it sits on.
 */

/** Brand Ink — fitclosers-brand-pack/README.txt. The dark half of the ink pair. */
export const BRAND_INK = "#0B0C0D";
/** The light half of the ink pair. */
export const BRAND_WHITE = "#FFFFFF";
/** Brand Teal — the default accent when a client has set no colour of their own. */
export const BRAND_TEAL = "#17BEB4";

/**
 * Upload limits, shared by the server action's own checks and the bucket
 * definition in supabase/migrations/0066_client_branding.sql. 2 MiB is far
 * above any sane logo and far below anything that would strain a serverless
 * request body.
 */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** The public Supabase Storage bucket created by supabase/migrations/0066_client_branding.sql. */
export const LOGO_BUCKET = "client-logos";

/**
 * Accepted image types. SVG is EXCLUDED deliberately — see the storage-bucket
 * note in supabase/migrations/0066_client_branding.sql: an SVG can carry
 * <script>, and the bucket is public, so a coach-uploaded SVG opened directly
 * would execute on the storage origin. Rendering through <img> would be safe;
 * direct navigation would not, and raster logos cover the real need.
 */
export const SAFE_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type SafeLogoType = (typeof SAFE_LOGO_TYPES)[number];

/** File extension to store each accepted type under, so the public URL ends in something sensible. */
export const LOGO_EXTENSION: Record<SafeLogoType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Normalise anything a human might type or paste into a canonical `#RRGGBB`,
 * or `null` if it is not a colour we can reason about.
 *
 * Accepts `#abc`, `abc`, `#AABBCC`, `aabbcc`, with surrounding whitespace.
 * REJECTS `rgb(...)`, `hsl(...)` and CSS colour names on purpose: every
 * consumer here needs to do arithmetic on the channels (`inkFor` cannot pick
 * a legible text colour for a value it cannot decompose), and silently
 * storing a value we can't measure would defeat the contrast guarantee. The
 * UI only ever offers a colour picker and a hex field, so this is the full
 * set of shapes a client can actually produce.
 *
 * Note this is stricter than the pre-W20 `accent_color`, which accepted any
 * string at all. That is intentional and safe: the one live value
 * (`#38bdf8`) normalises cleanly, and an unparseable legacy value degrades to
 * "no override" — the default teal — rather than to an unreadable button.
 */
export function normaliseHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{3}$/.test(raw) && !/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  const full = raw.length === 3 ? raw.split("").map((ch) => ch + ch).join("") : raw;
  return `#${full.toUpperCase()}`;
}

/** The three 0-255 channels of a normalised hex. Assumes `normaliseHex` has already run. */
function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * WCAG 2.1 relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
 * The 0.03928 / 12.92 / 2.4 constants are the spec's, not tuned values — do
 * not "simplify" them to a plain average, which would mis-rank colours that
 * differ mostly in green.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two normalised hexes: 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The legible text colour to sit ON a given accent: brand Ink or white,
 * whichever has the higher contrast ratio against it.
 *
 * Two colours rather than a computed shade because these are the brand's own
 * pair and both are known-good on their respective grounds; picking between
 * two right answers is more robust than generating a third. The default teal
 * resolves to Ink at 8.45:1, i.e. this preserves today's look exactly.
 *
 * The worst case was measured, not assumed: sweeping all 16.7M RGB values
 * (1 Aug 2026) the floor is 4.42:1 — i.e. for EVERY colour a client can
 * possibly choose, the better of Ink/white clears 4.42 against it. A whole
 * band of mid-tones sits within a rounding error of that floor (the single
 * lowest is #CC36B3 at 4.425), so the number is the useful fact here, not
 * any one colour.
 *
 * 4.42 is just under AA's 4.5:1 for NORMAL text but well past the 3:1 AA
 * threshold for large/bold text, which is what every consumer of this pair
 * actually is — button labels at `text-sm font-medium` and above. So there
 * is no accent for which both options are illegible.
 */
export function inkFor(accentHex: string): string {
  return contrastRatio(accentHex, BRAND_INK) >= contrastRatio(accentHex, BRAND_WHITE)
    ? BRAND_INK
    : BRAND_WHITE;
}

/**
 * Is this colour so close to the page background that a button filled with it
 * would visually disappear? Used ONLY to warn in the editor — never to block
 * a save. A client's brand colour is theirs; the job here is to tell them
 * before their prospects see it, not to overrule them.
 *
 * `#0B0C0D` ink-on-ink is the motivating case: contrast 1.0 against the dark
 * portal ground. Below 1.5 the fill is essentially invisible as a shape.
 */
export function isNearlyInvisibleOn(accentHex: string, backgroundHex: string): boolean {
  return contrastRatio(accentHex, backgroundHex) < 1.5;
}

/** The branding actually in force for one page/email, after coach → page resolution. */
export interface ResolvedBranding {
  /** The logo to show, or `null` when this client has no logo uploaded. */
  logoUrl: string | null;
  /** Normalised accent hex, or `null` when this client has set none (default teal applies). */
  accentColor: string | null;
  /** Legible text colour for content sitting on `accentColor`. `null` exactly when `accentColor` is. */
  accentInk: string | null;
  /**
   * DE-WHITE-LABEL FIX (Charlie, 5 Aug 2026): "I think we need to get rid of
   * the FitClosers watermark, please... I would like it just to be backed in
   * with branding, so we have, like, Josh Bridgeman Coaching, for example."
   * The reason it matters: a prospect booking with 12X Coaching must believe
   * they're dealing with 12X, not FitClosers.
   *
   * This is the text `BrandHeader` (src/app/book/branding.tsx) shows in place
   * of a logo when this client hasn't uploaded one — 8 of the 9 coaches live
   * today. `null` ONLY when there is no coach to name at all (an unresolvable
   * token, a deleted coach a stale funnel link still points at) — see
   * `resolveBranding`'s own JSDoc below for exactly when that happens. It is
   * NEVER `null` for a real, resolved coach: `Coach.businessName` is a
   * required `string` (src/lib/types.ts), so this field is required on the
   * `coach` parameter below for the same reason — there is no legitimate
   * "coach with no name" state to model.
   */
  businessName: string | null;
  /**
   * W32 — how `logoUrl` is seated on the page. Resolved from the COACH only
   * (there is deliberately no per-page override — see
   * supabase/migrations/0082_logo_backdrop.sql), and meaningless when
   * `logoUrl` is null, where it is simply ignored by `BrandHeader`.
   */
  logoBackdrop: LogoBackdrop;
}

/**
 * The `style` prop for a page's OUTERMOST wrapper — scoping the accent to
 * this page only, exactly as the pre-W20 `accentStyleFor` did, but now
 * shipping the INK ALONGSIDE IT so `text-accent-ink` can never be left
 * pointing at the global near-black on a dark client colour (see this file's
 * header for the bug).
 *
 * `--color-accent-text` is set too: that token exists for accent-coloured
 * TEXT on the page ground rather than on the accent fill (globals.css:54),
 * and leaving it at the global teal while everything else turned, say, purple
 * would look like a rendering fault. It takes the accent directly — these
 * public pages are dark-ground, where the same reasoning as globals.css's
 * dark mode applies.
 *
 * Returns `undefined` when the client has no colour set, so the wrapper's
 * `style` prop is simply omitted and the page keeps its default look.
 */
export function brandStyle(branding: ResolvedBranding): CSSProperties | undefined {
  if (!branding.accentColor || !branding.accentInk) return undefined;
  return {
    "--color-accent": branding.accentColor,
    "--color-accent-ink": branding.accentInk,
    "--color-accent-text": branding.accentColor,
  } as CSSProperties;
}

/**
 * W-CONNECT-BRAND (per-client branding on the GHL `/connect/[token]` page,
 * migration 0076) — the monogram fallback shown when a client has no logo
 * uploaded yet.
 *
 * Charlie goes live on names and accent colours immediately and adds real
 * logos as he collects them from each of the 11-15 GHL clients, with no
 * redeploy in between — so "no logo" can never mean "generic grey box": it
 * falls back to the first LETTER of the client's own label, sat on their own
 * accent colour with `inkFor`-computed contrast (see `ConnectBrandHeader.tsx`,
 * src/components/whatsapp/, for where this actually renders).
 *
 * UNICODE-AWARE, `\p{L}` (any Unicode letter), not `[A-Za-z]` — a client
 * labelled "Ünique Fitness" should read "Ü", not silently skip it as if it
 * were punctuation. Deliberately SKIPS PAST non-letters to find the first
 * real one — "123 Gym" reads "G", not "1" (a location's own GHL-supplied
 * label is not guaranteed to start with a letter, and a digit or emoji
 * monogram reads as broken, not stylised). A label with no letter at all
 * (empty string, pure digits/punctuation/emoji) falls back to "?" rather than
 * throwing or rendering an empty badge — every render site needs SOMETHING
 * inside that circle.
 */
export function monogramFor(label: string): string {
  const match = label.match(/\p{L}/u);
  return match ? match[0].toUpperCase() : "?";
}

/**
 * W-CONNECT-BRAND — turn `ghl_accounts.brand_logo_path` (migration 0076) into
 * something an `<img src>` can actually load.
 *
 * THAT COLUMN STORES A PATH, NOT A URL (see 0076's own header for why) — a
 * bare object path within the shared `client-logos` bucket
 * (`"ghl/<locationId>/<uuid>.png"`), so this resolves it into the bucket's
 * public URL using the SAME `{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}`
 * shape `supabase-js`'s own `getPublicUrl` produces server-side
 * (`uploadGhlAccountLogoService`, src/lib/data/supabase.ts). Reproduced here
 * as plain string concatenation, deliberately NOT by importing the Supabase
 * client, because this module stays supabase-client-free and next-free on
 * purpose (this file's own header) — no network round trip and no client
 * instantiation are needed to build a public URL whose shape is already
 * known.
 *
 * ALSO PASSES THROUGH AN ALREADY-RESOLVED URL UNCHANGED (`data:...`,
 * `http(s)://...`, or `blob:...`) — THREE shapes that are never a bucket
 * path:
 *   - `data:` — demo mode's shape. Demo has no real bucket to put bytes in
 *     (mirrors `storeCoachLogo`'s identical demo branch,
 *     src/lib/data/index.ts), so it stores a self-contained data URL
 *     directly in the same column.
 *   - `http(s)://` — an already-fully-resolved URL, accepted so callers can
 *     pass this function's OWN output back through it idempotently.
 *   - `blob:` — a LOCAL, NOT-YET-SAVED preview. The owner panel's branding
 *     editor (`GhlAccountsPanel.tsx`) calls `URL.createObjectURL` on a
 *     freshly-picked file so Charlie sees it before the upload round trip
 *     completes, same convention as `BrandingCard`'s own `previewUrl`
 *     (src/components/branding/BrandingCard.tsx) — that value is never a
 *     bucket path and must render exactly as given.
 * This function is the one place all four shapes (path, data, http(s), blob)
 * have to be told apart, so every caller (the live connect page, the owner
 * panel's live preview) can just call it and get something renderable either
 * way.
 *
 * `NEXT_PUBLIC_SUPABASE_URL` unset with a genuine bucket path stored is not a
 * reachable state in normal operation (that combination means no Supabase
 * project at all), but resolves to `null` rather than throwing — a stray
 * value degrades to "no logo" (monogram fallback) rather than crashing a
 * public page's render.
 */
export function resolveLogoPath(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("data:") || path.startsWith("http://") || path.startsWith("https://") || path.startsWith("blob:")) {
    return path;
  }
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;
}

/**
 * Magic-byte sniff for the three accepted types, returning the type actually
 * present in the bytes or `null`.
 *
 * The browser-supplied `File.type` is attacker-controlled — it is just a
 * string on a multipart part — so it is never trusted on its own. The bucket
 * enforces `allowed_mime_types` against that same claimed value, which means
 * WITHOUT this check a file could claim `image/png`, satisfy the bucket, and
 * land in a public bucket as whatever it really is. Sniffing the leading
 * bytes is what makes the claim true.
 */
export function sniffImageType(bytes: Uint8Array): SafeLogoType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
