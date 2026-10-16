/**
 * FitClosers Hub — the ONE shared phone normaliser (WhatsApp groundwork,
 * 29 Jul 2026). Every entry point that can ever learn a prospect's phone
 * number (the booking webhook, our own `/book/[slug]` pages, the Stripe
 * fill-in, PIM manual allocation via the owner/closer call drawer, CSV
 * import) goes through `normalisePhoneE164` below — no per-call-site regex
 * (hard rule 4). See supabase/migrations/0045_prospect_phone.sql for the
 * matching DB-level CHECK constraints (`calls_prospect_phone_e164`,
 * `unassigned_bookings_prospect_phone_e164`) that back this up even if some
 * future code path bypasses this helper entirely.
 *
 * THE SAFETY ARGUMENT (hard rule 1 — E.164 OR NOTHING): this data sends
 * WhatsApp messages to real people. A wrongly-normalised number messages A
 * DIFFERENT HUMAN BEING — a stranger receiving a fitness coach's sales
 * follow-up. That is materially worse than having no number at all. So this
 * module NEVER guesses: anything it cannot confidently read returns `null`,
 * never a partial/best-effort string. It also never throws — a malformed or
 * hostile input is just "not a phone number", not an exception to catch.
 *
 * Deliberately a standalone, I/O-free `src/lib` module with a narrow import
 * surface (no data-layer imports, nothing here even reads `process.env`) —
 * follows the `src/lib/call-metrics.ts` / `src/lib/currency.ts` precedent so
 * it's safely importable from webhook routes, server actions, and both data
 * backends without cycle risk.
 */

/**
 * Regions this module may use to interpret a BARE NATIONAL number (one with
 * no leading `+`/`00`). Extended deliberately — adding a region means adding
 * an explicit rule to the table in `normalisePhoneE164`, never inferring one
 * from context (hard rule 2's first half: never guess a country silently).
 */
export type PhoneRegion = "GB";

/**
 * THE platform default region (hard rule 2 — visible, documented, argued,
 * never an implicit hard-coded value buried in a helper):
 *
 * FitClosers is a UK agency; all 8 live coaches are UK businesses; the app
 * is GBP-native and Europe/London-native (`src/lib/booking.ts` hard-wires
 * London wall-clock for slot computation). Every call site that needs to
 * interpret a bare national number passes this constant EXPLICITLY as a
 * parameter — it is never read implicitly inside `normalisePhoneE164`.
 * Going multi-region = promote this to a per-coach setting; every call site
 * already takes region as a parameter, so that upgrade is plumbing, not a
 * rewrite of this module or its callers.
 */
export const DEFAULT_PHONE_REGION: PhoneRegion = "GB";

/** The same predicate the DB CHECK constraints encode (`^\+[1-9][0-9]{6,14}$`) — strict E.164, no separators, 7-15 digits after the `+`, no leading zero in the country code. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

/**
 * Per-region rule for turning a BARE NATIONAL number (cosmetic separators
 * already stripped) into E.164. Returns `null` for anything that doesn't
 * match that region's shape — never a guess.
 *
 * MOBILE ONLY (tightened 29 Jul, adversarial review Lens 1 finding 3): a bare
 * national number is accepted only against the UK mobile shape (`07` + 9
 * digits), not the wider "any 11-digit `0…`" shape a landline/non-geographic
 * rule would also match. Two reasons, both about NOT messaging a stranger:
 * (a) the sole consumer of this data is the future WhatsApp send step — a UK
 * landline has no WhatsApp account to reach, so accepting it captures a
 * number that can never be used; (b) the wider shape collides with foreign
 * 11-digit zero-leading national numbers written into a GB-defaulted field
 * (verified: a German landline "030 12345678" → "+443012345678", which is an
 * ALLOCATED UK 03xx non-geographic range — a real stranger receives that
 * message). Restricting to `07…` shrinks that collision surface from five
 * UK prefix ranges (01/02/03/08/09) down to one, and — being 07-specific —
 * NOT foreign-landline-shaped besides. It doesn't eliminate the residual
 * (some countries' mobile ranges also start `07`), so this is a mitigation,
 * not a fix for the inherent ambiguity of an explicit-region default; see
 * `DEFAULT_PHONE_REGION`'s JSDoc for why an explicit default is still correct
 * over silent guessing.
 */
const NATIONAL_RULES: Record<PhoneRegion, (digitsOnly: string) => string | null> = {
  GB: (digitsOnly) => (/^07\d{9}$/.test(digitsOnly) ? `+44${digitsOnly.slice(1)}` : null),
};

/**
 * True iff `digitsOnly` — a BARE NATIONAL candidate with its leading `0`
 * already restored (see the ambiguity check in `normalisePhoneE164`) — is
 * SHAPED like ANY GB number (mobile or landline: 11 digits, leading 0), not
 * just the mobile-only shape `NATIONAL_RULES.GB` actually captures.
 *
 * Deliberately WIDER than `NATIONAL_RULES.GB`: this function answers "could
 * a human have typo'd this as a UK number with a doubled leading zero",
 * which is a question about what a person plausibly meant, not about what
 * we're willing to store. A doubled-zero UK LANDLINE typo (e.g. "0020 7123
 * 4567") should still be treated as ambiguous-with-a-genuine-international-
 * number and refused (`null`) even though we'd also refuse to capture that
 * same landline via the ordinary bare-national path (mobile-only, above) —
 * the alternative is confidently mis-storing it as a foreign number (the
 * empirically-verified "+2071234567" / Egypt failure, Lens 1 finding 2),
 * which is strictly worse than a `null` we could at least hand-fix.
 */
function looksLikeGbNationalShape(digitsOnly: string): boolean {
  return /^0\d{10}$/.test(digitsOnly);
}

/**
 * THE shared normaliser (hard rule 4 — one normaliser, one place). Contract,
 * in order (see supabase/migrations/0045_prospect_phone.sql's header for the
 * DB-level backstop of the same contract):
 *
 * 1. Trim; drop the GB `"(0)"` infix (e.g. `+44 (0)7700 900123`); strip
 *    spaces, dots, hyphens, and parentheses. Empty after that -> `null`.
 * 2. A leading `00` (the international dialling prefix used in writing) ->
 *    rewritten to `+`, UNLESS that rewrite is ambiguous with a mistyped bare
 *    national number (step 2a) — never guess between the two, `null`.
 * 2a. AMBIGUITY GUARD (added 29 Jul, adversarial review Lens 1 finding 2):
 *    doubled leading zero — a typo for the trunk `0` — and the genuine `00`
 *    international-dialling prefix are indistinguishable by shape alone.
 *    Verified failure without this guard: "0 07700900123" (GB mobile with a
 *    stray extra 0) strips to "007700900123" -> naive `00`->`+` rewrite gives
 *    "+7700900123", a syntactically-valid but WRONG-COUNTRY (+7) number that
 *    passes E.164 shape and would be stored/sent. Guard: if re-adding a
 *    single leading `0` to the post-`00` digits would itself look like ANY
 *    GB-shaped number (`looksLikeGbNationalShape` — deliberately wider than
 *    the mobile-only capture rule in `NATIONAL_RULES`, see its JSDoc), the
 *    input is ambiguous between "genuine international, country code happens
 *    to make this shape" and "GB number with a doubled 0" — refuse to guess,
 *    return `null`, rather than silently picking the international reading.
 *    A true `0044…` GB number is unaffected: re-adding a `0` to
 *    "447700900123" gives 13 digits, not the 11-digit `0…` shape the guard
 *    checks for, so it's never flagged ambiguous.
 * 3. If it now starts with `+`: a GB TRUNK-ZERO REPAIR runs first (added
 *    29 Jul, Lens 1 finding 1) — `+440` followed by exactly 10 digits (e.g.
 *    "+44 07700 900123" -> "+4407700900123") is the unbracketed spelling of
 *    the exact same mistake the `"(0)"` strip above already fixes for the
 *    bracketed spelling; no real UK number has a 0 immediately after the
 *    country code, so dropping it is a confident repair, not a guess — the
 *    country code is already stated explicitly, only the redundant trunk
 *    digit is removed. Then it must match strict E.164
 *    (`/^\+[1-9]\d{6,14}$/`, ITU max 15 digits) to be accepted verbatim.
 *    International input is NEVER re-regionalised (hard rule 2's second
 *    half) — a `+34...` (Spanish) number stays exactly that even when
 *    `defaultRegion` is `"GB"`. Fails the regex -> `null`.
 * 4. Otherwise it's a BARE NATIONAL number: requires `defaultRegion` to be
 *    non-null (a caller with no region to offer — e.g. deliberately none —
 *    gets `null` for anything not already international) and the digits to
 *    match that region's rule in `NATIONAL_RULES` (GB: mobile shape only,
 *    see that table's JSDoc). No match -> `null`.
 * 5. Anything else unrecognisable -> `null`. This function never throws —
 *    including for non-string input (`typeof raw !== "string"` -> `null`),
 *    hardened 29 Jul per Lens 2 finding 2 so a caller that skips its own
 *    string check (e.g. a JSON payload field that arrived as a number)
 *    can't take this down; the JSDoc "never throws" claim used to only hold
 *    for string/null/undefined.
 *
 * @param raw The as-received phone string (may be `null`/`undefined`/empty/garbage).
 * @param defaultRegion The region to use ONLY for interpreting a bare national
 *   number — pass `DEFAULT_PHONE_REGION` explicitly at every call site (see
 *   this module's header), or `null` when the call site has no sensible
 *   region to offer (bare national input then always normalises to `null`).
 * @returns Strict E.164, or `null`. Never a half-normalised guess.
 */
export function normalisePhoneE164(raw: string | null | undefined, defaultRegion: PhoneRegion | null): string | null {
  if (!raw) return null;
  if (typeof raw !== "string") return null;

  const stripped = raw
    .trim()
    // Leading apostrophe = a spreadsheet's "treat this cell as text" marker
    // (Excel/Sheets/CSV exports write `'07700900123` so the leading 0 survives
    // — precisely the numbers we care about). Safe to drop unconditionally: an
    // apostrophe is never part of a phone number, and this only ever removes a
    // LEADING one, so it can't rescue otherwise-malformed input. Added 29 Jul
    // ahead of Charlie exporting ~449 historical contacts out of GoHighLevel
    // to backfill the imported calls, which is exactly where this shows up.
    .replace(/^'+/, "")
    .replace(/\(0\)/g, "")
    .replace(/[\s().-]/g, "");

  if (!stripped) return null;

  if (stripped.startsWith("00")) {
    const afterPrefix = stripped.slice(2);
    // Ambiguity guard (step 2a) — see the JSDoc above for the "0
    // 07700900123" -> "+7700900123" failure this closes.
    if (looksLikeGbNationalShape(`0${afterPrefix}`)) return null;
    return normaliseInternational(`+${afterPrefix}`);
  }

  if (stripped.startsWith("+")) {
    return normaliseInternational(stripped);
  }

  // Bare national number — only ever interpreted against an EXPLICIT region.
  if (!defaultRegion) return null;
  // Guard against letters/symbols slipping through (e.g. an extension like
  // "07700900123 x204" would have its space stripped above into
  // "07700900123x204" — the digits-only regex below correctly rejects it).
  if (!/^\d+$/.test(stripped)) return null;

  return NATIONAL_RULES[defaultRegion](stripped);
}

/**
 * Shared tail of the "already has a `+`" path (step 3), reached whether the
 * `+` was written directly or produced by the `00` rewrite. Applies the GB
 * trunk-zero repair, then the strict E.164 shape check. Never re-regionalises
 * non-GB numbers — the repair only fires for the exact `+440` + 10-digit
 * shape.
 */
function normaliseInternational(withPlus: string): string | null {
  const gbTrunkZero = /^\+440(\d{10})$/.exec(withPlus);
  const repaired = gbTrunkZero ? `+44${gbTrunkZero[1]}` : withPlus;
  return isE164(repaired) ? repaired : null;
}
