import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";
import { CustomerResults } from "@/components/site/CustomerResults";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { HowItWorks } from "@/components/site/HowItWorks";
import { PricingSummary } from "@/components/site/PricingSummary";
import { ReminderResearch } from "@/components/site/ReminderResearch";
import { SafetyThread } from "@/components/site/SafetyThread";
import { ConnectPanelSample } from "@/components/site/samples/ConnectPanelSample";
import { DashboardSample } from "@/components/site/samples/DashboardSample";
import { SameReminderTwice } from "@/components/site/samples/SameReminderTwice";
import { brandConfig } from "@/lib/brand-config";
import { HOME_FAQ_IDS, faqEntries } from "@/lib/site/faq";
import { OWN_RESULTS_AVERAGE } from "@/lib/site/proof";
import { SITE_ROUTES } from "@/lib/site/routes";
import { salesCopy } from "@/lib/site/sales-copy";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `${name} — WhatsApp for GoHighLevel`,
    description: salesCopy(brandConfig()).heroSub,
  };
}

const SECTION = "py-16 md:py-28";
const H2 = "font-display text-[1.9375rem] font-extrabold leading-[1.1] tracking-[-0.03em] md:text-[2.4375rem]";
/** Section opener: the Wren rule is the section device, so every section starts with it. */
const RULE = "section-rule";
const SPLIT = "grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)] lg:gap-16";

function Sample({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure>
      {children}
      <figcaption className="mt-3 text-[0.9375rem] text-ink-faint">{caption}</figcaption>
    </figure>
  );
}

export default function HomePage() {
  const brand = brandConfig();
  const copy = salesCopy(brand);
  const result = OWN_RESULTS_AVERAGE;
  const home = faqEntries(brand).filter((e) => (HOME_FAQ_IDS as readonly string[]).includes(e.id));
  return (
    <>
      <section className="surface-dark pb-16 pt-12 md:pb-20 md:pt-14 lg:pb-16">
        <Container>
          <div className="grid items-start gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:gap-12">
            <div>
              <h1 className="font-display text-[2.4375rem] font-extrabold leading-[1.04] tracking-[-0.035em] lg:text-[3.25rem]">
                <span className="block">{result.headingLead}</span>{" "}
                <span className="mt-2 block">{result.headingTail}</span>{" "}
                <span className="block text-[3.5rem] leading-[0.95] tracking-[-0.04em] [font-variant-numeric:tabular-nums] md:text-[6rem]">
                  {result.after}
                </span>
              </h1>
              <p className="mt-3 text-[0.9375rem]">
                <a href="#own-result" aria-label="Our own average, footnote 1" className="inline-flex min-h-6 items-center text-accent-text underline underline-offset-2">
                  Our own average<sup aria-hidden="true" className="ml-0.5 text-xs font-bold">1</sup>
                </a>
              </p>
              <p className="mt-6 max-w-[44ch] text-[1.1875rem] leading-snug text-ink-dim md:text-[1.375rem]">{copy.heroSub}</p>
              <div className="mt-8">
                <Cta label={copy.ctaLabel} secondary={{ href: SITE_ROUTES.setup, label: "Read the setup guide" }} note={copy.ctaNote} />
              </div>
              <p id="own-result" className="mt-10 max-w-[48ch] scroll-mt-6 border-t-2 border-rule pt-4 text-sm text-ink-faint md:text-[0.9375rem]">
                <span aria-hidden="true">1 </span>
                {result.note}
              </p>
            </div>
            <SameReminderTwice />
          </div>
        </Container>
      </section>

      <section className={SECTION}>
        <Container>
          <div className={RULE}>
            <div className={SPLIT}>
              <h2 className={H2}>{copy.why.heading}</h2>
              <div className="grid gap-10 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] xl:gap-12">
                <div className="grid max-w-[62ch] gap-5 text-lg">
                  {copy.why.paragraphs.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
                <div className="border-t-2 border-rule pt-4 xl:border-l-2 xl:border-t-0 xl:pl-6 xl:pt-0">
                  <ReminderResearch />
                </div>
              </div>
            </div>
          </div>
        </Container>
      </section>

      <section id="how-it-works" className={`${SECTION} scroll-mt-4 pt-0 md:pt-0`}>
        <Container>
          <div className={RULE}>
            <h2 className={H2}>{copy.setup.heading}</h2>
            <p className="mt-4 max-w-[52ch] text-xl text-ink-dim">{copy.setup.lead}</p>
            <HowItWorks
              steps={copy.setup.steps}
              aside={
                <Sample caption={copy.setup.sampleCaption}>
                  <ConnectPanelSample />
                </Sample>
              }
            />
          </div>
        </Container>
      </section>

      <section className={`${SECTION} bg-raised`}>
        <Container>
          <div className={RULE}>
            <div className={SPLIT}>
              <div>
                <h2 className={H2}>{copy.afterwards.heading}</h2>
                <p className="mt-5 max-w-[46ch] text-lg">{copy.afterwards.body}</p>
              </div>
              <Sample caption={copy.afterwards.caption}>
                <DashboardSample />
              </Sample>
            </div>
          </div>
        </Container>
      </section>

      <CustomerResults headingClass={H2} />

      <section className={SECTION}>
        <Container>
          <div className={RULE}>
            <h2 className={H2}>{copy.safetyHeading}</h2>
            <p className="mt-4 max-w-[52ch] text-xl text-ink-dim">{copy.safetyIntro}</p>
            <SafetyThread items={copy.safety} />
          </div>
        </Container>
      </section>

      <section className={`${SECTION} pt-0 md:pt-0`}>
        <Container>
          <div className={RULE}>
            <div className={SPLIT}>
              <h2 className={H2}>{copy.disclosure.heading}</h2>
              <div className="grid max-w-[62ch] gap-5 text-lg">
                {copy.disclosure.paragraphs.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            </div>
          </div>
        </Container>
      </section>

      <section id="faq" className={`${SECTION} pt-0 scroll-mt-4 md:pt-0`}>
        <Container>
          <div className={RULE}>
            <div className={SPLIT}>
              <div>
                <h2 className={H2}>{copy.faqHeading}</h2>
                <p className="mt-5">
                  <Link href={SITE_ROUTES.faq} className="inline-flex min-h-11 items-center text-accent-text underline underline-offset-2">
                    {copy.faqAllLink}
                  </Link>
                </p>
              </div>
              <div className="lg:-mt-6">
                <FaqList entries={home} />
              </div>
            </div>
          </div>
        </Container>
      </section>

      <section className="surface-dark py-14 md:py-20">
        <Container>
          <PricingSummary ctaLabel={copy.ctaLabel} terms={copy.priceStrip.terms} />
        </Container>
      </section>
    </>
  );
}
