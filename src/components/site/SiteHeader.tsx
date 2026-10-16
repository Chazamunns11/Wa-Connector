import Link from "next/link";
import { siteButton } from "@/components/site/button";
import { BrandMark } from "@/components/site/BrandMark";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { NAV_LINKS, SITE_ROUTES } from "@/lib/site/routes";

const NAV_LINK = "inline-flex min-h-11 items-center font-semibold text-ink hover:underline underline-offset-4";

/** Coral field: the hero (or page top) continues the same colour, so no bottom border. */
export function SiteHeader() {
  return (
    <header className="surface-coral relative">
      <Container className="flex min-h-[72px] items-center justify-between gap-2">
        <Link href={SITE_ROUTES.home} className="inline-flex min-h-11 shrink-0 items-center" aria-label={`${brandConfig().name} home`}>
          <BrandMark surface="light" size={40} />
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
            <Link href={SITE_ROUTES.login} className={`${NAV_LINK} px-3`}>
              Log in
            </Link>
          </span>
          <Link href={SITE_ROUTES.signup} className={siteButton("ink", "btn-sm max-[420px]:!px-3")}>
            <span className="whitespace-nowrap">
              Start <span className="max-sm:hidden">7-day </span>free trial
            </span>
          </Link>
          <details className="group md:hidden">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-full border-2 border-border-strong px-3 font-semibold min-[420px]:px-4 text-ink [&::-webkit-details-marker]:hidden">
              Menu
            </summary>
            {/* Full width of the header, not a narrow popover. */}
            <nav
              aria-label="Menu"
              className="absolute inset-x-0 top-full z-20 grid border-b-2 border-rule bg-card px-4 py-2"
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
