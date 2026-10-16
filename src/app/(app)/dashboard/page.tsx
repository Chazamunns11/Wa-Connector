import type { Metadata } from "next";
import { AttentionFilter } from "@/components/app/AttentionFilter";
import { LocationQrPanel } from "@/components/app/LocationQrPanel";
import { LocationTable } from "@/components/app/LocationTable";
import { PlanHeader } from "@/components/app/PlanHeader";
import { GhlResultNotice } from "@/components/app/GhlResultNotice";
import { Container } from "@/components/site/Container";
import { EmptyState } from "@/components/ui/EmptyState";
import { getAccountDataSource } from "@/lib/account-data";
import { connectLinkForOwnedLocation } from "@/lib/account-data/connect-link";
import { headline, needsAttention, planStatus } from "@/lib/account-data/derive";
import { panelSummaryFromRow } from "@/lib/account-data/map";
import { isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { billingHref, DASHBOARD_RESULT_COPY, dashboardHref, parseFilter, parseResult } from "@/lib/site/dashboard-url";

import { buttonClasses } from "@/components/ui/Button";
import { endTrialNowAction, startCheckoutAction } from "./billing/actions";

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
  const [account, rows] = await Promise.all([source.getAccount(), source.listLocations()]);

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
            <LocationQrPanel
              locationId={qrRow.id}
              name={qrRow.name}
              summary={panelSummaryFromRow(qrRow)}
              bridgeConfigured={isWhatsappBridgeConfigured()}
              nowMs={now.getTime()}
            />
          ),
        }
      : undefined,
  };

  const attentionCount = rows.filter((r) => needsAttention(r) !== null).length;
  const visible = filter === "attention" ? rows.filter((r) => needsAttention(r) !== null) : rows;

  return (
    <Container className="py-8 md:py-12">
      <PlanHeader
        accountName={account.name}
        status={planStatus(account, now)}
        headline={headline(rows)}
        hasLocations={rows.length > 0}
        billingHref={billingHref()}
        pendingCheckoutAction={account.billingStatus === "pending" ? startCheckoutAction : undefined}
      />

      {result ? (
        <p role="status" className="mt-4 rounded-lg border border-info/30 bg-info-soft p-3 font-medium text-ink">
          {result === "link" && !connectUrl ? DASHBOARD_RESULT_COPY.link_unavailable : DASHBOARD_RESULT_COPY[result]}
          {result === "trial_cap" && account.billingStatus === "trialing" ? (
            <form action={endTrialNowAction} className="mt-3">
              <button type="submit" className={buttonClasses("primary", "md", "min-h-11 px-5")}>
                Start my paid plan now
              </button>
            </form>
          ) : null}
        </p>
      ) : null}
      <GhlResultNotice
        reason={first(params.ghl)}
        installed={count(params.installed)}
        failed={count(params.failed)}
        conflicts={count(params.conflicts)}
      />

      <section aria-labelledby="subaccounts" className="mt-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="subaccounts" className="font-display text-2xl">
            Sub-accounts
          </h2>
          <AttentionFilter filter={filter} total={rows.length} attention={attentionCount} />
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
                <a href={dashboardHref()} className="text-accent-text underline underline-offset-2">
                  Show all sub-accounts
                </a>
              }
            />
          ) : (
            <LocationTable rows={visible} filter={filter} {...rowExtras} />
          )}
        </div>
      </section>

    </Container>
  );
}
