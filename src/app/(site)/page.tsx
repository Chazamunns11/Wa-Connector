import type { Metadata } from "next";
import { Container } from "@/components/site/Container";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { HeroWorkflow } from "@/components/site/HeroWorkflow";
import { HowItWorks } from "@/components/site/HowItWorks";
import { PricingSummary } from "@/components/site/PricingSummary";
import { SafetyThread } from "@/components/site/SafetyThread";
import { brandConfig } from "@/lib/brand-config";
import { faqEntries } from "@/lib/site/faq";
import { SITE_ROUTES } from "@/lib/site/routes";
import { salesCopy } from "@/lib/site/sales-copy";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS } from "@/lib/pricing";

export function generateMetadata(): Metadata {
  const { name, tagline } = brandConfig();
  return {
    title: `${name} — ${tagline}`,
    description: salesCopy(brandConfig()).hook.sub,
  };
}

const SECTION = "py-12 md:py-20";
const H2 = "font-display text-[1.9375rem] font-extrabold leading-[1.12] tracking-[-0.03em] md:text-[2.4375rem]";
const BAND = "bg-raised";

export default function HomePage() {
  const brand = brandConfig();
  const copy = salesCopy(brand);
  const note = `Card needed up front. ${TRIAL_MAX_NUMBERS} numbers on the ${TRIAL_DAYS}-day trial. Cancel any time.`;
  return (
    <>
      <section className="surface-dark pb-14 pt-12 md:pb-24 md:pt-20">
        <Container>
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
            <div>
              <h1 className="max-w-[20ch] font-display text-[2.4375rem] font-extrabold leading-[1.08] tracking-[-0.035em] md:text-[3.0625rem]">
                {copy.hook.heading}
              </h1>
              <p className="mt-5 max-w-[56ch] text-xl leading-snug text-ink-dim">{copy.hook.sub}</p>
              <div className="mt-8">
                <Cta label={copy.ctaLabel} secondary={{ href: SITE_ROUTES.setup, label: "See the setup guide" }} note={note} />
              </div>
            </div>
            <HeroWorkflow />
          </div>
        </Container>
      </section>

      <section id="how-it-works" className={`${SECTION} scroll-mt-4`}>
        <Container>
          <h2 className={H2}>Live in three steps</h2>
          <HowItWorks steps={copy.steps} />
        </Container>
      </section>

      <section className={`${SECTION} surface-dark`}>
        <Container>
          <h2 className={H2}>{copy.keepWorkflows.heading}</h2>
          <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">{copy.keepWorkflows.body}</p>
        </Container>
      </section>

      <section className={SECTION}>
        <Container>
          <h2 className={H2}>Built to be careful with your numbers</h2>
          <SafetyThread items={copy.safety} />
        </Container>
      </section>

      <section id="faq" className={`${SECTION} ${BAND} scroll-mt-4`}>
        <Container>
          <h2 className={H2}>Straight answers</h2>
          <FaqList entries={faqEntries(brand)} />
        </Container>
      </section>

      <section className={SECTION}>
        <Container>
          <PricingSummary ctaLabel={copy.ctaLabel} />
        </Container>
      </section>
    </>
  );
}
