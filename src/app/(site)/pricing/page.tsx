import type { Metadata } from "next";
import { Container } from "@/components/site/Container";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { IncludedList } from "@/components/site/IncludedList";
import { PricingCalculator } from "@/components/site/PricingCalculator";
import { ResaleCalculator } from "@/components/site/ResaleCalculator";
import { PricingTable } from "@/components/site/PricingTable";
import { TierList } from "@/components/site/TierList";
import { brandConfig } from "@/lib/brand-config";
import { pricingConfig, standardPrice, tierSentence } from "@/lib/pricing";
import { COMPARISON, ourColumn, sourceParts } from "@/lib/site/comparison";
import { faqEntries } from "@/lib/site/faq";
import { pricingCopy } from "@/lib/site/pricing-copy";
import { resaleExamplePrice, resaleFallbackLine } from "@/lib/site/resale";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Pricing — ${name}`,
    description: `${tierSentence(pricingConfig().currency)} 7-day free trial, cancel any time.`,
  };
}

const BILLING_FAQ = ["trial", "cancel", "ban-risk", "official-api", "disconnected"];

const H2 = "h-page font-display";
const H3 = "h-item font-display";
const LI = "border-t-2 border-rule py-3.5";
const PROSE = "max-w-[62ch]";

export default function PricingPage() {
  const brand = brandConfig();
  const pricing = pricingConfig();
  const price = standardPrice(pricing.currency);
  const copy = pricingCopy();
  const all = faqEntries(brand);
  const faq = BILLING_FAQ.flatMap((id) => all.filter((e) => e.id === id));
  return (
    <div>
      <section className="surface-dark pb-[clamp(48px,6vw,80px)] pt-10 md:pt-14">
        <Container>
          <h1 className="h-hero">
            <span className="num-display block">{price}</span>{" "}
            <span className="h-section mt-2 block">
              per WhatsApp number, per month
            </span>
          </h1>
          <p className={`${PROSE} mt-8 text-[1.3rem] font-medium leading-[1.4]`}>
            {tierSentence(pricing.currency)} There is no setup fee, and {brand.name} does not charge per message.
          </p>
        </Container>
      </section>

      <section className="band">
        <Container>
          <div className="slab slab-lift p-[clamp(24px,5vw,48px)]">
            <PricingCalculator currency={pricing.currency} />
            <div className="mt-8">
              <TierList currency={pricing.currency} />
            </div>
            <div className="mt-6">
              <PricingTable pricing={pricing} />
            </div>
            <div className="mt-10">
              <IncludedList brand={brand} />
            </div>
          </div>
        </Container>
      </section>

      <section id="resale" className="surface-coral band scroll-mt-4">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
            <div>
              <h2 className={H2}>Reselling to your clients?</h2>
              <p className="mt-6 max-w-[44ch] text-[1.2rem] leading-[1.45]">
                Many agencies include WhatsApp sending in a client package and charge for each number. {resaleExamplePrice(pricing.currency)} a number
                is a common price, so it is the starting figure here. Change it to whatever you charge.
              </p>
              <p className="mt-4 max-w-[44ch]">
                You set your own price. These figures are examples, not a promise of income, and they leave out your own costs and tax.
              </p>
            </div>
            <div>
              <ResaleCalculator currency={pricing.currency} />
              <p className="mt-8 max-w-[52ch] border-t-2 border-rule small pt-4 text-ink-dim">
                {resaleFallbackLine(pricing.currency)}
              </p>
            </div>
          </div>
        </Container>
      </section>

      <section className="band">
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

      <section className="band">
        <Container>
          <h2 className={H2}>{COMPARISON.heading}</h2>
          <p className={`${PROSE} mt-6`}>{COMPARISON.intro}</p>
          <div className="mt-10 grid gap-10 md:grid-cols-2 md:gap-0">
            <div className="md:pr-10">
              <h3 className={H3}>
                {brand.name}
              </h3>
              <ul role="list" className="mt-4">
                {ourColumn(pricing.currency).map((t) => (
                  <li key={t} className={LI}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="md:border-l-[3px] md:border-outline md:pl-10">
              <h3 className={H3}>
                {COMPARISON.nativeHeading}
              </h3>
              <ul role="list" className="mt-4">
                {COMPARISON.native.map((t) => (
                  <li key={t} className={LI}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className={`${PROSE} small mt-10 text-ink-dim`}>
            {sourceParts().map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <a key={i} href={part.href} rel="noopener" className="font-semibold text-ink underline underline-offset-2">
                  {part.text}
                </a>
              ),
            )}
          </p>
          <p className={`${PROSE} mt-6`}>{COMPARISON.closing}</p>
        </Container>
      </section>

      <section className="band bg-raised">
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
