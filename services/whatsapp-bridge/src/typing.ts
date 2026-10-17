/**
 * Typing simulation — a ban-risk measure alongside the pacer (src/pacing.ts).
 *
 * A linked device that sends text with no "typing…" presence first is a bot
 * signature: a person on the WhatsApp app always shows as composing before
 * their message lands. So before each outbound TEXT part the queue worker
 * shows "typing…" in the recipient's chat for a length-scaled, jittered
 * moment, then sends. Attachments skip it (a person attaching a file shows
 * no composing state for it).
 *
 * Best effort by design: a presence update failing must never fail or delay
 * the message itself beyond the typing window, so every error is swallowed
 * here. Presence carries no message content.
 *
 * Pure arithmetic + an injected sleep/RNG, so test/typing.test.ts exercises
 * real decisions with no real waiting and no live socket.
 */

export interface TypingConfig {
  /** WA_TYPING_INDICATOR_ENABLED — off means send immediately, as before. */
  enabled: boolean;
  /** WA_TYPING_MAX_MS — upper bound on one typing window (ms). */
  maxMs: number;
}

/** Floor of every typing window: even "ok" takes a person a moment. */
export const TYPING_MIN_MS = 1_000;
/** Per-character cost — roughly a quick thumb-typist, deliberately brisk so a long message never stalls the queue. */
export const TYPING_MS_PER_CHAR = 30;
/** ± spread applied to the scaled duration, so two equal-length messages never type for an identical time. */
export const TYPING_JITTER_FRACTION = 0.2;

/**
 * How long to show "typing…" before a text of this length, in ms. Clamped to
 * [TYPING_MIN_MS, config.maxMs]. Returns 0 when disabled, or when maxMs is 0.
 */
export function typingDurationMs(text: string, config: TypingConfig, random: () => number = Math.random): number {
  if (!config.enabled || config.maxMs <= 0) return 0;
  const base = TYPING_MIN_MS + text.length * TYPING_MS_PER_CHAR;
  const spread = 1 + (random() * 2 - 1) * TYPING_JITTER_FRACTION;
  const scaled = Math.round(base * spread);
  return Math.min(config.maxMs, Math.max(Math.min(TYPING_MIN_MS, config.maxMs), scaled));
}

/** The one socket method this needs — kept narrow so tests can fake it without a Baileys socket. */
export interface PresenceSocket {
  sendPresenceUpdate(type: "composing" | "paused", toJid?: string): Promise<void>;
}

/**
 * Shows "typing…" in `jid`'s chat for `durationMs`, then clears it. Never
 * throws: a failed presence update is logged by the caller's `onError` and
 * the wait still happens (a skipped wait would make the send look MORE
 * bot-like, not less). A zero duration does nothing at all.
 */
export async function simulateTyping(
  sock: PresenceSocket,
  jid: string,
  durationMs: number,
  sleep: (ms: number) => Promise<void>,
  onError: (err: Error) => void = () => {}
): Promise<void> {
  if (durationMs <= 0) return;
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (err) {
    onError(err as Error);
  }
  await sleep(durationMs);
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch (err) {
    onError(err as Error);
  }
}
