import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { CustomerResults } from "@/components/site/CustomerResults";
import { Cta } from "@/components/site/Cta";
import { FaqList } from "@/components/site/FaqList";
import { FeatureList } from "@/components/site/FeatureList";
import { HowItWorks } from "@/components/site/HowItWorks";
import { PricingSummary } from "@/components/site/PricingSummary";
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

const H2 = "h-page font-display";
const BAND = "band";
const GAP = "gap-[clamp(24px,5vw,80px)]";

export default function HomePage() {
  const brand = brandConfig();
  const copy = salesCopy(brand);
  const result = OWN_RESULTS_AVERAGE;
  const home = faqEntries(brand).filter((e) => (HOME_FAQ_IDS as readonly string[]).includes(e.id));
  return (
    <>
      <section className="surface-dark pb-0">
        <Container>
          <div className="hero-grid">
            <div>
              <h1 className="h-hero font-display max-w-[19ch]">{copy.heroH1}</h1>
              <p className="mt-7 max-w-[48ch] text-[clamp(1.1rem,1.6vw,1.3rem)] font-medium leading-[1.45]">{copy.heroSub}</p>
              <div className="mt-7">
                <Cta ground="dark" label={copy.ctaLabel} secondary={{ href: "#features", label: "See everything it does" }} note={copy.ctaNote} />
              </div>
              <p className="hero-result mt-9 max-w-[34rem] text-lg font-medium leading-[1.5]">
                About <span className="num-display font-display !text-[clamp(2.2rem,4vw,3.25rem)]">{result.before}</span>{" "}
                {result.resultLead}{" "}
                <span className="num-display font-display !text-[clamp(2.2rem,4vw,3.25rem)]">{result.after}</span>{" "}
                <a href="#own-result" aria-label="Our own average, footnote 1" className="small inline-flex min-h-6 items-center align-baseline font-semibold underline underline-offset-2">
                  Our own average<sup aria-hidden="true" className="ml-0.5 text-xs font-bold">1</sup>
                </a>
              </p>
            </div>
            <div className="relative z-[3] max-[900px]:mt-6">
              <SameReminderTwice />
            </div>
          </div>
        </Container>
      </section>

      <FeatureList brand={brand} />

      <section id="how-it-works" className={`surface-coral ${BAND} scroll-mt-4`}>
        <Container>
          <h2 className={`${H2} max-w-[14ch]`}>{copy.setup.heading}</h2>
          <p className="mt-4 max-w-[52ch] text-xl text-ink-dim">{copy.setup.lead}</p>
          <HowItWorks steps={copy.setup.steps} />
        </Container>
      </section>

      <CustomerResults headingClass={H2} />

      <section className={BAND}>
        <Container>
          <div className="slab slab-lift grid gap-[clamp(24px,4vw,64px)] p-[clamp(24px,5vw,56px)] min-[901px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <h2 className={`${H2} max-w-[11ch]`}>{copy.disclosure.heading}</h2>
            <div className="grid gap-[18px]">
              {copy.disclosure.paragraphs.map((p) => (
                <p key={p} className="max-w-[58ch]">
                  {p}
                </p>
              ))}
              <p id="own-result" className="max-w-[58ch] scroll-mt-6 small border-t-2 border-rule pt-4">
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

      <section className="surface-coral band-tight">
        <Container>
          <PricingSummary ctaLabel={copy.ctaLabel} terms={copy.priceStrip.terms} />
        </Container>
      </section>
    </>
  );
}
