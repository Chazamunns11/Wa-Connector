import type { Metadata } from "next";
import { AttentionFilter } from "@/components/app/AttentionFilter";
import { LocationNumbersPanel } from "@/components/app/LocationNumbersPanel";
import { LocationTable } from "@/components/app/LocationTable";
import { PlanHeader } from "@/components/app/PlanHeader";
import { GhlResultNotice } from "@/components/app/GhlResultNotice";
import { Container } from "@/components/site/Container";
import { EmptyState } from "@/components/ui/EmptyState";
import { getAccountDataSource } from "@/lib/account-data";
import { connectLinkForOwnedLocation } from "@/lib/account-data/connect-link";
import { fleetSummary, headline, needsAttention, needsCard, planStatus } from "@/lib/account-data/derive";
import { hasCardOnFile } from "@/lib/billing/activation";
import { isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { billingHref, DASHBOARD_RESULT_COPY, dashboardHref, parseFilter, parseResult } from "@/lib/site/dashboard-url";

import { siteButton } from "@/components/site/button";
import { addCardAction, startCheckoutAction } from "./billing/actions";

// Session-gated (requireAccountSession reads cookies): never prerendered.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `Dashboard — ${brandConfig().name}`, robots: { index: false } };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** A plain non-negative count from a redirect query, or undefined. */
function count(v: string | string[] | undefined): number | undefined {
  const n = Number(first(v));
  return Number.isInteger(n) && n >= 0 && n < 100_000 ? n : undefined;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAccountSession();
  const params = await searchParams;
  const filter = parseFilter(params.filter);
  const result = parseResult(params.result);
  const now = new Date();
  const source = getAccountDataSource(session, now);
  // getBilling here is one database read (number counts), no Stripe call.
  const [account, rows, billing] = await Promise.all([source.getAccount(), source.listLocations(), source.getBilling()]);
  const bannerAction = !hasCardOnFile(account.billingStatus)
    ? { action: startCheckoutAction, label: "Save a card" }
    : needsCard(account, billing)
      ? { action: addCardAction, label: "Add a card" }
      : undefined;

  // Both only ever name a row of this account's own list; the link is minted here, never carried in a URL.
  const focusRow = rows.find((r) => r.id === first(params.focus));
  const qrRow = rows.find((r) => r.id === first(params.qr));
  const connectUrl =
    result === "link" && focusRow ? await connectLinkForOwnedLocation(session.accountId, focusRow.id) : null;
  const rowExtras = {
    connectLink: focusRow && connectUrl ? { locationId: focusRow.id, url: connectUrl } : undefined,
    qr: qrRow
      ? {
          locationId: qrRow.id,
          panel: (
            <LocationNumbersPanel
              locationId={qrRow.id}
              name={qrRow.name}
              bridgeConfigured={isWhatsappBridgeConfigured()}
              nowMs={now.getTime()}
            />
          ),
        }
      : undefined,
  };

  const summary = fleetSummary(rows);
  const attentionCount = summary.attention;
  const visible = filter === "attention" ? rows.filter((r) => needsAttention(r) !== null) : rows;

  return (
    <>
      <section className="surface-dark pb-[clamp(40px,5vw,64px)] pt-8 md:pt-12">
        <Container>
          <PlanHeader
            accountName={account.name}
            status={planStatus(account, billing)}
            headline={headline(billing.billedNumbers)}
            hasLocations={rows.length > 0}
            billingHref={billingHref()}
            summary={summary}
            bannerAction={bannerAction}
          />
        </Container>
      </section>

      <Container className="py-10 md:py-14">
        {result ? (
          <p role="status" className="mb-6 rounded-[12px] border-2 border-info bg-info-soft p-4 font-medium text-ink">
            {result === "link" && !connectUrl ? DASHBOARD_RESULT_COPY.link_unavailable : DASHBOARD_RESULT_COPY[result]}
          </p>
        ) : null}
        <GhlResultNotice
          reason={first(params.ghl)}
          installed={count(params.installed)}
          failed={count(params.failed)}
          conflicts={count(params.conflicts)}
          error={first(params.error)}
        />

        <section aria-labelledby="subaccounts">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <h2 id="subaccounts" className="h-section font-display">
              Sub-accounts
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <AttentionFilter filter={filter} total={rows.length} attention={attentionCount} />
              {/* The install starts here for agency owners (the OAuth start route already accepts an account session). */}
              <a href="/api/crm/oauth/start" className={siteButton("ink")}>
                Add sub-accounts
              </a>
            </div>
          </div>
          <div className="mt-6">
            {rows.length === 0 ? (
              <EmptyState
                title="No sub-accounts yet"
                description="Connect GoHighLevel to see your sub-accounts here."
                action={
                  <a href="/api/crm/oauth/start" className={siteButton("ink")}>
                    Connect GoHighLevel
                  </a>
                }
              />
            ) : visible.length === 0 ? (
              <EmptyState
                title="Nothing needs attention"
                description="Every active number is connected and sending."
                action={
                  <a href={dashboardHref()} className="font-semibold underline underline-offset-2">
                    Show all sub-accounts
                  </a>
                }
              />
            ) : (
              <LocationTable rows={visible} filter={filter} open={first(params.open)} {...rowExtras} />
            )}
          </div>
        </section>
      </Container>
    </>
  );
}
