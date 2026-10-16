# Routes
Next.js App Router, file-based (no router config). Marketing routes live in group `src/app/(site)/` and share `(site)/layout.tsx` under root layout. Route constants: `src/lib/site/routes.ts`.

### `src/lib/site/routes.ts`
Route constants + nav links

```ts
export const SITE_ROUTES = {
  home: "/",
  pricing: "/pricing",
  docs: "/docs",
  setup: "/docs/setup",
  faq: "/docs/faq",
  billingHelp: "/docs/billing",
  privacySummary: "/docs/privacy-and-data",
  terms: "/legal/terms",
  privacy: "/legal/privacy",
  signup: "/signup",
  login: "/login",
  dashboard: "/dashboard",
  billing: "/dashboard/billing",
} as const;

/** The sitemap set: pages a search engine should index. */
export const PUBLIC_ROUTES: readonly string[] = [
  SITE_ROUTES.home,
  SITE_ROUTES.pricing,
  SITE_ROUTES.docs,
  SITE_ROUTES.setup,
  SITE_ROUTES.faq,
  SITE_ROUTES.billingHelp,
  SITE_ROUTES.privacySummary,
  SITE_ROUTES.terms,
  SITE_ROUTES.privacy,
];

/** Account and auth screens: disallowed in robots.txt, never in the sitemap. */
export const NOINDEX_ROUTES: readonly string[] = [
  SITE_ROUTES.signup,
  SITE_ROUTES.login,
  SITE_ROUTES.dashboard,
  SITE_ROUTES.billing,
];

export const NAV_LINKS: readonly { href: string; label: string }[] = [
  { href: SITE_ROUTES.pricing, label: "Pricing" },
  { href: SITE_ROUTES.setup, label: "Setup guide" },
  { href: SITE_ROUTES.docs, label: "Docs" },
];
```

## Marketing routes (layout: root -> (site)/layout.tsx)
| URL | File | Notes |
| --- | --- | --- |
| `/` | `src/app/(site)/page.tsx` | Home: hero with animated WhatsApp bubble, SameReminderTwice, HowItWorks, ReminderResearch, SafetyThread, ConnectPanel/Dashboard samples, CustomerResults, PricingSummary, FAQ, Cta |
| `/pricing` | `src/app/(site)/pricing/page.tsx` | PricingTable, PricingCalculator, comparison table, FAQ, Cta |
| `/docs` | `src/app/(site)/docs/page.tsx` | Docs index (+ docs/layout.tsx) |
| `/docs/setup` | `src/app/(site)/docs/setup/page.tsx` | Setup guide: AudienceTabs, SetupStep + diagrams, troubleshooting |
| `/docs/faq`, `/docs/billing`, `/docs/privacy-and-data` | `src/app/(site)/docs/<x>/page.tsx` | Docs prose pages |
| `/legal/terms`, `/legal/privacy` | `src/app/(site)/legal/<x>/page.tsx` | Legal (legal/layout.tsx) |
| `/signup`, `/signup/checkout` | `src/app/(site)/signup/...` | Signup flow |
| not-found | `src/app/(site)/not-found.tsx`, `src/app/not-found.tsx` | 404 |

## Non-marketing (out of design focus)
`/login`, `/admin`, `(app)/dashboard` + `/dashboard/billing` (layout `(app)/layout.tsx`), `/connect/[token]`, `/embed/crm`, `/api/*` route handlers, `robots.ts`.

### `src/app/(site)/page.tsx`
Focus page source

```tsx
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
```

### `src/app/(site)/pricing/page.tsx`
Focus page source

```tsx
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
```

### `src/app/(site)/docs/setup/page.tsx`
Focus page source

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { AudienceTabs } from "@/components/site/AudienceTabs";
import { Container } from "@/components/site/Container";
import { ConnectPanelSample } from "@/components/site/samples/ConnectPanelSample";
import { SetupStep } from "@/components/site/SetupStep";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";
import { AUDIENCES, AUDIENCE_LABELS, setupSteps, troubleshooting, type Audience } from "@/lib/site/setup-steps";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Setting up ${name} in GoHighLevel`,
    description: `Step-by-step setup for ${name}: install, set the Telephony Provider, scan the QR code and send a test message. About ten minutes.`,
  };
}

function withSupportLink(text: string, email: string | null): ReactNode {
  const marker = "get in touch";
  const i = text.indexOf(marker);
  if (!email || i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <a href={`mailto:${email}`} className="underline underline-offset-2">
        {marker}
      </a>
      {text.slice(i + marker.length)}
    </>
  );
}

function parseAudience(value: string | string[] | undefined): Audience {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "business" ? "business" : "agency";
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const brand = brandConfig();
  const initial = parseAudience((await searchParams).audience);
  const steps = setupSteps(brand);
  const trouble = troubleshooting(brand);

  const panels = Object.fromEntries(
    AUDIENCES.map((a) => [
      a,
      <div key={a}>
        <h2 className="font-display text-[clamp(24px,4vw,32px)] font-extrabold leading-tight">{AUDIENCE_LABELS[a]}</h2>
        <ol role="list" className="mt-4 list-none p-0">
          {steps.map((s, i) => (
            <SetupStep key={s.id} index={i} step={s} audience={a} brandName={brand.name} />
          ))}
        </ol>
      </div>,
    ]),
  ) as Record<Audience, ReactNode>;

  return (
    <>
      <section className="pb-12 pt-12 md:pb-20">
        <Container>
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
            <div>
              <h1 className="font-display text-[clamp(32px,6vw,48px)] font-extrabold leading-[1.1] tracking-[-0.03em]">
                Setting up {brand.name} in GoHighLevel
              </h1>
              <p className="mt-5 max-w-[52ch] text-xl leading-snug text-ink-dim">
                About ten minutes, start to finish. Pick the guide that matches your account, and by the end the workflows
                you already have will be sending on WhatsApp.
              </p>
              <div className="section-rule mt-10 max-w-[52ch]">
                <h2 className="font-display text-[1.5625rem] font-medium leading-tight tracking-[-0.015em]">Before you start</h2>
                <ul className="mt-3 grid list-disc gap-2 pl-5 marker:text-ink-faint">
                  <li>A GoHighLevel account with at least one sub-account.</li>
                  <li>A {brand.name} account. The free trial is fine.</li>
                  <li>The phone with the WhatsApp number you&apos;ll send from. You need it in your hand for the scan.</li>
                  <li>A second phone to receive the test message.</li>
                </ul>
              </div>
            </div>
            <figure>
              <ConnectPanelSample connectedStrip />
              <figcaption className="mt-3 text-[0.9375rem] text-ink-faint">
                Sample screen: the connect page you&apos;ll see in step 4, before and after the scan.
              </figcaption>
            </figure>
          </div>
          <div className="max-w-[760px]">
            <div className="mt-8">
              <AudienceTabs key={initial} panels={panels} initial={initial} />
            </div>

            <h2 id="troubleshooting" className="mt-16 scroll-mt-4 font-display text-[clamp(24px,4vw,32px)] font-extrabold">
              Troubleshooting
            </h2>
            <div className="mt-4">
              {trouble.map((t) => (
                <details key={t.id} id={t.id} className="group scroll-mt-4 border-b border-divider">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
                    <span>{t.title}</span>
                    <span aria-hidden="true" className="text-accent-text group-open:hidden">
                      +
                    </span>
                    <span aria-hidden="true" className="hidden text-accent-text group-open:inline">
                      &minus;
                    </span>
                  </summary>
                  <div className="grid max-w-[62ch] gap-3 pb-4 text-ink-dim">
                    {t.body.map((p) => (
                      <p key={p}>{withSupportLink(p, brand.supportEmail)}</p>
                    ))}
                  </div>
                </details>
              ))}
            </div>

            <h2 className="mt-16 font-display text-[clamp(24px,4vw,32px)] font-extrabold">Once you are sending</h2>
            <ul className="mt-4 grid max-w-[62ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink-faint">
              <li>Each number has a daily cap, and messages go out at a steady pace rather than all at once.</li>
              <li>If someone replies STOP, that number stops messaging them. Other numbers are not affected.</li>
              <li>The phone needs to stay switched on and online.</li>
            </ul>
            <p className="mt-4 max-w-[62ch] text-ink-dim">
              More answers are in the{" "}
              <Link href={SITE_ROUTES.faq} className="underline underline-offset-2">
                FAQ
              </Link>
              .
            </p>
          </div>
        </Container>
      </section>
    </>
  );
}
```
