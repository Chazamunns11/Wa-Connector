import type { Metadata } from "next";
import { AttentionFilter } from "@/components/app/AttentionFilter";
import { LocationTable } from "@/components/app/LocationTable";
import { PlanHeader } from "@/components/app/PlanHeader";
import { ScenarioSwitcher } from "@/components/app/ScenarioSwitcher";
import { Container } from "@/components/site/Container";
import { EmptyState } from "@/components/ui/EmptyState";
import { getAccountDataSource, parseScenario } from "@/lib/account-data";
import { headline, needsAttention, planStatus } from "@/lib/account-data/derive";
import { brandConfig } from "@/lib/brand-config";
import { pricingConfig } from "@/lib/pricing";
import { billingHref, dashboardHref, parseFilter } from "@/lib/site/dashboard-url";

export function generateMetadata(): Metadata {
  return { title: `Dashboard (preview) — ${brandConfig().name}`, robots: { index: false } };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const scenario = parseScenario(params.scenario);
  const filter = parseFilter(params.filter);
  const now = new Date();
  const source = getAccountDataSource({ scenario, now });
  const [account, rows] = await Promise.all([source.getAccount(), source.listLocations()]);

  const attentionCount = rows.filter((r) => needsAttention(r) !== null).length;
  const visible = filter === "attention" ? rows.filter((r) => needsAttention(r) !== null) : rows;
  
  return (
    <Container className="py-8 md:py-12">
      <PlanHeader
        accountName={account.name}
        status={planStatus(account, now)}
        headline={headline(rows, pricingConfig())}
        hasLocations={rows.length > 0}
        billingHref={billingHref(scenario)}
      />

      {params.notice === "preview" ? (
        <p
          id="preview-notice"
          role="status"
          tabIndex={-1}
          className="mt-4 rounded-lg border border-info/30 bg-info-soft p-3 font-medium text-ink"
        >
          Preview — row actions are simulated. Nothing was changed.
        </p>
      ) : null}

      <section aria-labelledby="subaccounts" className="mt-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="subaccounts" className="font-display text-2xl">
            Sub-accounts
          </h2>
          <AttentionFilter scenario={scenario} filter={filter} total={rows.length} attention={attentionCount} />
        </div>
        <div className="mt-4">
          {rows.length === 0 ? (
            <EmptyState
              title="No sub-accounts yet"
              description="Connect GoHighLevel to see your sub-accounts here."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="Nothing needs attention"
              description="Every active number is connected and sending."
              action={
                <a href={dashboardHref({ scenario })} className="text-accent-text underline underline-offset-2">
                  Show all sub-accounts
                </a>
              }
            />
          ) : (
            <LocationTable rows={visible} scenario={scenario} filter={filter} />
          )}
        </div>
      </section>

      {source.preview ? (
        <div className="mt-8 border-t border-divider pt-4">
          <ScenarioSwitcher scenario={scenario} filter={filter} />
          <p className="mt-1 text-sm text-ink-faint">Sample data. Nothing here is a real account.</p>
        </div>
      ) : null}
    </Container>
  );
}
