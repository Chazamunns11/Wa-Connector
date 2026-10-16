/**
 * `frame-ancestors` allowlist validation for `GHL_EMBED_FRAME_ANCESTORS`
 * (adversarial review lens 4, finding 11 — MINOR: "config hygiene").
 *
 * DELIBERATELY ZERO IMPORTS. `next.config.ts` imports this module by
 * relative path to build the GHL Custom Page embed's `Content-Security-Policy`
 * header (see that file's own comment on the `/embed/crm` header block).
 * `next.config.ts` is loaded outside the app's normal TypeScript/webpack
 * pipeline, so it cannot be assumed to honor this project's `@/*` path-alias
 * mapping (tsconfig.json) the way application code can — keeping this file
 * import-free sidesteps that question entirely rather than betting on it.
 *
 * WHY THIS EXISTS AT ALL: `next.config.ts` used to interpolate the raw env
 * var directly into the CSP header string. CSP directives are
 * semicolon-separated, so an operator value containing a `;` could append
 * arbitrary directives onto the header (nothing here trusts an operator to
 * type a clean value under pressure at 11pm), and a bare `*` would silently
 * defeat the entire `frame-ancestors` allowlist that header exists to
 * enforce in the first place — see `src/lib/ghl-embed.ts`'s header for why
 * that allowlist matters (a WhatsApp QR is a device-link grant, and
 * clickjacking it is exactly what a restrictive `frame-ancestors` list is
 * for).
 */

/**
 * An `https://` origin, host-only — no port, no path, no query string, no
 * trailing slash — optionally prefixed with EXACTLY ONE leading `*.`
 * wildcard label. The wildcard exists for GHL's own whitelabel model: an
 * agency can serve their Custom Page iframe from a subdomain of a domain not
 * knowable ahead of time (e.g. `https://*.theiragencyname.com`).
 */
const FRAME_ANCESTOR_ORIGIN_PATTERN = /^https:\/\/(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * True iff `candidate` is safe to splice, verbatim, into a `frame-ancestors`
 * CSP directive. Rejects: anything containing `;` or whitespace (either
 * would let one "origin" carry a second CSP directive or a split-string
 * injection), a bare `*` (checked explicitly — the pattern below already
 * can't match it, since `*` alone never starts with `https://`, but an
 * explicit check makes the rejection read as deliberate policy, not an
 * accident of the regex), and anything that isn't a bare `https://` origin
 * with at most one leading `*.` wildcard label.
 */
export function isValidGhlEmbedFrameAncestor(candidate: string): boolean {
  if (candidate === "*") return false;
  if (/[;\s]/.test(candidate)) return false;
  return FRAME_ANCESTOR_ORIGIN_PATTERN.test(candidate);
}

/**
 * Parses the raw, operator-supplied `GHL_EMBED_FRAME_ANCESTORS` env var
 * (a space-separated list, per its own documentation in `.env.example` and
 * `next.config.ts`) into the list of entries that pass
 * `isValidGhlEmbedFrameAncestor`, silently DROPPING anything that doesn't —
 * never throws, and one malformed entry never takes down the whole
 * deployment's CSP header (or, worse, the whole allowlist, if the malformed
 * entry were a bare `*`). `undefined`/empty input returns `[]`, same as the
 * env var being unset today.
 */
export function parseGhlEmbedFrameAncestors(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter(isValidGhlEmbedFrameAncestor);
}
