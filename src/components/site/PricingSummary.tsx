import Link from "next/link";
import { siteButton } from "@/components/site/button";
import { SITE_ROUTES } from "@/lib/site/routes";
import { formatMoney, pricingConfig } from "@/lib/pricing";

/** The closing price strip, on the coral ground: the price as the headline, one plain terms line, an Ink pill. */
export function PricingSummary({ ctaLabel, terms }: { ctaLabel: string; terms: string }) {
  const pricing = pricingConfig();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-12 gap-y-8">
      <div>
        <h2 className="price-h2 font-display font-extrabold">
          {formatMoney(pricing.pricePerNumber, pricing.currency)} per WhatsApp number, per month
        </h2>
        <p className="mt-3.5 max-w-[52ch] font-medium">{terms}</p>
      </div>
      <div className="btn-stack flex-col items-start sm:items-end">
        <Link href={SITE_ROUTES.signup} className={siteButton("ink")}>
          {ctaLabel}
        </Link>
        <Link href={SITE_ROUTES.pricing} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
          See the full pricing
        </Link>
      </div>
    </div>
  );
}
