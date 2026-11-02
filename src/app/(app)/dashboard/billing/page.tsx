import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { siteButton } from "@/components/site/button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { getAccountDataSource } from "@/lib/account-data";
import { headline, needsCard, planStatus } from "@/lib/account-data/derive";
import { hasCardOnFile } from "@/lib/billing/activation";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { formatMoney, pricingConfig, tierSentence } from "@/lib/pricing";
import { dashboardHref, parseBillingNotice } from "@/lib/site/dashboard-url";

import { addCardAction, openBillingPortalAction, startCheckoutAction } from "./actions";

// Session-gated (requireAccountSession reads cookies): never prerendered.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `Billing — ${brandConfig().name}`, robots: { index: false } };
}

const NOTICE = {
  card_added: "Card saved. Any number that had stopped restarts once Stripe confirms, which can take a moment.",
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
  const source = getAccountDataSource(session);
  const [account, billing] = await Promise.all([source.getAccount(), source.getBilling({ withCard: true })]);
  const status = planStatus(account, billing);
  const offerCard = needsCard(account, billing);
  const month = formatMoney(billing.monthlyAmount, billing.currency);
  const trials = billing.trialingNumbers;

  return (
    <>
      <section className="surface-dark pb-[clamp(40px,5vw,64px)] pt-8 md:pt-12">
        <Container>
          <h1 className="font-display text-[clamp(2.1rem,4.4vw,3.4rem)] font-extrabold leading-[1.02] tracking-[-0.025em]">Billing</h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Chip tone={status.tone}>{status.label}</Chip>
            <p className="text-lg font-medium text-ink-dim tabular-nums">{headline(billing.billedNumbers)}</p>
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
                <p className="font-semibold tabular-nums">{headline(billing.billedNumbers)}</p>
                <p className="mt-1 text-sm text-ink-dim">{tierSentence(pricingConfig().currency)}</p>
              </dd>
              <dt className="text-ink-faint">Card</dt>
              <dd>{billing.cardLast4 ? <>Ending {billing.cardLast4}</> : "No card on file"}</dd>
              <dt className="text-ink-faint">Payments</dt>
              <dd className="tabular-nums">
                {billing.billedNumbers === 0
                  ? "None yet"
                  : `${month} a month in all. Each number is charged separately, every month on the day its trial ended.`}
                {trials > 0 ? <p className="mt-1 text-sm text-ink-dim">{trials} {trials === 1 ? "number is" : "numbers are"} still in the free trial and not yet charged.</p> : null}
              </dd>
            </dl>
          </Card>

          <div className="mt-8 flex flex-col gap-6">
            {!hasCardOnFile(account.billingStatus) ? (
              <form action={startCheckoutAction}>
                <button type="submit" className={siteButton("coral")}>
                  Save a card
                </button>
                <p className="mt-2 text-sm text-ink-dim">Nothing is charged until a number you add finishes its free trial.</p>
              </form>
            ) : null}
            {offerCard ? (
              <form action={addCardAction}>
                <button type="submit" className={siteButton("coral")}>
                  Add a card
                </button>
                <p className="mt-2 text-sm text-ink-dim">Stopped numbers restart as soon as the card is saved, and are charged then.</p>
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
                  Available once you have saved a card.
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
