import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { siteButton } from "@/components/site/button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { getAccountDataSource } from "@/lib/account-data";
import { headline, needsCard, planStatus } from "@/lib/account-data/derive";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { formatMoney, pricingConfig, tierSentence } from "@/lib/pricing";
import { dashboardHref, parseBillingNotice } from "@/lib/site/dashboard-url";

import { addCardAction, endTrialNowAction, openBillingPortalAction, startCheckoutAction } from "./actions";

// Session-gated (requireAccountSession reads cookies): never prerendered.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `Billing — ${brandConfig().name}`, robots: { index: false } };
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const NOTICE = {
  trial_ended: "Your free trial has ended and monthly billing has started. This page can take a moment to catch up.",
  card_added: "Card saved. If sending was paused it restarts once Stripe confirms, which can take a moment.",
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
  const hasCard = billing.cardLast4 !== null;
  const status = planStatus(account, now, { hasCard });
  // Offered for the whole trial on this page (not just its last days), and once a trial has ended with no card.
  const offerCard = needsCard(account, now, hasCard) || (account.billingStatus === "trialing" && !hasCard);
  const endsOn = billing.nextInvoiceAt ? DATE.format(new Date(billing.nextInvoiceAt)) : null;
  const next = billing.cancelAtPeriodEnd
    ? "None, the plan is ending"
    : billing.nextInvoiceAt && billing.nextInvoiceAmount !== null
      ? `${formatMoney(billing.nextInvoiceAmount, billing.currency)} on ${DATE.format(new Date(billing.nextInvoiceAt))}`
      : "None scheduled";

  return (
    <>
      <section className="surface-dark pb-[clamp(40px,5vw,64px)] pt-8 md:pt-12">
        <Container>
          <h1 className="font-display text-[clamp(2.1rem,4.4vw,3.4rem)] font-extrabold leading-[1.02] tracking-[-0.025em]">Billing</h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Chip tone={status.tone}>{status.label}</Chip>
            <p className="text-lg font-medium text-ink-dim tabular-nums">{headline(rows)}</p>
          </div>
        </Container>
      </section>
      <Container className="py-10 md:py-14">
        <div className="max-w-2xl">
          {status.banner ? (
            <div role="alert" className="mb-6 rounded-[12px] border-2 border-loss bg-loss-soft p-4 font-medium text-ink">
              {status.banner}
            </div>
          ) : null}

          {message ? (
            <p role="status" className="mb-6 rounded-[12px] border-2 border-info bg-info-soft p-3 font-medium text-ink">
              {message}
            </p>
          ) : null}

          <Card>
            <dl className="grid gap-x-4 gap-y-4 sm:grid-cols-[10rem_1fr]">
              <dt className="text-ink-faint">Plan</dt>
              <dd>
                <p className="font-semibold tabular-nums">{headline(rows)}</p>
                <p className="mt-1 text-sm text-ink-dim">{tierSentence(pricingConfig().currency)}</p>
                {billing.cancelAtPeriodEnd ? <p className="mt-1 text-sm font-medium text-ink">Cancels at the end of this period{endsOn ? ` on ${endsOn}` : ""}.</p> : null}
              </dd>
              <dt className="text-ink-faint">Card</dt>
              <dd>{billing.cardLast4 ? <>Ending {billing.cardLast4}</> : "No card on file"}</dd>
              <dt className="text-ink-faint">Next invoice</dt>
              <dd className="tabular-nums">{next}</dd>
            </dl>
          </Card>

          <div className="mt-8 flex flex-col gap-6">
            {account.billingStatus === "pending" ? (
              <form action={startCheckoutAction}>
                <button type="submit" className={siteButton("coral")}>
                  Start your free trial
                </button>
              </form>
            ) : null}
            {account.billingStatus === "cancelled" ? (
              <form action={startCheckoutAction}>
                <button type="submit" className={siteButton("coral")}>
                  Restart your subscription — billing starts today
                </button>
              </form>
            ) : null}
            {offerCard ? (
              <form action={addCardAction}>
                <button type="submit" className={siteButton("coral")}>
                  Add a card
                </button>
                <p className="mt-2 text-sm text-ink-dim">
                  {account.billingStatus === "paused"
                    ? "Sending restarts as soon as the card is saved. Monthly billing starts today."
                    : "Nothing is charged until your trial ends. Without a card, sending pauses when it does."}
                </p>
              </form>
            ) : null}
            {account.billingStatus === "trialing" ? (
              <form action={endTrialNowAction}>
                <button type="submit" className={siteButton("line")}>
                  Start my paid plan now
                </button>
                <p className="mt-2 text-sm text-ink-dim">
                  Ends the free trial today and starts monthly billing for your active numbers.
                  {hasCard ? null : " We'll ask for a card first."}
                </p>
              </form>
            ) : null}
            <form action={openBillingPortalAction}>
              <button
                type="submit"
                disabled={!billing.portalAvailable}
                aria-describedby={billing.portalAvailable ? undefined : "portal-hint"}
                className={siteButton("line")}
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
            <Link href={dashboardHref()} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
              Back to the dashboard
            </Link>
          </p>
        </div>
      </Container>
    </>
  );
}
