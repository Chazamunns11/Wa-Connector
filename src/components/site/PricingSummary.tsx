import Link from "next/link";
import { siteButton } from "@/components/site/button";
import { SITE_ROUTES } from "@/lib/site/routes";
import { VOLUME_FROM, pricingConfig, standardPrice, volumePrice } from "@/lib/pricing";

/** The closing price strip, on the coral ground: the price as the headline, one plain terms line, an Ink pill. */
export function PricingSummary({ ctaLabel, terms }: { ctaLabel: string; terms: string }) {
  const pricing = pricingConfig();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-12 gap-y-8">
      <div>
        <h2 className="price-h2 font-display font-extrabold">
          {standardPrice(pricing.currency)} a month per WhatsApp number
        </h2>
        <p className="mt-3.5 max-w-[52ch] text-[1.15rem] font-semibold">
          Connect {VOLUME_FROM} or more and every number drops to {volumePrice(pricing.currency)} a month.
        </p>
        <p className="mt-2 max-w-[52ch] font-medium">{terms}</p>
        <p className="mt-2 max-w-[52ch] font-medium">
          Reselling to clients?{" "}
          <Link href={`${SITE_ROUTES.pricing}#resale`} className="font-semibold underline underline-offset-2">
            See what you would keep
          </Link>
          .
        </p>
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
