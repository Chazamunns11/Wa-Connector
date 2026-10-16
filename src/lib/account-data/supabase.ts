import type { GhlRepository } from "@/lib/data/repository";
import { monthlyCostPence, pricingConfig } from "@/lib/pricing";
import type { retrieveSubscription } from "@/lib/stripe/billing";
import { activeCount } from "./derive";
import { DEFAULT_DAILY_CAP, toLocationRow } from "./map";
import type { AccountDataSource, AccountSummary, BillingSummary, LocationRow } from "./types";

const DAY_MS = 86_400_000;

type AccountRepo = Pick<
  GhlRepository,
  "getAccountById" | "listGhlAccountsForAccount" | "getWhatsappSessionSummariesForTenants" | "getLocationStats"
>;

/** The real account data, read through the service-role repository for one account id (already authorised by the session). */
export class SupabaseAccountDataSource implements AccountDataSource {
  readonly preview = false;

  private readonly repo: AccountRepo;
  private readonly deps: { retrieveSubscription: typeof retrieveSubscription };
  private readonly accountId: string;
  private readonly now: Date;

  constructor(
    repo: AccountRepo,
    deps: { retrieveSubscription: typeof retrieveSubscription },
    accountId: string,
    now: Date,
  ) {
    this.repo = repo;
    this.deps = deps;
    this.accountId = accountId;
    this.now = now;
  }

  async getAccount(): Promise<AccountSummary> {
    const a = await this.repo.getAccountById(this.accountId);
    if (!a) throw new Error("account not found");
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      email: a.ownerEmail,
      billingStatus: a.billingStatus,
      trialEndsAt: a.trialEndsAt,
      stripeCustomerId: a.stripeCustomerId,
      stripeSubscriptionId: a.stripeSubscriptionId,
    };
  }

  async listLocations(): Promise<LocationRow[]> {
    const locs = await this.repo.listGhlAccountsForAccount(this.accountId);
    if (locs.length === 0) return [];
    const since = new Date(this.now.getTime() - 7 * DAY_MS).toISOString();
    const [summaries, stats] = await Promise.all([
      this.repo.getWhatsappSessionSummariesForTenants(locs.map((l) => l.tenantId)),
      this.repo.getLocationStats(locs.map((l) => l.locationId), since),
    ]);
    const byTenant = new Map(summaries.map((s) => [s.coachId, s]));
    const none = { pendingSend: 0, failedLast7Days: { count: 0, reasons: [] as string[] }, everReceived: false };
    return locs.map((l) =>
      toLocationRow(l, byTenant.get(l.tenantId) ?? null, stats[l.locationId] ?? none, this.now, DEFAULT_DAILY_CAP),
    );
  }

  async getBilling(): Promise<BillingSummary> {
    const account = await this.getAccount();
    const currency = pricingConfig().currency;
    const base: BillingSummary = {
      cardLast4: null,
      nextInvoiceAt: null,
      nextInvoiceAmount: null,
      currency,
      portalAvailable: !!account.stripeCustomerId,
      cancelAtPeriodEnd: false,
    };
    if (!account.stripeSubscriptionId) return { ...base, portalAvailable: false };
    const [sub, rows] = await Promise.all([this.deps.retrieveSubscription(account.stripeSubscriptionId), this.listLocations()]);
    if (!sub.ok) return base;
    return {
      ...base,
      cardLast4: sub.data.cardLast4,
      nextInvoiceAt: sub.data.currentPeriodEnd ? new Date(sub.data.currentPeriodEnd * 1000).toISOString() : null,
      nextInvoiceAmount: monthlyCostPence(activeCount(rows)) / 100,
      cancelAtPeriodEnd: sub.data.cancelAtPeriodEnd,
    };
  }
}
