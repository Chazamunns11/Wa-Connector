import Link from "next/link";
import { Chip } from "@/components/ui/Chip";
import { siteButton } from "@/components/site/button";
import type { FleetSummary, PlanStatus } from "@/lib/account-data/derive";
import { APP_ROUTE_HANDLERS } from "@/lib/site/routes";

function Figure({ value, label, note }: { value: number; label: string; note?: string }) {
  return (
    <div className="fleet-item">
      <dt className="sr-only">{label}</dt>
      <dd className="m-0">
        <span className="fleet-figure block">{value.toLocaleString("en-GB")}</span>
        <span aria-hidden="true" className="mt-1.5 block text-sm font-semibold text-ink-dim">
          {label}
        </span>
        {note ? <span className="mt-0.5 block text-sm text-ink-faint">{note}</span> : null}
      </dd>
    </div>
  );
}

/**
 * The dashboard's Ink top band: the account, its plan, the two buttons, and four plain counts
 * across every sub-account, so the state of the whole agency reads before the table does.
 */
export function PlanHeader({
  accountName,
  status,
  headline,
  hasLocations,
  billingHref,
  summary,
  bannerAction,
}: {
  accountName: string;
  status: PlanStatus;
  headline: string;
  hasLocations: boolean;
  billingHref: string;
  summary: FleetSummary;
  /**
   * The banner's button. A pending account (Checkout abandoned) posts to the
   * action that opens a fresh Checkout; a trial that has ended (or is about to)
   * with no card posts to "Add a card".
   */
  bannerAction?: { action: () => Promise<void>; label: string };
}) {
  return (
    <header>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          <h1 className="font-display text-[clamp(2.1rem,4.4vw,3.4rem)] font-extrabold leading-[1.02] tracking-[-0.025em]">
            {accountName}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Chip tone={status.tone}>{status.label}</Chip>
            <p className="text-lg font-medium text-ink-dim tabular-nums">{headline}</p>
          </div>
        </div>
        <div className="btn-stack flex flex-wrap gap-3">
          <a href={APP_ROUTE_HANDLERS.connectGhl} className={siteButton("coral")}>
            {hasLocations ? "Add sub-accounts" : "Connect GoHighLevel"}
          </a>
          <Link href={billingHref} className={siteButton("line")}>
            Billing
          </Link>
        </div>
      </div>
      {status.banner ? (
        <div role="alert" className="mt-6 rounded-[12px] border-2 border-loss bg-loss-soft p-4 font-medium text-ink">
          {status.banner}
          {bannerAction ? (
            <form action={bannerAction.action} className="mt-3">
              <button type="submit" className={siteButton("coral")}>
                {bannerAction.label}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {hasLocations ? (
        <dl aria-label="Across all sub-accounts" className="fleet mt-10">
          <Figure value={summary.connected} label="Connected" />
          <Figure
            value={summary.offline}
            label="Phone offline"
            note={summary.waiting > 0 ? `${summary.waiting} ${summary.waiting === 1 ? "message" : "messages"} waiting` : undefined}
          />
          <Figure value={summary.awaitingScan} label="Waiting for a QR scan" />
          <Figure value={summary.sentToday} label="Sent today" />
        </dl>
      ) : null}
    </header>
  );
}
