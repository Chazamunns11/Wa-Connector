import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { formatMoney, pricingConfig } from "@/lib/pricing";
import { pricingCopy } from "@/lib/site/pricing-copy";
import { SITE_ROUTES } from "@/lib/site/routes";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Billing | ${name}`,
    description: `How the ${name} free trial, monthly billing, failed payments and cancelling work.`,
  };
}

export default function BillingHelpPage() {
  const brand = brandConfig();
  const pricing = pricingConfig();
  const copy = pricingCopy(brand);
  const h2 = "mt-10 font-display text-[clamp(20px,3vw,24px)] font-bold";
  return (
    <section className="pb-12 pt-12 md:pb-20">
      <Container>
        <div className="max-w-[760px]">
          <h1 className="font-display text-[clamp(32px,6vw,48px)] font-bold leading-[1.15]">Billing</h1>
          <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">
            One price: {formatMoney(pricing.pricePerNumber, pricing.currency)} per active number, per month.
          </p>

          <h2 className={h2}>The free trial</h2>
          <ul className="mt-3 grid max-w-[62ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink-faint">
            {copy.trialTerms.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>

          <h2 className={h2}>If a payment fails</h2>
          <div className="mt-3 grid max-w-[62ch] gap-3 text-ink-dim">
            {copy.failedPayment.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>

          <h2 className={h2}>Changing your card or cancelling</h2>
          <p className="mt-3 max-w-[62ch] text-ink-dim">{copy.cancel}</p>
          <p className="mt-3 max-w-[62ch] text-ink-dim">
            Changing your card and cancelling are both done in the billing portal, which is available once your account
            is live. Until then, the{" "}
            <Link href={SITE_ROUTES.pricing} className="underline underline-offset-2">
              pricing page
            </Link>{" "}
            has the trial and billing terms.
          </p>
        </div>
      </Container>
    </section>
  );
}
