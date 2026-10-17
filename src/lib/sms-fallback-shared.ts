/**
 * SMS fallback B — the fixed strings and the echo hash, in a leaf module (no
 * app imports) so `src/lib/ghl-provider.ts` and `src/lib/sms-fallback.ts`
 * can both use them without importing each other at load time.
 */
import { createHash } from "node:crypto";
import type { SmsFallbackEcho } from "@/lib/types";

/** GHL status reason for the original message when the SMS call succeeded. */
export const REASON_SENT_AS_SMS = "Not on WhatsApp — sent as SMS instead";

/** GHL status reason for our own fallback SMS handed back to PingWren. */
export const REASON_SMS_FALLBACK_LOOP = "This sub-account sends SMS through PingWren, so the SMS fallback can't be used — not sent";

/** How long a pending echo is valid, and the per-contact cooldown between fallback SMS. */
export const SMS_FALLBACK_ECHO_MS = 10 * 60 * 1000;

/** A claim younger than this belongs to a pass still sending; older, that pass died. */
export const SMS_FALLBACK_CLAIM_BUSY_MS = 2 * 60 * 1000;

/** An echo whose POST has not succeeded is matched by its hash only this long (the POST may still be in flight). */
export const SMS_FALLBACK_UNSENT_ECHO_MATCH_MS = 30 * 1000;

/**
 * The loop guard's match. With GHL's message id known, only that id matches.
 * Without it, the text hash matches, but only once the POST succeeded
 * (`sentAt`) or while an unsent echo is younger than 30 seconds (its POST may
 * still be in flight; the echo was written `SMS_FALLBACK_ECHO_MS` before it
 * expires). An older unsent echo (a network error) never matches.
 */
export function smsFallbackEchoMatches(echo: SmsFallbackEcho, message: { ghlMessageId: string; text: string }, nowMs: number): boolean {
  if (echo.ghlMessageId) return message.ghlMessageId === echo.ghlMessageId;
  if (!echo.sentAt) {
    const createdMs = Date.parse(echo.expiresAt) - SMS_FALLBACK_ECHO_MS;
    if (!(nowMs - createdMs < SMS_FALLBACK_UNSENT_ECHO_MATCH_MS)) return false;
  }
  return smsFallbackTextSha256(message.text) === echo.textSha256;
}

/** CRLF to LF, every run of whitespace to one space, trimmed — so a provider's reflow still matches. */
export function normaliseSmsFallbackText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

/** The hash the echo table stores: sha256 hex of the normalised text. */
export function smsFallbackTextSha256(text: string): string {
  return createHash("sha256").update(normaliseSmsFallbackText(text), "utf8").digest("hex");
}
