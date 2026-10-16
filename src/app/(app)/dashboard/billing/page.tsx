import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { getAccountDataSource } from "@/lib/account-data";
import { headline, planStatus } from "@/lib/account-data/derive";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { formatMoney, pricingConfig, standardPrice, volumePrice, VOLUME_FROM } from "@/lib/pricing";
import { dashboardHref } from "@/lib/site/dashboard-url";

// Session-gated (requireAccountSession reads cookies): never prerendered.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `Billing — ${brandConfig().name}`, robots: { index: false } };
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export default async function BillingPage() {
  const session = await requireAccountSession();
  const now = new Date();
  const source = getAccountDataSource(session, now);
  const [account, rows, billing] = await Promise.all([source.getAccount(), source.listLocations(), source.getBilling()]);
  const status = planStatus(account, now);
  const next =
    billing.nextInvoiceAt && billing.nextInvoiceAmount !== null
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

        <Card className="mt-6">
          <dl className="grid gap-x-4 gap-y-4 sm:grid-cols-[10rem_1fr]">
            <dt className="text-ink-faint">Plan</dt>
            <dd>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={status.tone}>{status.label}</Chip>
                <span className="text-ink-dim">{headline(rows)}</span>
              </div>
              <p className="mt-1 text-sm text-ink-faint">
                Billed per active number: {standardPrice(pricingConfig().currency)} a month each, or {volumePrice(pricingConfig().currency)} each at {VOLUME_FROM} or more.
              </p>
            </dd>
            <dt className="text-ink-faint">Card</dt>
            <dd>{billing.cardLast4 ? <>Ending {billing.cardLast4}</> : "No card on file"}</dd>
            <dt className="text-ink-faint">Next invoice</dt>
            <dd className="tabular-nums">{next}</dd>
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
          <Link href={dashboardHref()} className="text-accent-text underline underline-offset-2">
            Back to the dashboard
          </Link>
        </p>
      </div>
    </Container>
  );
}
