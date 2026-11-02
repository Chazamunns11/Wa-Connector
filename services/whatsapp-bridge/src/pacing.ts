/**
 * Per-session send pacing (hard rule 4) — a SAFETY feature, not throughput
 * tuning. Unpaced bulk sending is the classic WhatsApp-ban trigger, and a
 * ban here lands on the CLIENT'S OWN BUSINESS NUMBER — their real line, the
 * one their existing customers message. So the pacer is deliberately
 * conservative and every limit is configuration (src/config.ts /
 * .env.example), not a constant buried in this file.
 *
 * Three mechanisms, all PER COACH SESSION (one coach machine-gunning must
 * never be smoothed out by another coach's idle session):
 *   - MIN GAP: at least WA_SEND_MIN_GAP_MS between two sends.
 *   - JITTER: plus uniform random 0..WA_SEND_JITTER_MS on top — evenly
 *     spaced 45.000s intervals are their own bot signature; jitter makes the
 *     cadence look like a human working through a list.
 *   - DAILY CAP: at most WA_DAILY_CAP sends per UTC day. Seeded from the
 *     whatsapp_messages ledger at session start (`store.getDailyActivity`),
 *     so a bridge restart cannot reset a coach's spent budget — and budget
 *     is additionally RESERVED at accept time in sessions.ts's `send()`
 *     (`sentTodayCount() + inFlight + queued units + units`), not only counted at
 *     dispatch, so a burst of accepts arriving faster than the pacer can
 *     drain cannot overshoot the cap before any of them has actually
 *     dispatched. Units, not sends: a group send costs 5 (src/groups.ts's
 *     `GROUP_SEND_CAP_UNITS`), both when reserved and when recorded.
 *
 * CONVERSATION REPLIES (src/sessions.ts `isConversationReply`): a 1:1 send
 * to a contact who messaged this number within WA_REPLY_WINDOW_HOURS is a
 * reply, not outreach. It costs 0 cap units (so it is never refused at the
 * cap, warm-up included) and only waits WA_REPLY_MIN_GAP_MS + 0..
 * WA_REPLY_JITTER_MS after the previous send of any kind. A cold send still
 * waits the full gap + jitter after the previous COLD send, and never less
 * than the reply gap after any send, so replies never shorten cold spacing.
 *
 * Pure in-memory arithmetic + an injected clock, so the unit tests
 * (test/pacing.test.ts) exercise real decisions without real waiting.
 */

/**
 * Warm-up schedule (WA_WARMUP_ENABLED). A freshly linked number sending its
 * full daily cap on day one is a classic ban pattern, so while warm-up is on
 * a number's cap ramps with its age since it was linked
 * (`whatsapp_sessions.phone_linked_at`). Ages are in days; the first row
 * whose `untilDays` the age is below wins. Past the last row the normal
 * WA_DAILY_CAP applies alone. The pacer always takes min(dailyCap, this).
 */
export const WARMUP_SCHEDULE: readonly { untilDays: number; cap: number }[] = [
  { untilDays: 3, cap: 20 },
  { untilDays: 7, cap: 50 },
  { untilDays: 14, cap: 100 },
];

/** The warm-up cap for a number this many days old, or `null` once it has graduated. A negative age (clock skew) counts as brand new. */
export function warmupCapForAgeDays(ageDays: number): number | null {
  const age = Math.max(0, ageDays);
  return WARMUP_SCHEDULE.find((step) => age < step.untilDays)?.cap ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PacerConfig {
  minGapMs: number;
  jitterMs: number;
  dailyCap: number;
  /** Gap and jitter for a conversation reply. Omitted -> a reply is paced like any other send. */
  replyMinGapMs?: number;
  replyJitterMs?: number;
}

export class SessionPacer {
  /** Last send of any kind — the reply gap counts from here. */
  private lastSendAtMs: number | null;
  /** Last non-reply send — the full cold gap counts from here. */
  private lastColdSendAtMs: number | null;
  private sentToday: number;
  private dayKey: string;
  /** When the current number was linked, if warm-up applies — see `setLinkedAt`. */
  private linkedAtMs: number | null = null;

  constructor(
    private readonly config: PacerConfig,
    alreadySentToday: number,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    /**
     * Seeds the min-gap clock from the ledger's last dispatch attempt today
     * (`store.getDailyActivity`), so a bridge restart landing between two
     * paced sends cannot produce a sub-gap pair — without this, a fresh
     * pacer always reports "no wait needed" for its first send regardless of
     * how recently the PREVIOUS instance actually sent one (fix for the
     * "min-gap does not survive a restart" review finding). Null when there
     * is no prior dispatch today.
     */
    seedLastSendAtMs: number | null = null
  ) {
    this.sentToday = alreadySentToday;
    this.dayKey = this.utcDayKey();
    this.lastSendAtMs = seedLastSendAtMs;
    // The ledger doesn't say which sends were replies; treating the last one as cold is the stricter choice.
    this.lastColdSendAtMs = seedLastSendAtMs;
  }

  private utcDayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Rolls the daily counter at UTC midnight — checked lazily on every decision, no timer needed. */
  private rollDayIfNeeded(): void {
    const key = this.utcDayKey();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.sentToday = 0;
    }
  }

  /**
   * Turns warm-up on for this session's number (`linkedAtMs` = when it was
   * linked) or off (`null`). sessions.ts calls this on every 'open' when
   * WA_WARMUP_ENABLED is set, and never otherwise, so with the flag off the
   * cap is exactly `dailyCap` as before.
   */
  setLinkedAt(linkedAtMs: number | null): void {
    this.linkedAtMs = linkedAtMs;
  }

  /** Today's cap: `dailyCap`, lowered by the warm-up schedule while the number is young. */
  effectiveDailyCap(): number {
    if (this.linkedAtMs === null) return this.config.dailyCap;
    const warm = warmupCapForAgeDays((this.now() - this.linkedAtMs) / DAY_MS);
    return warm === null ? this.config.dailyCap : Math.min(this.config.dailyCap, warm);
  }

  /**
   * True while this number is inside the warm-up window (first 14 days since
   * it was linked). Only ever true with WA_WARMUP_ENABLED, because
   * `setLinkedAt` is only called then. Group creation and direct adds are
   * refused while this holds (src/group-limits.ts's callers).
   */
  isInWarmup(): boolean {
    return this.linkedAtMs !== null && warmupCapForAgeDays((this.now() - this.linkedAtMs) / DAY_MS) !== null;
  }

  /** True when this session has spent its daily budget — the send ROUTE checks this up front so the caller gets an immediate 429 instead of a message that sits queued until midnight. */
  atDailyCap(): boolean {
    this.rollDayIfNeeded();
    return this.sentToday >= this.effectiveDailyCap();
  }

  remainingToday(): number {
    this.rollDayIfNeeded();
    return Math.max(0, this.effectiveDailyCap() - this.sentToday);
  }

  sentTodayCount(): number {
    this.rollDayIfNeeded();
    return this.sentToday;
  }

  /**
   * Milliseconds the queue worker must still wait before the next send is
   * allowed: 0 if the gap (with this send's jitter) has already elapsed.
   * Jitter is drawn per call — the worker computes the delay once, sleeps
   * it, then records the send.
   * @param reply a conversation reply (see file header): only the reply gap
   *   after the last send of any kind. A cold send waits the full gap +
   *   jitter after the last cold send, and at least the reply gap after any.
   */
  msUntilNextSendAllowed(reply = false): number {
    if (this.lastSendAtMs === null) return 0;
    const replyGapMs = this.config.replyMinGapMs ?? this.config.minGapMs;
    const jitter = (maxMs: number) => Math.floor(this.random() * (maxMs + 1));
    let earliest: number;
    if (reply) {
      earliest = this.lastSendAtMs + replyGapMs + jitter(this.config.replyJitterMs ?? this.config.jitterMs);
    } else {
      earliest = this.lastSendAtMs + replyGapMs;
      if (this.lastColdSendAtMs !== null) earliest = Math.max(earliest, this.lastColdSendAtMs + this.config.minGapMs + jitter(this.config.jitterMs));
    }
    return Math.max(0, earliest - this.now());
  }

  /**
   * Record an actual (attempted) send — advances both the gap clock and the daily counter. Counted on ATTEMPT, not success: a failed attempt still hit WhatsApp's servers, which is what the cap protects.
   * @param units daily-cap units this send costs: 1 for a 1:1 part, `GROUP_SEND_CAP_UNITS` (5, src/groups.ts) for a group send, which reaches every member at once, 0 for a conversation reply. The gap clock advances once either way.
   * @param reply a conversation reply — advances only the any-send clock, not the cold one.
   */
  recordSend(units = 1, reply = false): void {
    this.rollDayIfNeeded();
    this.lastSendAtMs = this.now();
    if (!reply) this.lastColdSendAtMs = this.lastSendAtMs;
    this.sentToday += units;
  }
}
