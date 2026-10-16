import Link from "next/link";
import { Chip } from "@/components/ui/Chip";
import { buttonClasses } from "@/components/ui/Button";
import { PreviewBadge } from "@/components/site/PreviewBadge";
import type { PlanStatus } from "@/lib/account-data/derive";
import { SITE_ROUTES } from "@/lib/site/routes";

/** Dashboard header: preview badge, plan state, headline, the connect button and the billing link. */
export function PlanHeader({
  accountName,
  status,
  headline,
  hasLocations,
  billingHref,
}: {
  accountName: string;
  status: PlanStatus;
  headline: string;
  hasLocations: boolean;
  billingHref: string;
}) {
  return (
    <header>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-[clamp(28px,5vw,40px)] leading-[1.15]">Dashboard</h1>
        <PreviewBadge />
      </div>
      <p className="mt-2 text-ink-dim">{accountName}</p>
      {status.banner ? (
        <div role="alert" className="mt-4 rounded-lg border border-loss/30 bg-loss-soft p-4 font-medium text-ink">
          {status.banner}
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Chip tone={status.tone}>{status.label}</Chip>
        <p className="font-display text-xl font-medium text-ink tabular-nums sm:text-2xl">{headline}</p>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Link href={SITE_ROUTES.setup} className={buttonClasses("primary", "md", "min-h-11 px-5")}>
            {hasLocations ? "Add sub-accounts" : "Connect GoHighLevel"}
          </Link>
          <Link href={billingHref} className={buttonClasses("secondary", "md", "min-h-11 px-5")}>
            Billing
          </Link>
        </div>
      </div>
    </header>
  );
}
