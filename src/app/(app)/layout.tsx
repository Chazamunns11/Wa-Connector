import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/site/BrandMark";
import { Container } from "@/components/site/Container";
import { brandCssVars, brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";

const LINK = "inline-flex min-h-11 items-center px-2 text-sm text-ink-dim hover:text-ink";

/** Account screens: the site shell without the marketing nav. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div style={brandCssVars(brandConfig())} className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="border-b">
        <Container className="flex min-h-16 items-center justify-between gap-2">
          <Link href={SITE_ROUTES.dashboard} className="inline-flex min-h-11 items-center" aria-label="Dashboard">
            <BrandMark />
          </Link>
          <nav aria-label="Account" className="flex items-center gap-1">
            <Link href={SITE_ROUTES.dashboard} className={LINK}>
              Dashboard
            </Link>
            <Link href={SITE_ROUTES.billing} className={LINK}>
              Billing
            </Link>
            <Link href={SITE_ROUTES.login} className={LINK}>
              Log out
            </Link>
          </nav>
        </Container>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
