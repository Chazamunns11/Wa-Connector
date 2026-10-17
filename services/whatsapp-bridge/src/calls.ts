/**
 * Missed WhatsApp calls (migration 0010). OBSERVE ONLY: this module never
 * answers, rejects or otherwise acts on a call. It watches Baileys' `call`
 * events and, when a call ends (`timeout` / `reject` / `terminate`) without an
 * `accept` from any device, records one inbound row (event_kind
 * 'missed_call') that the app later posts to GoHighLevel.
 *
 * The caller (from / callerPn) and the voice/video type are taken from the
 * `offer` and saved, never from the terminal event: a reject made on the
 * coach's own phone can carry our own JID in `from`.
 *
 * Rules: group calls and calls from our own number are ignored; the caller is
 * resolved exactly like a message sender (PN, or a LID that lidMapping
 * resolves) and unresolvable callers are dropped; at most one row per
 * (number, caller) per 10 minutes.
 *
 * Logging: fixed strings and error names only. Never phones, JIDs or call ids.
 */
import type { WACallEvent } from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import { pnJidToE164, resolveSenderE164, type RecordInboundInput } from "./inbound.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const MAX_TRACKED_CALLS = 5_000;
const TERMINAL = new Set<WACallEvent["status"]>(["timeout", "reject", "terminate"]);

export interface MissedCallDeps {
  resolvePnForLid(lidJid: string): Promise<string | null>;
  hasRecentMissedCall(coachId: string, phoneE164: string, sinceIso: string): Promise<boolean>;
  recordInboundMessage(input: RecordInboundInput & { eventKind: "missed_call" }): Promise<{ fresh: boolean }>;
  schedulePoke(): void;
  ownPhone(coachId: string): string | null;
  log: Pick<Logger, "warn" | "error">;
}

/** The caller as the `offer` described it. Later events can name a different `from` (see `handleOne`). */
interface Caller {
  from: string;
  callerPn?: string;
  isVideo: boolean;
}

interface CallState {
  offer: boolean;
  /** Saved at `offer`; the terminal event's own fields are never used for the row. */
  caller: Caller | null;
  accepted: boolean;
  /** True once a terminal status has been handled; kept (until swept) so a late duplicate terminal event cannot re-record or flag an answered call as missed. */
  settled: boolean;
  touchedAt: number;
}

export class MissedCallTracker {
  private readonly calls = new Map<string, CallState>();

  constructor(
    private readonly deps: MissedCallDeps,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(coachId: string, events: WACallEvent[]): Promise<void> {
    for (const call of events) {
      try {
        await this.handleOne(coachId, call);
      } catch (err) {
        this.deps.log.error({ err: (err as Error)?.name ?? "Error" }, "missed-call handling failed");
      }
    }
  }

  private sweep(): void {
    const cutoff = this.now() - TEN_MINUTES_MS;
    for (const [key, state] of this.calls) if (state.touchedAt < cutoff) this.calls.delete(key);
  }

  private async handleOne(coachId: string, call: WACallEvent): Promise<void> {
    this.sweep();
    if (call.isGroup || call.groupJid) return;

    // Only offer / accept / terminal statuses matter; ringing, transport etc. never create state.
    if (call.status !== "offer" && call.status !== "accept" && !TERMINAL.has(call.status)) return;

    const key = `${coachId}:${call.id}`;
    let state = this.calls.get(key);
    if (!state) {
      state = { offer: false, caller: null, accepted: false, settled: false, touchedAt: this.now() };
      this.calls.set(key, state);
      // Hard cap: Map iterates in insertion order, so the first key is the oldest.
      while (this.calls.size > MAX_TRACKED_CALLS) {
        const oldest = this.calls.keys().next().value;
        if (oldest === undefined) break;
        this.calls.delete(oldest);
      }
    }
    state.touchedAt = this.now();
    if (state.settled) return;

    if (call.status === "offer") {
      state.offer = true;
      state.caller = { from: call.from, callerPn: call.callerPn, isVideo: call.isVideo === true };
      return;
    }
    if (call.status === "accept") {
      state.accepted = true;
      return;
    }

    state.settled = true;
    // Missed only if we saw the ring ourselves: after a restart (or a swept
    // entry) a terminal event alone proves nothing, so fail safe.
    if (state.accepted || !state.offer || !state.caller) return;

    // The caller and call type come from the offer. A reject made on the
    // coach's own phone can carry OUR JID in `from`, so the terminal event's
    // own fields would name the wrong person (or ourselves).
    const caller = state.caller;
    const phone = await this.resolveCaller(caller);
    if (!phone) return;
    if (phone === this.deps.ownPhone(coachId)) return;

    const receivedAt = call.date.toISOString();
    const since = new Date(call.date.getTime() - TEN_MINUTES_MS).toISOString();
    if (await this.deps.hasRecentMissedCall(coachId, phone, since)) return;

    const { fresh } = await this.deps.recordInboundMessage({
      coachId,
      fromPhone: phone,
      waMessageId: `call:${call.id}`,
      body: null,
      messageType: caller.isVideo ? "missedVideoCall" : "missedVoiceCall",
      receivedAt,
      groupJid: null,
      senderName: null,
      eventKind: "missed_call",
    });
    if (fresh) this.deps.schedulePoke();
  }

  private async resolveCaller(caller: Caller): Promise<string | null> {
    const res = resolveSenderE164(caller.from, caller.callerPn);
    if (res.kind === "resolved") return res.phone;
    if (res.kind !== "unresolved_lid") return null;
    const pnJid = await this.deps.resolvePnForLid(caller.from);
    return pnJid ? pnJidToE164(pnJid) : null;
  }
}
