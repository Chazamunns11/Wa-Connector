# Shared components
Stack: Next.js 16.2 (App Router), React 19, Tailwind v4 (CSS-first, no tailwind.config), custom components (no shadcn/MUI). Alias `@/` = `src/`. Primitives in `src/components/ui/`; marketing sections in `src/components/site/`. Diagram SVG components (`site/diagram-parts.tsx`, `site/diagrams/*`) are omitted here (setup-guide illustrations; read on demand). Layout pieces (SiteHeader, SiteFooter, BrandMark, Container) live in layouts.md.

## UI primitives

### `src/components/ui/Button.tsx`
Button classes helper + Button

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink hover:brightness-105 active:brightness-95",
  secondary:
    "border border-border-strong bg-transparent text-ink hover:bg-raised",
  ghost: "bg-transparent text-ink-dim hover:text-ink hover:bg-raised",
  danger: "bg-loss-soft text-loss border border-loss/30 hover:bg-loss/20",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-[34px] px-3.5 text-[13px]",
  md: "h-[38px] px-4 text-sm",
};

/**
 * The button's own class string, exported (W9, Charlie 30 Jul 2026) for the
 * handful of places that must render an ANCHOR rather than a `<button>` — a
 * link that leaves our origin, like the Google OAuth start URL, cannot be a
 * `<button>` without a pointless client-side hop.
 *
 * Deliberately a class helper rather than an `as="a"` polymorphic prop on
 * `Button` itself: this primitive is used in ~80 places, and widening its
 * prop types to be element-generic is a large blast radius for a two-link
 * problem. A shared class builder keeps the styling in exactly one place,
 * which is the part that would otherwise drift.
 */
export function buttonClasses(variant: Variant = "primary", size: Size = "md", className = ""): string {
  return `inline-flex items-center justify-center gap-2 rounded font-semibold transition-[color,background-color,border-color,filter,transform] duration-[120ms] active:scale-[.975] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button className={buttonClasses(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
```

### `src/components/ui/Card.tsx`
Card surface

```tsx
import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
}

/** Base panel: 8px radius, hairline border, no shadow. White on Cream, a lifted slate on Ink. */
export function Card({
  children,
  padded = true,
  className = "",
  ...rest
}: CardProps) {
  return (
    <div
      className={`rounded-lg border bg-card ${
        padded ? "p-6" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h3 className="font-display text-lg font-medium text-ink">
          {title}
        </h3>
        {subtitle ? (
          <p className="mt-1.5 text-sm text-ink-faint">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
```

### `src/components/ui/Chip.tsx`
Status chip/tone pill

```tsx
import type { ReactNode } from "react";

export type ChipTone = "win" | "loss" | "warn" | "info" | "accent" | "muted";

const TONE_CLASSES: Record<ChipTone, string> = {
  win: "bg-win-soft text-win border-win/30",
  loss: "bg-loss-soft text-loss border-loss/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  info: "bg-info-soft text-info border-info/30",
  accent: "bg-accent-soft text-accent-text border-accent-text/40",
  muted: "bg-raised text-ink-faint border-border",
};

/** Generic pill for enums that aren't `CallStatus` (payment/match/commission status). `title` is a plain tooltip (e.g. a rule label). */
export function Chip({ tone, title, children }: { tone: ChipTone; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
```

### `src/components/ui/EmptyState.tsx`
Empty-state block

```tsx
import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

/** Shown wherever a data-layer read returns zero rows (demo shell, empty filters, etc). */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: EmptyStateProps) {
  // Empty states are type and rules — hairlines above and below, no box, no
  // illustration; a slanted teal tick carries the brand instead of an icon
  // bubble.
  return (
    <div className="flex flex-col items-center justify-center gap-3 border-y border-divider px-6 py-16 text-center">
      {icon ? (
        <div className="text-ink-faint">{icon}</div>
      ) : (
        <span aria-hidden className="h-3.5 w-[3px] -skew-x-[11deg] bg-accent" />
      )}
      <h3 className="font-display text-base font-extrabold text-ink">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm text-ink-faint">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
```

## Marketing sections

### `src/components/site/Cta.tsx`
Closing call-to-action band

```tsx
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { SITE_ROUTES } from "@/lib/site/routes";

/** Primary trial link, plus an optional secondary link. One primary CTA per view. */
export function Cta({
  label,
  secondary,
  note,
}: {
  label: string;
  secondary?: { href: string; label: string };
  note?: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <Link href={SITE_ROUTES.signup} className={buttonClasses("primary", "md", "min-h-11 px-5 text-base")}>
          {label}
        </Link>
        {secondary ? (
          <Link href={secondary.href} className={buttonClasses("secondary", "md", "min-h-11 px-5 text-base")}>
            {secondary.label}
          </Link>
        ) : null}
      </div>
      {note ? <p className="mt-3 text-sm text-ink-dim">{note}</p> : null}
    </div>
  );
}
```

### `src/components/site/FaqList.tsx`
Accordion FAQ list

```tsx
import type { FaqEntry } from "@/lib/site/faq";

/** Native disclosure per entry: works without JavaScript and by keyboard. Ids are anchors. */
export function FaqList({ entries }: { entries: FaqEntry[] }) {
  return (
    <div className="mt-6 max-w-[760px]">
      {entries.map((e) => (
        <details key={e.id} id={e.id} className="group scroll-mt-4 border-b border-divider">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
            <span>{e.question}</span>
            <span aria-hidden="true" className="text-accent-text group-open:hidden">
              +
            </span>
            <span aria-hidden="true" className="hidden text-accent-text group-open:inline">
              &minus;
            </span>
          </summary>
          <p className="max-w-[62ch] pb-4 text-ink-dim">{e.answer}</p>
        </details>
      ))}
    </div>
  );
}
```

### `src/components/site/HowItWorks.tsx`
Home how-it-works steps

```tsx
import type { ReactNode } from "react";

/**
 * The three steps as a vertical timeline (a Wren line with the steps hanging
 * off it). From 1024px the connect sample sits beside the steps, so neither
 * side leaves a hole. Numbers stay because this really is a sequence.
 */
export function HowItWorks({ steps, aside }: { steps: { title: string; body: string }[]; aside?: ReactNode }) {
  return (
    <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:items-start lg:gap-16">
      <ol className="grid list-none p-0">
        {steps.map((s, i) => (
          <li key={s.title} className="relative border-l-2 border-rule pb-12 pl-8 last:pb-0">
            <span
              aria-hidden="true"
              className="absolute -left-[17px] top-0 flex h-8 w-8 items-center justify-center rounded bg-bg font-display text-lg font-extrabold ring-2 ring-rule"
            >
              {i + 1}
            </span>
            <h3 className="font-display text-[1.375rem] font-medium leading-tight tracking-[-0.015em] md:text-[1.5625rem]">{s.title}</h3>
            <p className="mt-3 max-w-[40ch] text-ink-dim">{s.body}</p>
          </li>
        ))}
      </ol>
      {aside ? <div>{aside}</div> : null}
    </div>
  );
}
```

### `src/components/site/CustomerResults.tsx`
Customer results proof

```tsx
import { CUSTOMER_RESULTS, resultsToShow, type CustomerResult } from "@/lib/site/proof";
import { Container } from "./Container";

/** Real client show rates, shown only with written permission. Renders nothing while the list is empty. */
export function CustomerResults({
  results = CUSTOMER_RESULTS,
  headingClass,
}: {
  results?: readonly CustomerResult[];
  headingClass: string;
}) {
  const shown = resultsToShow(results);
  if (!shown) return null;
  return (
    <section className="py-12 md:py-20">
      <Container>
        <h2 className={headingClass}>What our customers see</h2>
        <ul className="mt-10 grid list-none gap-0 p-0">
          {shown.map((r) => (
            <li key={r.business} className="grid gap-4 border-t border-border-strong py-8 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] md:gap-12">
              <div>
                <p className="font-display text-[3.0625rem] font-extrabold leading-none tracking-[-0.035em]">
                  {r.showRateBefore}%{" "}
                  <span className="mx-1 text-xl font-medium tracking-normal text-ink-dim">to</span>{" "}
                  {r.showRateAfter}%
                </p>
                <p className="mt-2 text-ink-dim">of booked clients showed up, {r.period}</p>
              </div>
              <div className="max-w-[60ch]">
                <p className="text-xl font-medium leading-snug">{r.business}</p>
                <p className="mt-1 text-ink-dim">{r.businessType}</p>
                {r.quote ? <blockquote className="mt-4 border-l-2 border-border-strong pl-4 text-lg">{r.quote}</blockquote> : null}
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
```

### `src/components/site/ReminderResearch.tsx`
Research stats on reminders

```tsx
import { RESEARCH_FINDINGS } from "@/lib/site/proof";
import { brandConfig } from "@/lib/brand-config";

/**
 * One sourced line (Ruling W30). The figure pairs are the link text and come
 * from RESEARCH_FINDINGS, so the line cannot drift from the cited papers.
 */
export function ReminderResearch() {
  const { name } = brandConfig();
  const [clinic, hospital] = RESEARCH_FINDINGS;
  const link = (f: (typeof RESEARCH_FINDINGS)[number]) => (
    <a href={f.href} rel="noopener" className="text-accent-text underline underline-offset-2">
      {f.from} to {f.to}
    </a>
  );
  return (
    <p className="max-w-[44ch] text-[0.9375rem] leading-[1.5] text-ink-dim">
      Outside our own numbers, two published trials found the same direction: a children&apos;s clinic went from {link(clinic)} of
      appointments missed when a text reminder was added, and a hospital went from {link(hospital)} across about 160,000
      appointments by rewording its reminder. Both studies used SMS reminders. {name} sends the same kind of reminder on
      WhatsApp instead, from your own number, and replies land back in Conversations.
    </p>
  );
}
```

### `src/components/site/SafetyThread.tsx`
Safety explanation thread

```tsx
import type { ReactNode } from "react";

interface Note {
  title: string;
  body: string;
}

/** One sample thread, annotated: each safety behaviour sits beside the message it explains. */
export function SafetyThread({ items }: { items: Note[] }) {
  const [paced, held, stop] = items;
  return (
    <ul className="mt-10 grid list-none gap-y-10 p-0 md:gap-y-8">
      <Row note={paced}>
        <Out status="Delivered">Hi Sam, your call is booked for 2pm tomorrow.</Out>
      </Row>
      <Row note={held}>
        <Out status="Waiting for the phone to reconnect">Your booking link is ready.</Out>
      </Row>
      <Row
        note={stop}
        lead={
          <div className="flex flex-col items-start">
            <p className="bubble bubble-in font-medium">STOP</p>
          </div>
        }
      >
        <Out status="Not sent. Sam opted out." notSent>
          We have a new offer for you.
        </Out>
      </Row>
    </ul>
  );
}

function Out({ children, status, notSent = false }: { children: ReactNode; status: string; notSent?: boolean }) {
  return (
    <div className="flex flex-col items-end">
      <p className={`bubble bubble-out${notSent ? " bubble-unsent" : ""}`}>{children}</p>
      <p className="mt-1.5 text-[0.8rem] text-ink-dim">{status}</p>
    </div>
  );
}

/** The bubble column is illustration (aria-hidden); the note carries the meaning. */
function Row({ note, lead, children }: { note: Note; lead?: ReactNode; children: ReactNode }) {
  return (
    <li>
      {lead ? (
        <div aria-hidden="true" className="mb-3 md:max-w-[22rem]">
          {lead}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-[minmax(0,22rem)_3rem_minmax(0,1fr)] md:gap-0">
        <div aria-hidden="true" className="min-w-0">
          {children}
        </div>
        {/* Thin connector, drawn level with the bubble the note explains. */}
        <span aria-hidden="true" className="mt-[22px] hidden h-px bg-border-strong md:block" />
        <div className="border-l-2 border-border-strong pl-4 md:max-w-[34ch]">
          <h3 className="font-display text-xl font-medium leading-snug">{note.title}</h3>
          <p className="mt-1 text-ink-dim">{note.body}</p>
        </div>
      </div>
    </li>
  );
}
```

### `src/components/site/PricingSummary.tsx`
Home pricing summary

```tsx
import Link from "next/link";
import { Cta } from "@/components/site/Cta";
import { formatMoney, pricingConfig } from "@/lib/pricing";
import { SITE_ROUTES } from "@/lib/site/routes";

/** The closing price strip, on Ink. The price is set large; the terms are one plain sentence. */
export function PricingSummary({ ctaLabel, terms }: { ctaLabel: string; terms: string }) {
  const pricing = pricingConfig();
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-8">
      <div className="max-w-[46ch]">
        <p className="flex flex-wrap items-baseline gap-x-4">
          <span className="font-display text-[3.8125rem] font-extrabold leading-none tracking-[-0.04em] [font-variant-numeric:tabular-nums]">
            {formatMoney(pricing.pricePerNumber, pricing.currency)}
          </span>
          <span className="text-xl">per WhatsApp number, per month</span>
        </p>
        <p className="mt-4 text-ink-dim">{terms}</p>
      </div>
      <div>
        <Cta label={ctaLabel} />
        <p className="mt-2">
          <Link href={SITE_ROUTES.pricing} className="inline-flex min-h-11 items-center text-accent-text underline underline-offset-2">
            See the full pricing
          </Link>
        </p>
      </div>
    </div>
  );
}
```

### `src/components/site/PricingTable.tsx`
Pricing tiers table

```tsx
import { CALCULATOR_PRESETS, formatMoney, monthlyCost, type PricingConfig } from "@/lib/pricing";

/** "1 number is £29 a month, 3 numbers £87 ..." as one sentence built from the presets. */
function fallbackSentence(pricing: PricingConfig): string {
  const parts = CALCULATOR_PRESETS.map((n) => {
    const cost = formatMoney(monthlyCost(n, pricing.pricePerNumber), pricing.currency);
    const label = n === 1 ? "1 number is" : `${n} numbers`;
    return n === 1 ? `${label} ${cost} a month` : `${label} ${cost}`;
  });
  return `For reference: ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

/**
 * The calculator's no-JS fallback: one sentence, always in the HTML, plus a
 * <noscript> line for the calculator's own slot. Not a table.
 */
export function PricingTable({ pricing }: { pricing: PricingConfig }) {
  return (
    <div>
      <p className="max-w-[62ch] text-ink-dim [font-variant-numeric:tabular-nums]">{fallbackSentence(pricing)}</p>
      <noscript>
        <p className="mt-2 max-w-[62ch] text-ink-dim">
          The calculator needs JavaScript. For any other number, multiply by{" "}
          {formatMoney(pricing.pricePerNumber, pricing.currency)}.
        </p>
      </noscript>
    </div>
  );
}
```

### `src/components/site/PricingCalculator.tsx`
Interactive cost calculator (client)

```tsx
"use client";

import { useId, useState } from "react";
import { formatMoney, monthlyCost } from "@/lib/pricing";
import { CALC_MAX, CALC_MIN, calculatorValue } from "@/lib/site/calculator";

const DEFAULT = "5";

/**
 * The calculator is one sentence: "If I connect [5] numbers, I'll pay £145 a month."
 * The label is the first clause; the amount sits in a polite live region, and
 * the help or error line below is the input's description.
 */
export function PricingCalculator({ pricePerNumber, currency }: { pricePerNumber: number; currency: string }) {
  const id = useId();
  const [raw, setRaw] = useState(DEFAULT);
  const { n, note, empty } = calculatorValue(raw);
  const cost = formatMoney(monthlyCost(n, pricePerNumber), currency);
  const invalid = note !== null && !empty;
  const messageId = `${id}-message`;
  return (
    <div>
      <p className="font-display text-[clamp(25px,3.6vw,39px)] font-medium leading-[1.3] tracking-[-0.015em]">
        <label htmlFor={id}>If I connect</label>{" "}
        <input
          id={id}
          type="number"
          min={CALC_MIN}
          max={CALC_MAX}
          step={1}
          inputMode="numeric"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-describedby={messageId}
          aria-invalid={invalid}
          className="mx-1 min-h-11 w-[5.5ch] rounded border border-border-strong bg-card px-2 text-center font-display font-extrabold [font-variant-numeric:tabular-nums] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />{" "}
        numbers,{" "}
        <span aria-live="polite" className="whitespace-nowrap">
          {empty ? null : (
            <>
              I&apos;ll pay <strong className="font-extrabold [font-variant-numeric:tabular-nums]">{cost}</strong> a month.
            </>
          )}
        </span>
      </p>
      <p
        id={messageId}
        role="status"
        className={`mt-3 min-h-[1.45em] text-[15px] ${note ? "font-medium text-warn" : "text-ink-faint"}`}
      >
        {note ?? `Whole numbers from ${CALC_MIN} to ${CALC_MAX}.`}
      </p>
    </div>
  );
}
```

### `src/components/site/SetupStep.tsx`
Docs setup step with diagram

```tsx
import type { ReactNode } from "react";
import type { Audience, DiagramId, SetupStep as Step } from "@/lib/site/setup-steps";
import { ConnectedDiagram } from "@/components/site/diagrams/ConnectedDiagram";
import { GhlMenuDiagram } from "@/components/site/diagrams/GhlMenuDiagram";
import { InstallDiagram } from "@/components/site/diagrams/InstallDiagram";
import { QrLinkDiagram } from "@/components/site/diagrams/QrLinkDiagram";
import { ReplyDiagram } from "@/components/site/diagrams/ReplyDiagram";
import { TelephonyProviderDiagram } from "@/components/site/diagrams/TelephonyProviderDiagram";
import { TestSendDiagram } from "@/components/site/diagrams/TestSendDiagram";

function diagramFor(id: DiagramId, brandName: string): ReactNode {
  switch (id) {
    case "install":
      return <InstallDiagram brandName={brandName} />;
    case "menu":
      return <GhlMenuDiagram brandName={brandName} />;
    case "telephony":
      return <TelephonyProviderDiagram brandName={brandName} />;
    case "qr":
      return <QrLinkDiagram />;
    case "connected":
      return <ConnectedDiagram />;
    case "test-send":
      return <TestSendDiagram brandName={brandName} />;
    case "reply":
      return <ReplyDiagram brandName={brandName} />;
  }
}

/** One numbered step: heading, summary, detail lines and its schematic. */
export function SetupStep({
  step,
  audience,
  brandName,
  index,
}: {
  index: number;
  step: Step;
  audience: Audience;
  brandName: string;
}) {
  const headingId = `${audience}-${step.id}`;
  return (
    <li className="grid gap-4 border-t py-6">
      <div>
        <h3 id={headingId} className="font-display text-lg font-medium">
          <span className="mr-2 text-accent-text">{index + 1}.</span>
          {step.title}
        </h3>
        <p className="mt-2 text-ink-dim">{step.summary}</p>
        <ul className="mt-3 grid max-w-[62ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink-faint">
          {step.detail[audience].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <figure className="m-0 rounded-lg border bg-well p-4">
        {diagramFor(step.diagram, brandName)}
        <figcaption className="mt-2 text-xs text-ink-dim">Schematic, not a screenshot.</figcaption>
      </figure>
    </li>
  );
}
```

### `src/components/site/AudienceTabs.tsx`
Audience tab switcher (client)

```tsx
"use client";

import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { AUDIENCES, AUDIENCE_LABELS, type Audience } from "@/lib/site/setup-steps";

/**
 * Two audience panels behind a tab list. Both panels are in the server HTML
 * (the inactive one `hidden`), so the content is there without JavaScript.
 * The tabs are links to `?audience=...`: with JavaScript off, clicking one
 * reloads the page with that audience selected; with it on, the click only
 * switches the panel and updates the address bar.
 */
export function AudienceTabs({
  panels,
  initial = "agency",
}: {
  panels: Record<Audience, ReactNode>;
  initial?: Audience;
}) {
  const [active, setActive] = useState<Audience>(initial);
  // Roving tabindex only once JS is running; without it every tab stays reachable.
  const enhanced = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const tabRefs = useRef<Record<Audience, HTMLAnchorElement | null>>({ agency: null, business: null });

  function select(next: Audience, focus: boolean) {
    setActive(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("audience", next);
      window.history.replaceState(null, "", url);
    } catch {
      /* the address bar is a nicety */
    }
    if (focus) tabRefs.current[next]?.focus();
  }

  function onClick(e: MouseEvent<HTMLAnchorElement>, a: Audience) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    select(a, false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, a: Audience) {
    const i = AUDIENCES.indexOf(a);
    let next: Audience | null = null;
    if (e.key === "ArrowRight") next = AUDIENCES[(i + 1) % AUDIENCES.length];
    else if (e.key === "ArrowLeft") next = AUDIENCES[(i - 1 + AUDIENCES.length) % AUDIENCES.length];
    else if (e.key === "Home") next = AUDIENCES[0];
    else if (e.key === "End") next = AUDIENCES[AUDIENCES.length - 1];
    else if (e.key === " ") {
      e.preventDefault();
      select(a, false);
      return;
    }
    if (next) {
      e.preventDefault();
      select(next, true);
    }
  }

  return (
    <div>
      <div role="tablist" aria-label="Who is setting this up" className="flex flex-wrap gap-2">
        {AUDIENCES.map((a) => {
          const selected = a === active;
          return (
            <a
              key={a}
              ref={(el) => {
                tabRefs.current[a] = el;
              }}
              role="tab"
              id={`tab-${a}`}
              href={`?audience=${a}#steps`}
              aria-selected={selected}
              aria-controls={`panel-${a}`}
              tabIndex={enhanced && !selected ? -1 : 0}
              onClick={(e) => onClick(e, a)}
              onKeyDown={(e) => onKeyDown(e, a)}
              className={`inline-flex min-h-11 items-center rounded border px-5 font-semibold ${
                selected
                  ? "border-ink bg-ink text-bg"
                  : "border-ink-faint text-ink-dim hover:border-ink hover:text-ink"
              }`}
            >
              {AUDIENCE_LABELS[a]}
            </a>
          );
        })}
      </div>
      <div id="steps" className="scroll-mt-4">
        {AUDIENCES.map((a) => (
          <div
            key={a}
            role="tabpanel"
            id={`panel-${a}`}
            aria-labelledby={`tab-${a}`}
            hidden={a !== active}
            tabIndex={0}
            className="mt-8"
          >
            {panels[a]}
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Samples (product mockups)

### `src/components/site/samples/PhoneFrame.tsx`
Phone bezel wrapper

```tsx
import type { ReactNode } from "react";

/**
 * A phone for sample messages: bezel, island, status bar, an app header, the
 * thread, a composer and a home bar. The SMS variant is a plain text-message
 * app (white, centred title, grey bubbles); the other is a chat app (cream
 * thread, dark header with an avatar). Neither borrows WhatsApp's colours or
 * logo. Decorative: the figure that holds it carries the description.
 */
export function PhoneFrame({
  title,
  variant,
  composer,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  variant: "sms" | "whatsapp";
  composer: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const sms = variant === "sms";
  return (
    <div aria-hidden="true" className={`phone ${sms ? "phone-sms" : "phone-chat"} ${className}`}>
      <span className="phone-island" />
      <div className="phone-screen">
        <div className="phone-status">
          <span>10:24</span>
          <svg width="40" height="11" viewBox="0 0 40 11" fill="currentColor">
            <rect x="0" y="7" width="3" height="4" rx="0.5" />
            <rect x="5" y="5" width="3" height="6" rx="0.5" />
            <rect x="10" y="2.5" width="3" height="8.5" rx="0.5" />
            <rect x="15" y="0" width="3" height="11" rx="0.5" />
            <rect x="22" y="1" width="16" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="24" y="3" width="10" height="5" rx="1" />
            <rect x="38.5" y="4" width="1.5" height="3" rx="0.5" />
          </svg>
        </div>
        <div className={`phone-head ${sms ? "phone-head-sms" : "phone-head-chat"}`}>
          <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2 2 8l6 6" />
          </svg>
          {sms ? null : <span className="phone-avatar">S</span>}
          <span>{title}</span>
        </div>
        <div className={`phone-body ${bodyClassName}`}>{children}</div>
        <div className="phone-composer">
          <span>{composer}</span>
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
            <circle cx="13" cy="13" r="13" fill="#454A57" />
            <path d="M13 19v-12M8 12l5-5 5 5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="phone-home" />
      </div>
    </div>
  );
}
```

### `src/components/site/samples/SameReminderTwice.tsx`
SMS vs WhatsApp phone pair

```tsx
import { PhoneFrame } from "./PhoneFrame";

/**
 * The signature figure: the same reminder as a text message nobody answered,
 * and in a chat app where Sam did. Pure markup and CSS (.hero-* in globals.css),
 * no client JS. Nothing here claims a rate; both phones are made-up samples.
 */
const REMINDER = "Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm.";
const REPLY = "Yes, see you at 2";

const LABEL = `Two phones showing the same appointment reminder, "${REMINDER}" On the left it is a text message sent yesterday at 14:02 with no reply. On the right it is a WhatsApp message marked Delivered, and Sam has replied "${REPLY}", which appears back in Conversations.`;

export function SameReminderTwice() {
  return (
    <figure role="img" aria-label={LABEL} className="mx-auto w-fit max-w-full lg:mx-0">
      <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-start lg:gap-0">
        <PhoneFrame title="Messages" variant="sms" composer="Text Message" className="lg:mt-14" bodyClassName="lg:pr-10">
          <p className="phone-meta">Text Message</p>
          <div className="flex flex-col items-end">
            <p className="bubble bubble-out text-[15px]">{REMINDER}</p>
            <p className="mt-1.5 text-sm text-ink-faint">Yesterday 14:02</p>
          </div>
        </PhoneFrame>

        <PhoneFrame title="Sam" variant="whatsapp" composer="Message" className="z-10 lg:-ml-3">
          <div className="flex flex-col items-end">
            <p className="hero-bubble bubble bubble-out text-[15px]">
              {REMINDER}
              <span className="hero-ping absolute -bottom-1 -right-1 block h-3 w-3 rounded-full border-2 border-well bg-accent" />
            </p>
            <p className="hero-delivered mt-1.5 text-sm text-ink-dim">Delivered</p>
          </div>
          <div className="hero-late mt-5 flex flex-col items-start">
            <p className="bubble bubble-in text-[15px]">{REPLY}</p>
            <p className="mt-1.5 text-sm text-ink-dim">Back in Conversations</p>
          </div>
        </PhoneFrame>
      </div>
      <figcaption className="mt-6 text-[15px] text-ink-faint">Sample messages. Sam is made up.</figcaption>
    </figure>
  );
}
```

### `src/components/site/samples/ConnectPanelSample.tsx`
Mock WhatsApp connect panel

```tsx
import { buttonClasses } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { brandConfig } from "@/lib/brand-config";
import { QR_WARNING } from "@/lib/site/setup-steps";

/**
 * The connect panel as the app draws it (WhatsappConnectionPanel): a built
 * mock, not a screenshot, so the strings stay crisp and follow the app. Nothing
 * inside is interactive. `connectedStrip` adds the state after the scan.
 */
/**
 * A dense, deterministic stand-in for a QR code: 29 modules with the three
 * finder squares, timing lines and an alignment square, the rest filled from a
 * fixed seed. Static SVG; it is not a valid code and cannot be scanned.
 */
function qrModules(): string {
  const N = 29;
  const grid: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N).fill(false));
  const reserved: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N).fill(false));
  const set = (x: number, y: number, on: boolean) => {
    grid[y][x] = on;
    reserved[y][x] = true;
  };
  const finder = (ox: number, oy: number) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const px = ox + x;
        const py = oy + y;
        if (px < 0 || py < 0 || px >= N || py >= N) continue;
        const ring = x >= 0 && x <= 6 && y >= 0 && y <= 6 && (x === 0 || x === 6 || y === 0 || y === 6);
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        set(px, py, ring || core);
      }
    }
  };
  finder(0, 0);
  finder(N - 7, 0);
  finder(0, N - 7);
  for (let i = 8; i < N - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      set(22 + x, 22 + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
    }
  }
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let d = "";
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const on = reserved[y][x] ? grid[y][x] : rand() < 0.5;
      if (on) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    }
  }
  return d;
}

const QR_PATH = qrModules();

function FakeQr() {
  return (
    <svg viewBox="0 0 33 33" width="168" height="168" shapeRendering="crispEdges" aria-hidden="true" className="mx-auto block rounded-[4px] border border-border bg-white">
      <path d={QR_PATH} fill="#1B1F2A" />
    </svg>
  );
}

const INSTRUCTION = "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.";

export function ConnectPanelSample({ connectedStrip = false }: { connectedStrip?: boolean }) {
  const { name } = brandConfig();
  const label = connectedStrip
    ? `The ${name} connect page in two states: Waiting for QR scan with a QR code, and Connected as +44 7700 900101.`
    : `The ${name} connect page: a WhatsApp panel with the status Waiting for QR scan, a QR code, the instruction to open WhatsApp, Settings, Linked devices, Link a device and scan it, a warning that whoever scans can send as your business, and a button to get a new QR code.`;

  return (
    <div role="img" aria-label={label} className="w-full max-w-md">
      <div aria-hidden="true" className="sample-chrome">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <p className="font-display text-xl font-medium">WhatsApp</p>
          <Chip tone="warn">Waiting for QR scan</Chip>
        </div>
        <div className="px-5 py-5">
          <FakeQr />
          <p className="mt-5 text-[15px] leading-snug text-ink">{INSTRUCTION}</p>
          <p className="mt-3 text-[15px] leading-snug text-loss">{QR_WARNING}</p>
          <span className={`${buttonClasses("secondary")} mt-5`}>Get a new QR code</span>
        </div>
        {connectedStrip ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-raised px-5 py-3 text-[15px]">
            <Chip tone="win">Connected</Chip>
            <span>
              as <span className="font-mono-nums">+44 7700 900101</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

### `src/components/site/samples/DashboardSample.tsx`
Mock dashboard

```tsx
import { Chip, type ChipTone } from "@/components/ui/Chip";
import { buttonClasses } from "@/components/ui/Button";
import { brandConfig } from "@/lib/brand-config";

/**
 * Three rows of the real dashboard (src/lib/account-data/preview.ts), with the
 * chips and notes the app prints. A static mock: it does not import the app's
 * LocationTable, which is interactive. Rows are a grid from 768px and small
 * stacked blocks below, from the same markup.
 */
interface Row {
  name: string;
  chip: { tone: ChipTone; label: string };
  number?: string;
  sent: string;
  note?: { text: string; tone: "warn" | "none" };
  action?: string;
}

const ROWS: Row[] = [
  {
    name: "Harbour Street Physio",
    chip: { tone: "win", label: "Connected" },
    number: "+44 7700 900101",
    sent: "42 / 150",
  },
  {
    name: "Millbrook Vets",
    chip: { tone: "loss", label: "Disconnected · 4 waiting" },
    sent: "18 / 150",
    note: { text: "Disconnected — 4 messages waiting", tone: "warn" },
    action: "Reconnect",
  },
  {
    name: "Fernbank Dental",
    chip: { tone: "win", label: "Connected" },
    number: "+44 7700 900102",
    sent: "0 / 150",
    note: { text: "No messages from GoHighLevel yet. Is the Telephony Provider set?", tone: "warn" },
  },
];

const GRID = "md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.6fr)_minmax(0,0.75fr)_minmax(0,1.4fr)] md:items-start md:gap-4";

export function DashboardSample() {
  const { name } = brandConfig();
  const label = `The ${name} dashboard with three sample sub-accounts: Harbour Street Physio, connected, 42 of 150 sent today; Millbrook Vets, disconnected with 4 messages waiting and a Reconnect button; Fernbank Dental, connected, 0 of 150, with the note "No messages from GoHighLevel yet. Is the Telephony Provider set?"`;

  return (
    <div role="img" aria-label={label} className="w-full">
      <div aria-hidden="true" className="sample-chrome overflow-hidden">
        <div className="hidden border-b bg-raised px-5 py-3 text-sm text-ink-faint md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.6fr)_minmax(0,0.75fr)_minmax(0,1.4fr)] md:gap-4">
          <span>Sub-account</span>
          <span>WhatsApp</span>
          <span>Sent today</span>
          <span>Needs attention</span>
        </div>
        <ul className="divide-y divide-divider">
          {ROWS.map((r) => (
            <li key={r.name} className={`grid gap-2 px-4 py-4 md:px-5 ${GRID}`}>
              <p className="font-semibold">{r.name}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Chip tone={r.chip.tone}>{r.chip.label}</Chip>
                {r.number ? <span className="font-mono-nums text-sm text-ink-dim">{r.number}</span> : null}
              </div>
              <p className="text-sm text-ink-dim tabular-nums">
                <span className="text-ink-faint md:hidden">Sent today </span>
                {r.sent}
              </p>
              <div className="flex flex-col items-start gap-2">
                {r.note ? <p className="text-sm font-medium text-warn">{r.note.text}</p> : <p className="text-sm text-ink-faint">Nothing to do</p>}
                {r.action ? <span className={buttonClasses("secondary", "sm")}>{r.action}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```
