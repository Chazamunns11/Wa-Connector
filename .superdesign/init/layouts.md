# Layouts
Route groups: root `src/app/layout.tsx` (html, fonts) -> `(site)/layout.tsx` (SiteHeader + main + SiteFooter, brand CSS vars) -> `docs/layout.tsx` (wrapper). Header/footer use the `.surface-dark` Ink scope.

### `src/app/layout.tsx`
Root: html, fonts (Bricolage Grotesque, Instrument Sans, JetBrains Mono)

```tsx
import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { brandConfig } from "@/lib/brand-config";
import "./globals.css";

// Headings: Bricolage Grotesque, the logo's own face, at the two weights the
// wordmark uses (500 and 800). Body: Instrument Sans, a plain, slightly
// humanist sans that stays quiet next to Bricolage's quirks.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["500", "800"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-body-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: name,
    description: `${name} — WhatsApp for GoHighLevel.`,
    // Icons come from the file convention: src/app/favicon.ico, icon.svg and
    // apple-icon.png (copies of the kit's favicon.ico / favicon.svg / favicon-180.png).
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en-GB"
      className={`${instrumentSans.variable} ${jetbrainsMono.variable} ${bricolage.variable} h-full`}
    >
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
```

### `src/app/(site)/layout.tsx`
Site shell: skip link, header, main, footer

```tsx
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { brandCssVars, brandConfig } from "@/lib/brand-config";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div style={brandCssVars(brandConfig())} className="site-body flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
```

### `src/app/(site)/docs/layout.tsx`
Docs wrapper

```tsx
import type { ReactNode } from "react";

/** Docs read better dark-on-light: the header and footer stay dark, the page body flips to the light token set. */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return <div className="surface-light min-h-full bg-bg text-ink">{children}</div>;
}
```

### `src/components/site/SiteHeader.tsx`
Top nav (dark)

```tsx
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { BrandMark } from "@/components/site/BrandMark";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { NAV_LINKS, SITE_ROUTES } from "@/lib/site/routes";

const NAV_LINK = "inline-flex min-h-11 items-center text-sm text-ink-dim hover:text-ink";

export function SiteHeader() {
  return (
    <header className="surface-dark relative border-b">
      <Container className="flex min-h-[72px] items-center justify-between gap-2">
        <Link href={SITE_ROUTES.home} className="inline-flex min-h-11 shrink-0 items-center" aria-label={`${brandConfig().name} home`}>
          <BrandMark surface="dark" size={44} />
        </Link>
        <nav aria-label="Main" className="hidden gap-6 md:flex">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={NAV_LINK}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden min-[480px]:contents">
            <Link href={SITE_ROUTES.login} className={buttonClasses("ghost", "md", "min-h-11")}>
              Log in
            </Link>
          </span>
          <Link href={SITE_ROUTES.signup} className={buttonClasses("primary", "md", "min-h-11")}>
            <span className="whitespace-nowrap">
              Start <span className="max-sm:hidden">7-day </span>free trial
            </span>
          </Link>
          <details className="group md:hidden">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded border border-border-strong px-3.5 text-sm font-medium text-ink-dim hover:text-ink [&::-webkit-details-marker]:hidden">
              Menu
            </summary>
            {/* Full width of the header, not a narrow popover. */}
            <nav
              aria-label="Menu"
              className="absolute inset-x-0 top-full z-20 grid border-b bg-card px-4 py-2"
            >
              {NAV_LINKS.map((l) => (
                <Link key={l.href} href={l.href} className={`${NAV_LINK} px-1`}>
                  {l.label}
                </Link>
              ))}
              <Link href={SITE_ROUTES.login} className={`${NAV_LINK} px-1`}>
                Log in
              </Link>
            </nav>
          </details>
        </div>
      </Container>
    </header>
  );
}
```

### `src/components/site/SiteFooter.tsx`
Footer (dark)

```tsx
import Link from "next/link";
import { BrandMark } from "@/components/site/BrandMark";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";

const LINK = "inline-flex min-h-11 items-center px-2 -mx-2 text-ink-dim hover:text-ink";

export function SiteFooter() {
  const { name, supportEmail, supportWhatsApp } = brandConfig();
  const waDigits = supportWhatsApp?.replace(/\D/g, "");
  return (
    <footer className="surface-dark py-10 text-sm text-ink-faint">
      <Container className="flex flex-wrap justify-between gap-x-6 gap-y-6">
        <div className="grid max-w-[62ch] gap-4">
          <BrandMark surface="dark" size={36} />
          <p>
            {name} connects to WhatsApp as a linked device, not through the official WhatsApp Business API. {name} is
            not affiliated with or endorsed by Meta, WhatsApp or HighLevel.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 self-start">
          <Link href={SITE_ROUTES.terms} className={LINK}>
            Terms
          </Link>
          <Link href={SITE_ROUTES.privacy} className={LINK}>
            Privacy
          </Link>
          <Link href={SITE_ROUTES.docs} className={LINK}>
            Docs
          </Link>
          {supportEmail ? (
            <a href={`mailto:${supportEmail}`} className={LINK}>
              {supportEmail}
            </a>
          ) : null}
          {waDigits ? (
            <a href={`https://wa.me/${waDigits}`} className={LINK}>
              WhatsApp support
            </a>
          ) : null}
        </nav>
      </Container>
    </footer>
  );
}
```

### `src/components/site/BrandMark.tsx`
Logo image (light/reverse)

```tsx
import { brandConfig } from "@/lib/brand-config";

/**
 * The kit's horizontal logo is 473 x 148. The artwork is cropped to the mark,
 * so it carries NO clear space of its own: BrandMark adds it above and below as a
 * margin of 20% of the logo height (at least the wren head's height); the page
 * gutter already gives horizontal clear space, so the logo stays on the content edge.
 */
const LOGO_RATIO = 473 / 148;
const CLEAR_SPACE = 0.2;

/**
 * The PingWren logo, untouched: the standard artwork on light surfaces, the
 * reverse artwork on dark ones. Never recoloured, stretched or outlined; width
 * follows height. Pass the surface the mark sits on.
 */
export function BrandMark({
  size = 40,
  surface = "light",
}: {
  size?: number;
  surface?: "light" | "dark";
}) {
  const { name, logoPath, logoReversePath } = brandConfig();
  const src = surface === "dark" ? logoReversePath : logoPath;
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- BRAND_LOGO_PATH may be an arbitrary absolute URL, so next/image's remote allow-list does not apply
      <img
        src={src}
        alt={name}
        width={Math.round(size * LOGO_RATIO)}
        height={size}
        style={{ height: size, width: "auto", marginBlock: Math.round(size * CLEAR_SPACE) }}
      />
    );
  }
  return (
    <span
      className="whitespace-nowrap font-display font-extrabold leading-none text-ink"
      style={{ fontSize: Math.max(16, Math.round(size * 0.6)) }}
    >
      {name}
    </span>
  );
}
```

### `src/components/site/Container.tsx`
Max-width page container

```tsx
import type { ReactNode } from "react";

/** Page width: 72rem max, 16px gutters (32px from 768px). */
export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-6xl px-4 md:px-8 ${className}`}>
      {children}
    </div>
  );
}
```
