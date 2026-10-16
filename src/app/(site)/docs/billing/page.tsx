import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { brandConfig } from "@/lib/brand-config";
import { pricingConfig, tierSentence } from "@/lib/pricing";
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
  const pricing = pricingConfig();
  const copy = pricingCopy();
  const h2 = "mt-12 font-display text-[clamp(1.5rem,3vw,2.2rem)] font-extrabold leading-[1.05] tracking-[-0.02em] first:mt-0";
  return (
    <>
    <PageTop title="Billing">
      <p>{tierSentence(pricing.currency)} Billed per active number.</p>
    </PageTop>
    <section className="pb-12 pt-4 md:pb-20">
      <Container>
        <div className="max-w-[760px]">
          <h2 className={h2}>The free trial</h2>
          {copy.trialTerms.map((t) => (
            <p key={t} className="mt-3 max-w-[62ch] text-ink-dim">{t}</p>
          ))}

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
    </>
  );
}
