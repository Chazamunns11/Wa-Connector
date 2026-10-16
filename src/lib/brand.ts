/**
 * PARTIAL COPY (Task 3) of PortalHub `src/lib/brand.ts` — only `normaliseHex`,
 * which the repository layer (`data/supabase.ts`) imports. Task 4 extends this
 * file with the other exports the connect page / ConnectBrandHeader need.
 */

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
