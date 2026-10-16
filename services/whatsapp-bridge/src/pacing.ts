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
 *     (`sentTodayCount() + queue.length`), not only counted at dispatch, so
 *     a burst of accepts arriving faster than the pacer can drain cannot
 *     overshoot the cap before any of them has actually dispatched.
 *
 * Pure in-memory arithmetic + an injected clock, so the unit tests
 * (test/pacing.test.ts) exercise real decisions without real waiting.
 */

export interface PacerConfig {
  minGapMs: number;
  jitterMs: number;
  dailyCap: number;
}

export class SessionPacer {
  private lastSendAtMs: number | null;
  private sentToday: number;
  private dayKey: string;

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

  /** True when this session has spent its daily budget — the send ROUTE checks this up front so the caller gets an immediate 429 instead of a message that sits queued until midnight. */
  atDailyCap(): boolean {
    this.rollDayIfNeeded();
    return this.sentToday >= this.config.dailyCap;
  }

  remainingToday(): number {
    this.rollDayIfNeeded();
    return Math.max(0, this.config.dailyCap - this.sentToday);
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
   */
  msUntilNextSendAllowed(): number {
    if (this.lastSendAtMs === null) return 0;
    const jitter = Math.floor(this.random() * (this.config.jitterMs + 1));
    const earliest = this.lastSendAtMs + this.config.minGapMs + jitter;
    return Math.max(0, earliest - this.now());
  }

  /** Record an actual (attempted) send — advances both the gap clock and the daily counter. Counted on ATTEMPT, not success: a failed attempt still hit WhatsApp's servers, which is what the cap protects. */
  recordSend(): void {
    this.rollDayIfNeeded();
    this.lastSendAtMs = this.now();
    this.sentToday += 1;
  }
}
