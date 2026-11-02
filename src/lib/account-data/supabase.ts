import type { GhlRepository } from "@/lib/data/repository";
import { monthlyCostPence, pricingConfig } from "@/lib/pricing";
import type { retrieveCustomerCard } from "@/lib/stripe/billing";
import { billedCount } from "@/lib/billing/numbers";
import { DEFAULT_DAILY_CAP, toLocationRow } from "./map";
import type { AccountDataSource, AccountSummary, BillingSummary, LocationRow } from "./types";

const DAY_MS = 86_400_000;

type AccountRepo = Pick<
  GhlRepository,
  | "getAccountById"
  | "listGhlAccountsForAccount"
  | "getWhatsappSessionSummariesForTenants"
  | "getLocationStats"
  | "countOptOutsByTenant"
  | "listNumberBillingForAccount"
>;

/** The real account data, read through the service-role repository for one account id (already authorised by the session). */
export class SupabaseAccountDataSource implements AccountDataSource {
  readonly preview = false;

  private readonly repo: AccountRepo;
  private readonly deps: { retrieveCustomerCard: typeof retrieveCustomerCard };
  private readonly accountId: string;
  private readonly now: Date;

  constructor(
    repo: AccountRepo,
    deps: { retrieveCustomerCard: typeof retrieveCustomerCard },
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
      stripeCustomerId: a.stripeCustomerId,
    };
  }

  async listLocations(): Promise<LocationRow[]> {
    const locs = await this.repo.listGhlAccountsForAccount(this.accountId);
    if (locs.length === 0) return [];
    const since = new Date(this.now.getTime() - 7 * DAY_MS).toISOString();
    const [summaries, stats, optOuts] = await Promise.all([
      this.repo.getWhatsappSessionSummariesForTenants(locs.map((l) => l.tenantId)),
      this.repo.getLocationStats(locs.map((l) => l.locationId), since),
      this.repo.countOptOutsByTenant(locs.map((l) => l.tenantId)),
    ]);
    const byTenant = new Map(summaries.map((s) => [s.coachId, s]));
    const none = { pendingSend: 0, failedLast7Days: { count: 0, reasons: [] as string[] }, everReceived: false };
    return locs.map((l) =>
      toLocationRow(l, byTenant.get(l.tenantId) ?? null, stats[l.locationId] ?? none, this.now, DEFAULT_DAILY_CAP, optOuts.get(l.tenantId) ?? 0),
    );
  }

  async getBilling(opts: { withCard?: boolean } = {}): Promise<BillingSummary> {
    const [account, numbers] = await Promise.all([this.getAccount(), this.repo.listNumberBillingForAccount(this.accountId)]);
    const count = (status: string) => numbers.filter((n) => n.billingStatus === status).length;
    const billedNumbers = billedCount(numbers);
    let cardLast4: string | null = null;
    if (opts.withCard && account.stripeCustomerId) {
      const card = await this.deps.retrieveCustomerCard(account.stripeCustomerId);
      // Degrades to "no card details" when Stripe fails; the page still renders.
      if (card.ok) cardLast4 = card.data.cardLast4;
    }
    return {
      cardLast4,
      billedNumbers,
      trialingNumbers: count("trialing"),
      pastDueNumbers: count("past_due"),
      stoppedNumbers: count("paused") + count("incomplete"),
      monthlyAmount: monthlyCostPence(billedNumbers) / 100,
      currency: pricingConfig().currency,
      portalAvailable: !!account.stripeCustomerId,
    };
  }
}
