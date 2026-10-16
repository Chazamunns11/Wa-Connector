import Link from "next/link";
import { Cta } from "@/components/site/Cta";
import { formatMoney, pricingConfig } from "@/lib/pricing";
import { SITE_ROUTES } from "@/lib/site/routes";

/** The closing price strip, on Ink. The price is set large; the terms are one plain sentence. */
export function PricingSummary({ ctaLabel, terms }: { ctaLabel: string; terms: string }) {
  const pricing = pricingConfig();
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-8">
      <div className="max-w-[46ch]">
        <p className="flex flex-wrap items-baseline gap-x-4">
          <span className="font-display text-[3.8125rem] font-extrabold leading-none tracking-[-0.04em] [font-variant-numeric:tabular-nums]">
            {formatMoney(pricing.pricePerNumber, pricing.currency)}
          </span>
          <span className="text-xl">per WhatsApp number, per month</span>
        </p>
        <p className="mt-4 text-ink-dim">{terms}</p>
      </div>
      <div>
        <Cta label={ctaLabel} />
        <p className="mt-2">
          <Link href={SITE_ROUTES.pricing} className="inline-flex min-h-11 items-center text-accent-text underline underline-offset-2">
            See the full pricing
          </Link>
        </p>
      </div>
    </div>
  );
}
