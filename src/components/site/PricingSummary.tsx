import Link from "next/link";
import { Cta } from "@/components/site/Cta";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS, formatMoney, pricingConfig } from "@/lib/pricing";
import { SITE_ROUTES } from "@/lib/site/routes";

export function PricingSummary({ ctaLabel }: { ctaLabel: string }) {
  const pricing = pricingConfig();
  return (
    <div className="flex flex-wrap items-center justify-between gap-6">
      <div>
        <p className="text-sm text-ink-dim">One price per number, per month</p>
        <p className="font-display text-5xl font-extrabold leading-none [font-variant-numeric:tabular-nums]">
          {formatMoney(pricing.pricePerNumber, pricing.currency)}
        </p>
        <p className="mt-3 max-w-[48ch] text-ink-dim">
          {TRIAL_DAYS}-day free trial with up to {TRIAL_MAX_NUMBERS} numbers. Card taken up front, cancel any time from
          the billing portal.
        </p>
      </div>
      <div>
        <Cta label={ctaLabel} />
        <p className="mt-2">
          <Link href={SITE_ROUTES.pricing} className="inline-flex min-h-11 items-center text-accent-text underline">
            See the full pricing
          </Link>
        </p>
      </div>
    </div>
  );
}
