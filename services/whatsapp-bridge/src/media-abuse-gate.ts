/**
 * Media plan (docs/MEDIA-PLAN.md §9) — the abuse caps in front of inbound
 * media capture: 20 downloads per (tenant, sender phone, UTC day), 300 per
 * (tenant, UTC day). Inbound is deliberately UNGATED by the ledger for
 * `ghl_location` tenants (cold inbound is the product), so without a cap an
 * unauthenticated stranger could command unbounded bandwidth/storage/disk —
 * see the plan's "500-videos scenario".
 *
 * Same shape as `src/inbound.ts`'s `ProspectLedgerCache`: a per-process,
 * per-session cache in front of a DB count, NOT the correctness mechanism
 * itself — the DB is reseeded into the cache once per (key, UTC day) on
 * first use, then incremented in memory for the rest of that day (avoiding a
 * round trip per file). A bridge restart mid-day re-seeds from the DB's true
 * count on the next call for each key, so the cap is never permanently lost,
 * only briefly re-read. This is a defence-in-depth cost/abuse control, not a
 * hard security boundary (the allowlist + per-file cap + 90-day purge are) —
 * an off-by-one from the seed read racing a concurrent insert is accepted,
 * same tolerance this codebase already gives `ghl_inbound_messages.push_attempts`'
 * lost-update window (`supabase/migrations/0072_ghl_inbound_push.sql`).
 */

export interface MediaAbuseGateDeps {
  /** Count of this sender's media-capture ATTEMPTS today (any resolved or in-flight `media_status`) — `BridgeStore.countInboundMediaAttemptsForSenderToday`, or a fake in tests. */
  countSenderToday(tenantId: string, senderPhone: string): Promise<number>;
  /** Same, scoped to the whole tenant — `BridgeStore.countInboundMediaAttemptsForTenantToday`. */
  countTenantToday(tenantId: string): Promise<number>;
}

interface DayCount {
  day: string;
  count: number;
}

export class MediaAbuseGate {
  private readonly senderCounts = new Map<string, DayCount>();
  private readonly tenantCounts = new Map<string, DayCount>();

  constructor(
    private readonly perSenderDailyCap: number,
    private readonly perTenantDailyCap: number,
    private readonly deps: MediaAbuseGateDeps,
    private readonly now: () => number = Date.now
  ) {}

  private utcDayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /**
   * Atomic (within this single-threaded process) check-and-reserve: `true`
   * iff BOTH caps currently allow one more download, in which case BOTH
   * counters are incremented in the same call; `false` leaves both counters
   * untouched — a rejected attempt must never itself consume budget.
   */
  async checkAndReserve(tenantId: string, senderPhone: string): Promise<boolean> {
    const day = this.utcDayKey();
    const senderKey = `${tenantId}:${senderPhone}`;

    let sender = this.senderCounts.get(senderKey);
    if (!sender || sender.day !== day) {
      sender = { day, count: await this.deps.countSenderToday(tenantId, senderPhone) };
      this.senderCounts.set(senderKey, sender);
    }
    let tenant = this.tenantCounts.get(tenantId);
    if (!tenant || tenant.day !== day) {
      tenant = { day, count: await this.deps.countTenantToday(tenantId) };
      this.tenantCounts.set(tenantId, tenant);
    }

    if (sender.count >= this.perSenderDailyCap || tenant.count >= this.perTenantDailyCap) return false;

    sender.count += 1;
    tenant.count += 1;
    return true;
  }
}
