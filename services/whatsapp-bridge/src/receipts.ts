/**
 * Delivery and read receipts for our own sent messages (migration 0010).
 * Watches Baileys' `messages.update` and records `delivered_at` / `read_at` on
 * the ledger row (whatsapp_messages), set once and never moved backwards. A
 * read implies delivered. Receipts are tracked for one-to-one messages only:
 * Baileys reports group receipts through `message-receipt.update`, not
 * `messages.update`, so group updates are ignored here.
 *
 * An ack can arrive before the ledger row has its wa_message_id (the send
 * resolves, then markMessageSent runs). Such an ack is kept in memory for 60
 * seconds and re-applied by `afterSent`.
 *
 * Logging: fixed strings and error names only. Never message ids or JIDs.
 */
import type { WAMessageUpdate } from "@whiskeysockets/baileys";
import type { Logger } from "pino";

export type ReceiptLevel = "delivered" | "read";
export type ReceiptResult = "applied" | "no_row";

const PENDING_TTL_MS = 60_000;
const MAX_PENDING = 1_000;

// proto.WebMessageInfo.Status, by value (ERROR 0, PENDING 1, SERVER_ACK 2, DELIVERY_ACK 3, READ 4, PLAYED 5).
const DELIVERY_ACK = 3;
const READ = 4;
const PLAYED = 5;

export function receiptFromUpdate(u: WAMessageUpdate): { waMessageId: string; level: ReceiptLevel } | null {
  if (u.key?.fromMe !== true) return null;
  if (u.key.remoteJid?.endsWith("@g.us")) return null;
  const waMessageId = u.key.id;
  if (!waMessageId) return null;
  const status = u.update?.status;
  if (typeof status !== "number") return null;
  let level: ReceiptLevel;
  if (status === DELIVERY_ACK) level = "delivered";
  else if (status === READ || status === PLAYED) level = "read";
  else return null;
  return { waMessageId, level };
}

export interface ReceiptStore {
  markMessageReceipt(coachId: string, waMessageId: string, level: ReceiptLevel, atIso: string): Promise<ReceiptResult>;
}

interface Pending {
  /** Each ack keeps the time it was first seen; later repeats never move it. */
  deliveredAt?: string;
  readAt?: string;
  /** First sighting: the 60s TTL runs from here and later acks do not refresh it. */
  firstSeenAt: number;
}

export class ReceiptApplier {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly store: ReceiptStore,
    private readonly now: () => number = Date.now,
    private readonly log: Pick<Logger, "error"> = { error: () => {} },
  ) {}

  async handle(coachId: string, updates: WAMessageUpdate[]): Promise<void> {
    for (const u of updates) {
      try {
        const r = receiptFromUpdate(u);
        if (!r) continue;
        const atIso = new Date(this.now()).toISOString();
        const result = await this.store.markMessageReceipt(coachId, r.waMessageId, r.level, atIso);
        if (result === "no_row") this.remember(`${coachId}:${r.waMessageId}`, r.level, atIso);
      } catch (err) {
        this.log.error({ err: (err as Error)?.name ?? "Error" }, "receipt handling failed");
      }
    }
  }

  /** Called right after markMessageSent succeeds: re-applies an ack that arrived first. */
  async afterSent(coachId: string, waMessageId: string): Promise<void> {
    try {
      this.sweep();
      const key = `${coachId}:${waMessageId}`;
      const entry = this.pending.get(key);
      if (!entry) return;
      this.pending.delete(key);
      // Delivered first with its own time, so a later read cannot overwrite it.
      if (entry.deliveredAt) await this.store.markMessageReceipt(coachId, waMessageId, "delivered", entry.deliveredAt);
      if (entry.readAt) await this.store.markMessageReceipt(coachId, waMessageId, "read", entry.readAt);
    } catch (err) {
      this.log.error({ err: (err as Error)?.name ?? "Error" }, "pending receipt apply failed");
    }
  }

  private remember(key: string, level: ReceiptLevel, atIso: string): void {
    this.sweep();
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { firstSeenAt: this.now() };
      this.pending.set(key, entry);
      while (this.pending.size > MAX_PENDING) {
        const oldest = this.pending.keys().next().value;
        if (oldest === undefined) break;
        this.pending.delete(oldest);
      }
    }
    if (level === "delivered") entry.deliveredAt ??= atIso;
    else entry.readAt ??= atIso;
  }

  private sweep(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [key, p] of this.pending) if (p.firstSeenAt < cutoff) this.pending.delete(key);
  }
}
