/**
 * E.164 gate for the send path (hard rule 3) — the SAME contract as the
 * portal's src/lib/phone.ts and the DB CHECK constraints (0045, 0046), NOT a
 * re-implementation of normalisation.
 *
 * DELIBERATE DESIGN: the bridge REFUSES, it never REPAIRS. All normalisation
 * (trunk-zero repair, `00` rewrites, bare-national interpretation) happens
 * exactly once, in the portal's `normalisePhoneE164` at capture time — by the
 * time a number reaches this service it is either already strict E.164 (it
 * came out of calls.prospect_phone, which is CHECK-constrained to this exact
 * regex) or it is a bug upstream, and the correct response to a bug upstream
 * is a 422, not a second, looser normaliser that might guess differently and
 * message a stranger. Keeping only the accept/reject predicate here means the
 * two codebases cannot drift into disagreeing about what a valid number IS —
 * and test/phone-contract.test.ts literally reads src/lib/phone.ts from the
 * repo and asserts the regex source below appears in it verbatim, so a change
 * to either side fails this package's tests until both move together.
 */

/**
 * Strict E.164 — byte-for-byte the predicate in src/lib/phone.ts's `isE164`
 * and the `^\+[1-9][0-9]{6,14}$` CHECK constraints on calls.prospect_phone
 * (0045) and whatsapp_messages.to_phone (0046).
 */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}
