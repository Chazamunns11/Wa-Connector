import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";
import { CustomerResults } from "@/components/site/CustomerResults";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { HowItWorks } from "@/components/site/HowItWorks";
import { PricingSummary } from "@/components/site/PricingSummary";
import { SafetyThread } from "@/components/site/SafetyThread";
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

const H2 = "h2-b font-display font-extrabold";
const BAND = "band";
const GAP = "gap-[clamp(24px,5vw,80px)]";

function Sample({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="m-0">
      {children}
      <figcaption className="mt-3 text-[0.95rem] font-medium">{caption}</figcaption>
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
      <section className="surface-coral pb-0">
        <Container>
          <div className="hero-grid">
            <div>
              <h1 className="hero-h1 font-display font-extrabold">
                {result.headingLead} {result.headingTail} <span className="hero-big">{result.after}</span>
              </h1>
              <p className="mt-1.5 text-[0.95rem] font-semibold">
                <a href="#own-result" aria-label="Our own average, footnote 1" className="inline-flex min-h-6 items-center underline underline-offset-2">
                  Our own average<sup aria-hidden="true" className="ml-0.5 text-xs font-bold">1</sup>
                </a>
              </p>
              <p className="mt-7 max-w-[46ch] text-[clamp(1.1rem,1.6vw,1.3rem)] font-medium leading-[1.45]">{copy.heroSub}</p>
              <div className="mt-7">
                <Cta onCoral label={copy.ctaLabel} secondary={{ href: SITE_ROUTES.setup, label: "Read the setup guide" }} note={copy.ctaNote} />
              </div>
            </div>
            <div className="relative z-[3] max-[900px]:mt-6">
              <SameReminderTwice />
            </div>
          </div>
        </Container>
      </section>

      <section id="how-it-works" className={`hang-pad surface-dark ${BAND} scroll-mt-4`}>
        <Container>
          <h2 className={`${H2} max-w-[14ch]`}>{copy.setup.heading}</h2>
          <p className="mt-4 max-w-[52ch] text-xl text-ink-dim">{copy.setup.lead}</p>
          <HowItWorks steps={copy.setup.steps} />
        </Container>
      </section>

      <section className={BAND}>
        <Container>
          <div className="flex flex-wrap items-end justify-between gap-6">
            <h2 className={`${H2} max-w-[12ch]`}>{copy.afterwards.heading}</h2>
            <p className="max-w-[40ch]">{copy.afterwards.body}</p>
          </div>
          <div className="mt-10">
            <Sample caption={copy.afterwards.caption}>
              <DashboardSample />
            </Sample>
          </div>
        </Container>
      </section>

      <CustomerResults headingClass={H2} />

      <section className={`surface-coral ${BAND}`}>
        <Container>
          <div className={`grid ${GAP} min-[901px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]`}>
            <h2 className={`${H2} max-w-[10ch]`}>{copy.safetyHeading}</h2>
            <SafetyThread items={copy.safety} />
          </div>
        </Container>
      </section>

      <section className={BAND}>
        <Container>
          <div className="slab slab-lift grid gap-[clamp(24px,4vw,64px)] p-[clamp(24px,5vw,56px)] min-[901px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <h2 className="font-display text-[clamp(1.9rem,4vw,3rem)] font-extrabold leading-[0.98] tracking-[-0.025em] max-w-[11ch]">{copy.disclosure.heading}</h2>
            <div className="grid gap-[18px]">
              {copy.disclosure.paragraphs.map((p) => (
                <p key={p} className="max-w-[58ch]">
                  {p}
                </p>
              ))}
              <p id="own-result" className="max-w-[58ch] scroll-mt-6 border-t-2 border-rule pt-4 text-[0.95rem]">
                <span aria-hidden="true">1 </span>
                {result.note}
              </p>
            </div>
          </div>
        </Container>
      </section>

      <section id="faq" className={`${BAND} scroll-mt-4 bg-raised`}>
        <Container>
          <div className={`grid ${GAP} min-[901px]:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]`}>
            <div className="min-[901px]:sticky min-[901px]:top-6 min-[901px]:self-start">
              <h2 className={`${H2} max-w-[8ch]`}>{copy.faqHeading}</h2>
              <p className="mt-5">
                <Link href={SITE_ROUTES.faq} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
                  {copy.faqAllLink}
                </Link>
              </p>
            </div>
            <FaqList entries={home} />
          </div>
        </Container>
      </section>

      <section className="surface-coral py-[clamp(40px,6vw,72px)]">
        <Container>
          <PricingSummary ctaLabel={copy.ctaLabel} terms={copy.priceStrip.terms} />
        </Container>
      </section>
    </>
  );
}
