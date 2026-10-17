/**
 * SMS fallback B — the fixed strings and the echo hash, in a leaf module (no
 * app imports) so `src/lib/ghl-provider.ts` and `src/lib/sms-fallback.ts`
 * can both use them without importing each other at load time.
 */
import { createHash } from "node:crypto";

/** GHL status reason for the original message when the SMS call succeeded. */
export const REASON_SENT_AS_SMS = "Not on WhatsApp — sent as SMS instead";

/** GHL status reason for our own fallback SMS handed back to PingWren. */
export const REASON_SMS_FALLBACK_LOOP = "This sub-account sends SMS through PingWren, so the SMS fallback can't be used — not sent";

/** How long a pending echo is valid, and the per-contact cooldown between fallback SMS. */
export const SMS_FALLBACK_ECHO_MS = 10 * 60 * 1000;

/** A claim younger than this belongs to a pass still sending; older, that pass died. */
export const SMS_FALLBACK_CLAIM_BUSY_MS = 2 * 60 * 1000;

/** CRLF to LF, every run of whitespace to one space, trimmed — so a provider's reflow still matches. */
export function normaliseSmsFallbackText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

/** The hash the echo table stores: sha256 hex of the normalised text. */
export function smsFallbackTextSha256(text: string): string {
  return createHash("sha256").update(normaliseSmsFallbackText(text), "utf8").digest("hex");
}
