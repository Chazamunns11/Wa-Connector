import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { getAccountDataSource } from "@/lib/account-data";
import { headline, planStatus } from "@/lib/account-data/derive";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { formatMoney, pricingConfig, tierSentence } from "@/lib/pricing";
import { dashboardHref, parseBillingNotice } from "@/lib/site/dashboard-url";

import { endTrialNowAction, openBillingPortalAction, startCheckoutAction } from "./actions";

// Session-gated (requireAccountSession reads cookies): never prerendered.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `Billing — ${brandConfig().name}`, robots: { index: false } };
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const NOTICE = {
  trial_ended: "Your free trial has ended and monthly billing has started. This page can take a moment to catch up.",
  no_portal: "There is no billing portal for this account yet.",
  stripe_failed: "We could not reach billing just now, so nothing was changed. Please try again.",
} as const;

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const notice = parseBillingNotice(await searchParams);
  const message = notice.error ? NOTICE[notice.error] : notice.result ? NOTICE[notice.result] : null;
  const session = await requireAccountSession();
  const now = new Date();
  const source = getAccountDataSource(session, now);
  const [account, rows] = await Promise.all([source.getAccount(), source.listLocations()]);
  const billing = await source.getBilling(rows);
  const status = planStatus(account, now);
  const endsOn = billing.nextInvoiceAt ? DATE.format(new Date(billing.nextInvoiceAt)) : null;
  const next = billing.cancelAtPeriodEnd
    ? "None, the plan is ending"
    : billing.nextInvoiceAt && billing.nextInvoiceAmount !== null
      ? `${formatMoney(billing.nextInvoiceAmount, billing.currency)} on ${DATE.format(new Date(billing.nextInvoiceAt))}`
      : "None scheduled";

  return (
    <Container className="py-8 md:py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="font-display text-[clamp(28px,5vw,40px)] leading-[1.15]">Billing</h1>
        {status.banner ? (
          <div role="alert" className="mt-4 rounded-lg border border-loss/30 bg-loss-soft p-4 font-medium text-ink">
            {status.banner}
          </div>
        ) : null}

        {message ? (
          <p role="status" className="mt-4 rounded-lg border border-info/30 bg-info-soft p-3 font-medium text-ink">
            {message}
          </p>
        ) : null}

        <Card className="mt-6">
          <dl className="grid gap-x-4 gap-y-4 sm:grid-cols-[10rem_1fr]">
            <dt className="text-ink-faint">Plan</dt>
            <dd>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={status.tone}>{status.label}</Chip>
                <span className="text-ink-dim">{headline(rows)}</span>
              </div>
              <p className="mt-1 text-sm text-ink-dim">{tierSentence(pricingConfig().currency)}</p>
              {billing.cancelAtPeriodEnd ? <p className="mt-1 text-sm font-medium text-ink">Cancels at the end of this period{endsOn ? ` on ${endsOn}` : ""}.</p> : null}
            </dd>
            <dt className="text-ink-faint">Card</dt>
            <dd>{billing.cardLast4 ? <>Ending {billing.cardLast4}</> : "No card on file"}</dd>
            <dt className="text-ink-faint">Next invoice</dt>
            <dd className="tabular-nums">{next}</dd>
          </dl>
        </Card>

        <div className="mt-6 flex flex-col gap-6">
          {account.billingStatus === "pending" ? (
            <form action={startCheckoutAction}>
              <button type="submit" className={buttonClasses("primary", "md", "min-h-11 px-5")}>
                Add a card to start your trial
              </button>
            </form>
          ) : null}
          {account.billingStatus === "trialing" ? (
            <form action={endTrialNowAction}>
              <button type="submit" className={buttonClasses("secondary", "md", "min-h-11 px-5")}>
                Start my paid plan now
              </button>
              <p className="mt-2 text-sm text-ink-dim">
                Ends the free trial today and starts monthly billing for your active numbers.
              </p>
            </form>
          ) : null}
          <form action={openBillingPortalAction}>
            <button
              type="submit"
              disabled={!billing.portalAvailable}
              aria-describedby={billing.portalAvailable ? undefined : "portal-hint"}
              className={buttonClasses("secondary", "md", "min-h-11 px-5")}
            >
              Manage billing
            </button>
            {billing.portalAvailable ? null : (
              <p id="portal-hint" className="mt-2 text-sm text-ink-dim">
                Available once you have started your trial.
              </p>
            )}
          </form>
        </div>

        <p className="mt-8">
          <Link href={dashboardHref()} className="text-accent-text underline underline-offset-2">
            Back to the dashboard
          </Link>
        </p>
      </div>
    </Container>
  );
}
