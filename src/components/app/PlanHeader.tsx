import Link from "next/link";
import { Chip } from "@/components/ui/Chip";
import { buttonClasses } from "@/components/ui/Button";
import type { PlanStatus } from "@/lib/account-data/derive";
import { APP_ROUTE_HANDLERS } from "@/lib/site/routes";

/** Dashboard header: plan state, headline, the connect button and the billing link. */
export function PlanHeader({
  accountName,
  status,
  headline,
  hasLocations,
  billingHref,
  pendingCheckoutAction,
}: {
  accountName: string;
  status: PlanStatus;
  headline: string;
  hasLocations: boolean;
  billingHref: string;
  /** Set for a pending account (Checkout abandoned): posts to the action that opens a fresh Checkout. */
  pendingCheckoutAction?: () => Promise<void>;
}) {
  return (
    <header>
      <h1 className="h-app font-display">Dashboard</h1>
      <p className="mt-2 text-ink-dim">{accountName}</p>
      {status.banner ? (
        <div role="alert" className="mt-4 rounded-[12px] border-2 border-loss bg-loss-soft p-4 font-medium text-ink">
          {status.banner}
          {pendingCheckoutAction ? (
            <form action={pendingCheckoutAction} className="mt-3">
              <button type="submit" className={buttonClasses("primary", "md", "min-h-11 px-5")}>
                Add a card to start your trial
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Chip tone={status.tone}>{status.label}</Chip>
        <p className="font-display text-xl font-medium text-ink tabular-nums sm:text-2xl">{headline}</p>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <a href={APP_ROUTE_HANDLERS.connectGhl} className={buttonClasses("primary", "md", "min-h-11 px-5")}>
            {hasLocations ? "Add sub-accounts" : "Connect GoHighLevel"}
          </a>
          <Link href={billingHref} className={buttonClasses("secondary", "md", "min-h-11 px-5")}>
            Billing
          </Link>
        </div>
      </div>
    </header>
  );
}
