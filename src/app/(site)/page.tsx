import type { Metadata } from "next";
import { Container } from "@/components/site/Container";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { HowItWorks } from "@/components/site/HowItWorks";
import { PricingSummary } from "@/components/site/PricingSummary";
import { SafetyList } from "@/components/site/SafetyList";
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
const BAND = "bg-raised";

export default function HomePage() {
  const brand = brandConfig();
  const copy = salesCopy(brand);
  const note = `Card needed up front. ${TRIAL_MAX_NUMBERS} numbers on the ${TRIAL_DAYS}-day trial. Cancel any time.`;
  return (
    <>
      <section className="surface-dark pb-14 pt-12 md:pb-24 md:pt-20">
        <Container>
          <h1 className="max-w-[18ch] font-display text-[clamp(36px,7.5vw,68px)] font-extrabold leading-[1.04]">
            {copy.hook.heading}
          </h1>
          <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">{copy.hook.sub}</p>
          <div className="mt-8">
            <Cta label={copy.ctaLabel} secondary={{ href: SITE_ROUTES.setup, label: "See the setup guide" }} note={note} />
          </div>
          <figure className="mt-12 rounded-lg border bg-well p-4">
            <svg viewBox="0 0 560 150" role="img" aria-label="Diagram: a workflow step sends a message through the connector to WhatsApp" className="block h-auto w-full">
              <g fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-faint">
                <rect x="8" y="40" width="150" height="70" rx="8" />
                <rect x="205" y="40" width="150" height="70" rx="8" className="text-accent" />
                <rect x="402" y="40" width="150" height="70" rx="8" />
                <path d="M158 75h47M355 75h47" />
                <path d="M196 69l9 6-9 6M393 69l9 6-9 6" />
              </g>
              <g fill="currentColor" fontSize="14" textAnchor="middle" className="text-ink-dim">
                <text x="83" y="70">Workflow step</text>
                <text x="83" y="90" fontSize="12">Send SMS</text>
                <text x="280" y="70">{brand.name}</text>
                <text x="280" y="90" fontSize="12">Paced, with daily cap</text>
                <text x="477" y="70">WhatsApp</text>
                <text x="477" y="90" fontSize="12">Linked device</text>
              </g>
            </svg>
            <figcaption className="mt-2 text-xs text-ink-dim">Schematic: your workflow, the connector, then WhatsApp.</figcaption>
          </figure>
        </Container>
      </section>

      <section id="how-it-works" className={`${SECTION} scroll-mt-4`}>
        <Container>
          <h2 className="font-display text-[clamp(24px,4vw,32px)] font-extrabold leading-[1.15]">Live in three steps</h2>
          <HowItWorks steps={copy.steps} />
        </Container>
      </section>

      <section className={`${SECTION} surface-dark`}>
        <Container>
          <h2 className="font-display text-[clamp(24px,4vw,32px)] font-extrabold leading-[1.15]">{copy.keepWorkflows.heading}</h2>
          <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">{copy.keepWorkflows.body}</p>
        </Container>
      </section>

      <section className={SECTION}>
        <Container>
          <h2 className="font-display text-[clamp(24px,4vw,32px)] font-extrabold leading-[1.15]">Built to be careful with your numbers</h2>
          <SafetyList items={copy.safety} />
        </Container>
      </section>

      <section id="faq" className={`${SECTION} ${BAND} scroll-mt-4`}>
        <Container>
          <h2 className="font-display text-[clamp(24px,4vw,32px)] font-extrabold leading-[1.15]">Straight answers</h2>
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
