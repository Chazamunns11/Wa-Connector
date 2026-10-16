import type { Metadata } from "next";
import Link from "next/link";
import { ScenarioSwitcher } from "@/components/app/ScenarioSwitcher";
import { Container } from "@/components/site/Container";
import { PreviewBadge } from "@/components/site/PreviewBadge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { getAccountDataSource, parseScenario } from "@/lib/account-data";
import { headline, planStatus } from "@/lib/account-data/derive";
import { brandConfig } from "@/lib/brand-config";
import { formatMoney, pricingConfig } from "@/lib/pricing";
import { dashboardHref } from "@/lib/site/dashboard-url";

export function generateMetadata(): Metadata {
  return { title: `Billing (preview) — ${brandConfig().name}`, robots: { index: false } };
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const scenario = parseScenario(params.scenario);
  const now = new Date();
  const source = getAccountDataSource({ scenario, now });
  const [account, rows, billing] = await Promise.all([source.getAccount(), source.listLocations(), source.getBilling()]);
  const status = planStatus(account, now);
  const next =
    billing.nextInvoiceAt && billing.nextInvoiceAmount !== null
      ? `${formatMoney(billing.nextInvoiceAmount, billing.currency)} on ${DATE.format(new Date(billing.nextInvoiceAt))}`
      : "None scheduled";

  return (
    <Container className="py-8 md:py-12">
      <div className="mx-auto max-w-2xl">
        <header className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="font-display text-[clamp(28px,5vw,40px)] leading-[1.15]">Billing</h1>
          <PreviewBadge />
        </header>
        {status.banner ? (
          <div role="alert" className="mt-4 rounded-lg border border-loss/30 bg-loss-soft p-4 font-medium text-ink">
            {status.banner}
          </div>
        ) : null}

        <Card className="mt-6">
          <dl className="grid gap-x-4 gap-y-4 sm:grid-cols-[10rem_1fr]">
            <dt className="text-ink-faint">Plan</dt>
            <dd>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={status.tone}>{status.label}</Chip>
                <span className="text-ink-dim">{headline(rows, pricingConfig())}</span>
              </div>
              <p className="mt-1 text-sm text-ink-faint">
                Billed per active number: {formatMoney(pricingConfig().pricePerNumber, pricingConfig().currency)} a month each.
              </p>
            </dd>
            <dt className="text-ink-faint">Card</dt>
            <dd>{billing.cardLast4 ? <>Ending {billing.cardLast4} <span className="text-ink-faint">(sample)</span></> : "No card on file"}</dd>
            <dt className="text-ink-faint">Next invoice</dt>
            <dd className="tabular-nums">{next} <span className="text-ink-faint">(sample)</span></dd>
          </dl>
        </Card>

        <div className="mt-6">
          <Button type="button" disabled aria-describedby="portal-hint" className="min-h-11 px-5">
            Manage billing
          </Button>
          <p id="portal-hint" className="mt-2 text-sm text-ink-dim">
            Opens the billing portal once your account is live
          </p>
        </div>

        <p className="mt-8">
          <Link href={dashboardHref({ scenario })} className="text-accent-text underline underline-offset-2">
            Back to the dashboard
          </Link>
        </p>
        {source.preview ? (
          <div className="mt-6 border-t border-divider pt-4">
            <ScenarioSwitcher scenario={scenario} billing />
            <p className="mt-1 text-sm text-ink-faint">Sample data. Nothing here is a real account.</p>
          </div>
        ) : null}
      </div>
    </Container>
  );
}
