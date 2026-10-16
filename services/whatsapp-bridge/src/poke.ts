/**
 * PortalPoke — sends a CONTENTLESS "drain now" signal to the portal after an
 * inbound WhatsApp reply is durably written to Supabase (see
 * src/inbound.ts's file header, and the architecture plan's §1). This HTTP
 * call carries NO reply data whatsoever — the DB row is the transport,
 * already written by the time this fires — so it cannot forge, tamper with,
 * or duplicate a reply. The worst a spoofed/replayed poke can do is ask the
 * portal to re-run its own idempotent drain of rows that already exist,
 * which is a no-op. That is *why* this is a bearer-secret-authenticated
 * plain POST rather than something HMAC-signed: a signature protects a
 * payload, and there is no payload here to protect.
 *
 * BEST-EFFORT BY DESIGN, NEVER A DELIVERY GUARANTEE: the portal's own hourly
 * reminders cron runs the exact same drain unconditionally (a later batch),
 * so a poke that never lands merely costs latency (the reply surfaces on
 * the next cron pass instead of within seconds) — never correctness. This
 * module therefore gives up silently after `maxAttempts`, never retries
 * forever, never throws to its caller, and `schedule()` is fire-and-forget
 * (callers never await it).
 *
 * COALESCING: many inbound messages can land in the same instant (a burst
 * of replies across coaches, or Baileys delivering several queued messages
 * after one reconnect). At most one poke HTTP call is in flight per bridge
 * PROCESS at a time; anything that arrives mid-flight just sets a `dirty`
 * flag, which triggers exactly one more pass immediately after the current
 * one settles — never a queue of N pokes for N inbound messages.
 */
import type { Logger } from "pino";

export interface PortalPokeConfig {
  /** Already validated https-only + non-empty by config.ts. */
  url: string;
  secret: string;
  /** Per-attempt timeout (ms). Default 5s. */
  timeoutMs?: number;
  /** Total attempts before giving up silently. Default 3. */
  maxAttempts?: number;
  /** Fixed delay between attempts (ms). Default 30s. */
  backoffMs?: number;
}

export class PortalPoke {
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private inFlight = false;
  private dirty = false;

  constructor(config: PortalPokeConfig, private readonly log: Logger) {
    this.url = config.url;
    this.secret = config.secret;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.backoffMs = config.backoffMs ?? 30_000;
  }

  /**
   * Request a drain. Fire-and-forget: never throws, never returns a value a
   * caller could meaningfully await on — the caller's job (writing the
   * reply row) is already done by the time this is called; this is purely a
   * latency optimisation for the NEXT step (see file header).
   */
  schedule(): void {
    if (this.inFlight) {
      this.dirty = true; // something new arrived mid-flight — one more pass once this one settles.
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    this.dirty = false;
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const ok = await this.attempt();
        if (ok) return;
        if (attempt < this.maxAttempts) await sleep(this.backoffMs);
      }
      this.log.warn({ maxAttempts: this.maxAttempts }, "portal poke gave up after max attempts — hourly cron drain is the backstop");
    } finally {
      this.inFlight = false;
      if (this.dirty) void this.run();
    }
  }

  private async attempt(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
        // Deliberately empty — see file header. No reply data ever travels over this call.
        body: "{}",
        signal: controller.signal,
      });
      return res.ok;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "portal poke attempt failed (non-fatal — hourly cron drain is the backstop)");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
