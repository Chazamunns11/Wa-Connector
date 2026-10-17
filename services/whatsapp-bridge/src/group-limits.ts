/**
 * Per-number daily limits on group management (WA_GROUP_CREATE_DAILY,
 * WA_GROUP_ADD_DAILY). Mass group creation and mass direct adds are classic
 * WhatsApp ban triggers, and the ban lands on the client's own business
 * number, so both are capped per UTC day, like the send pacer (src/pacing.ts).
 *
 * - Seeded lazily from `whatsapp_group_actions` (store.countGroupActionsToday)
 *   on first use and again after a UTC day roll, so a restart cannot reset a
 *   spent budget.
 * - The action row is written BEFORE the reservation is granted: an attempt
 *   counts even if Baileys then fails (same "count the attempt" rule as the
 *   pacer's `recordSend`).
 * - Fails closed: a failed seed or write returns `unavailable`, never a grant.
 *   After a failed write the cached counts are dropped, so the next call
 *   reseeds from the table (the write may or may not have landed).
 * - Calls for one tenant run one at a time, so concurrent requests cannot
 *   both pass the check and overshoot.
 *
 * Logs nothing; callers own logging (tenant ids and error names only).
 */
import { GROUP_ACTION_MAX_COUNT, type BridgeStore } from "./store.js";

interface DayCounts {
  dayKey: string;
  creates: number;
  adds: number;
}

export type GroupLimitsStore = Pick<BridgeStore, "countGroupActionsToday" | "recordGroupAction">;

export class GroupActionLimits {
  private readonly counts = new Map<string, DayCounts>();
  /** Per-tenant tail of the call chain — serialises reserves for one tenant. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: GroupLimitsStore,
    private readonly limits: { createDaily: number; addDaily: number },
    private readonly now: () => number = Date.now
  ) {}

  /** Reserves one group create for today. `limit` once WA_GROUP_CREATE_DAILY creates have been attempted. */
  reserveCreate(tenantId: string): Promise<"ok" | "limit" | "unavailable"> {
    return this.serialise(tenantId, async () => {
      const counts = await this.seeded(tenantId);
      if (!counts) return "unavailable";
      if (counts.creates >= this.limits.createDaily) return "limit";
      try {
        await this.store.recordGroupAction(tenantId, "create", 1, null);
      } catch {
        this.counts.delete(tenantId);
        return "unavailable";
      }
      counts.creates += 1;
      return "ok";
    });
  }

  /**
   * Reserves up to `wanted` direct adds to `groupJid` for today. Grants what
   * is left of WA_GROUP_ADD_DAILY (at most 50 per call, the largest count one
   * action row may hold); `granted: 0` writes nothing. The caller sends the
   * rest an invite link.
   */
  reserveAdds(tenantId: string, wanted: number, groupJid: string): Promise<{ granted: number } | { unavailable: true }> {
    return this.serialise(tenantId, async () => {
      const counts = await this.seeded(tenantId);
      if (!counts) return { unavailable: true as const };
      const left = Math.max(0, this.limits.addDaily - counts.adds);
      const granted = Math.max(0, Math.min(Math.floor(wanted), left, GROUP_ACTION_MAX_COUNT));
      if (granted === 0) return { granted: 0 };
      try {
        await this.store.recordGroupAction(tenantId, "add", granted, groupJid);
      } catch {
        this.counts.delete(tenantId);
        return { unavailable: true as const };
      }
      counts.adds += granted;
      return { granted };
    });
  }

  private utcDayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Today's counts for this tenant, seeding from the store if missing or from an earlier day. Null if the seed failed. */
  private async seeded(tenantId: string): Promise<DayCounts | null> {
    const dayKey = this.utcDayKey();
    const cached = this.counts.get(tenantId);
    if (cached && cached.dayKey === dayKey) return cached;
    this.counts.delete(tenantId);
    try {
      const { creates, adds } = await this.store.countGroupActionsToday(tenantId);
      const fresh: DayCounts = { dayKey, creates, adds };
      this.counts.set(tenantId, fresh);
      return fresh;
    } catch {
      return null;
    }
  }

  private serialise<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(tenantId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(tenantId, tail);
    void tail.then(() => {
      if (this.chains.get(tenantId) === tail) this.chains.delete(tenantId);
    });
    return run;
  }
}
