import type { Metadata } from "next";
import { Container } from "@/components/site/Container";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { PricingCalculator } from "@/components/site/PricingCalculator";
import { PricingTable } from "@/components/site/PricingTable";
import { brandConfig } from "@/lib/brand-config";
import { formatMoney, priceLine, pricingConfig } from "@/lib/pricing";
import { COMPARISON, ourColumn, sourceParts } from "@/lib/site/comparison";
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

const H2 =
  "section-rule font-display text-[clamp(31px,4vw,39px)] font-extrabold leading-[1.1] tracking-[-0.03em]";
const SECTION = "pt-16 md:pt-28";
const PROSE = "max-w-[62ch]";

export default function PricingPage() {
  const brand = brandConfig();
  const pricing = pricingConfig();
  const price = formatMoney(pricing.pricePerNumber, pricing.currency);
  const copy = pricingCopy();
  const all = faqEntries(brand);
  const faq = BILLING_FAQ.flatMap((id) => all.filter((e) => e.id === id));
  return (
    <div className="pb-16 md:pb-28">
      <section className="pt-14 md:pt-20">
        <Container>
          <h1>
            <span className="block font-display text-[clamp(56px,10vw,96px)] font-extrabold leading-[0.95] tracking-[-0.04em] [font-variant-numeric:tabular-nums]">
              {price}
            </span>{" "}
            <span className="mt-2 block font-display text-[clamp(19px,2.4vw,22px)] font-medium leading-[1.4]">
              per WhatsApp number, per month
            </span>
          </h1>
          <p className={`${PROSE} mt-8 text-lg`}>
            There is no setup fee, and {brand.name} does not charge per message. The price is the same whether you
            connect one number or forty.
          </p>
          <div className="mt-10 bg-raised px-5 py-8 md:px-10 md:py-10">
            <PricingCalculator pricePerNumber={pricing.pricePerNumber} currency={pricing.currency} />
            <div className="mt-6">
              <PricingTable pricing={pricing} />
            </div>
          </div>
        </Container>
      </section>

      <section className={SECTION}>
        <Container>
          <h2 className={H2}>The trial, and what happens after</h2>
          <div className={`${PROSE} mt-6 grid gap-4`}>
            {copy.trialTerms.map((t) => (
              <p key={t}>{t}</p>
            ))}
            <p>{copy.cancel}</p>
            {copy.failedPayment.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </Container>
      </section>

      <section className={SECTION}>
        <Container>
          <h2 className={H2}>{COMPARISON.heading}</h2>
          <p className={`${PROSE} mt-6`}>{COMPARISON.intro}</p>
          <div className="mt-10 grid gap-10 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border-strong">
            <div className="md:pr-10">
              <h3 className="font-display text-[clamp(22px,2.4vw,25px)] font-medium leading-tight tracking-[-0.015em]">
                {brand.name}
              </h3>
              <ul role="list" className="mt-4 grid gap-4">
                {ourColumn(price).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="md:pl-10">
              <h3 className="font-display text-[clamp(22px,2.4vw,25px)] font-medium leading-tight tracking-[-0.015em]">
                {COMPARISON.nativeHeading}
              </h3>
              <ul role="list" className="mt-4 grid gap-4">
                {COMPARISON.native.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className={`${PROSE} mt-10 text-[15px] leading-[1.45] text-ink-faint`}>
            {sourceParts().map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <a key={i} href={part.href} rel="noopener" className="text-accent-text underline underline-offset-2">
                  {part.text}
                </a>
              ),
            )}
          </p>
          <p className={`${PROSE} mt-6`}>{COMPARISON.closing}</p>
        </Container>
      </section>

      <section className={SECTION}>
        <Container>
          <h2 className={H2}>Billing questions</h2>
          <FaqList entries={faq} />
          <div className="mt-12">
            <Cta label="Start 7-day free trial" />
          </div>
        </Container>
      </section>
    </div>
  );
}
