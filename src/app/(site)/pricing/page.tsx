import type { Metadata } from "next";
import { Card } from "@/components/ui/Card";
import { Container } from "@/components/site/Container";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { PricingCalculator } from "@/components/site/PricingCalculator";
import { PricingTable } from "@/components/site/PricingTable";
import { brandConfig } from "@/lib/brand-config";
import { priceLine, pricingConfig } from "@/lib/pricing";
import { faqEntries } from "@/lib/site/faq";
import { pricingCopy } from "@/lib/site/pricing-copy";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Pricing — ${name}`,
    description: `One price per WhatsApp number, per month: ${priceLine(1, pricingConfig())}. 7-day free trial, cancel any time.`,
  };
}

const BILLING_FAQ = ["trial", "cancel", "ban-risk", "official-api", "disconnected"];

export default function PricingPage() {
  const brand = brandConfig();
  const pricing = pricingConfig();
  const copy = pricingCopy(brand);
  const faq = faqEntries(brand).filter((e) => BILLING_FAQ.includes(e.id));
  return (
    <>
      <section className="pb-6 pt-14 md:pb-8">
        <Container>
          <h1 className="font-display text-[clamp(32px,6vw,48px)] font-bold leading-[1.15]">One price per number</h1>
          <p className="mt-4 font-display text-2xl font-semibold [font-variant-numeric:tabular-nums]">
            {priceLine(1, pricing)}
          </p>
          <p className="mt-3 max-w-[60ch] text-lg text-ink-dim">
            Pay for the WhatsApp numbers you connect. No setup fee and no per-message charge from {brand.name}.
          </p>
          <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="grid content-start gap-4">
              <Card>
                <PricingCalculator
                  pricePerNumber={pricing.pricePerNumber}
                  currency={pricing.currency}
                  brandName={brand.name}
                />
              </Card>
              <Card>
                <PricingTable pricing={pricing} />
              </Card>
            </div>
            <aside aria-labelledby="terms">
            <Card>
              <h2 id="terms" className="font-display text-2xl font-bold">Trial and billing</h2>
              <ul className="mt-4 grid gap-3">
                {copy.trialTerms.map((t) => (
                  <li key={t} className="relative pl-7">
                    <span aria-hidden="true" className="absolute left-1 top-[7px] h-3 w-2 rotate-45 border-b-2 border-r-2 border-accent-text" />
                    {t}
                  </li>
                ))}
              </ul>
              <h3 className="mt-6 font-display text-lg font-semibold">Cancelling</h3>
              <p className="mt-2 text-ink-dim">{copy.cancel}</p>
              <h3 className="mt-6 font-display text-lg font-semibold">If a payment fails</h3>
              {copy.failedPayment.map((p) => (
                <p key={p} className="mt-2 text-ink-dim">{p}</p>
              ))}
              <div className="mt-6">
                <Cta label="Start 7-day free trial" />
              </div>
            </Card>
            </aside>
          </div>
        </Container>
      </section>
      <section className="py-12 md:py-20">
        <Container>
          <h2 className="font-display text-[clamp(24px,4vw,32px)] font-bold leading-[1.15]">Billing questions</h2>
          <FaqList entries={faq} />
        </Container>
      </section>
    </>
  );
}
