import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { BrandMark } from "@/components/site/BrandMark";
import { Container } from "@/components/site/Container";
import { NAV_LINKS, SITE_ROUTES } from "@/lib/site/routes";

const NAV_LINK = "inline-flex min-h-11 items-center text-sm text-ink-dim hover:text-ink";

function TrialLabel() {
  return (
    <>
      Start <span className="max-sm:sr-only">7-day </span>free trial
    </>
  );
}

export function SiteHeader() {
  return (
    <header className="relative border-b">
      <Container className="flex min-h-16 items-center justify-between gap-2">
        <Link href={SITE_ROUTES.home} className="inline-flex min-h-11 items-center" aria-label="Home">
          <BrandMark />
        </Link>
        <nav aria-label="Main" className="hidden gap-6 md:flex">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={NAV_LINK}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href={SITE_ROUTES.login}
            className={buttonClasses("ghost", "md", "hidden min-h-11 min-[480px]:inline-flex")}
          >
            Log in
          </Link>
          <Link href={SITE_ROUTES.signup} className={buttonClasses("primary", "md", "min-h-11")}>
            <TrialLabel />
          </Link>
          <details className="group md:hidden">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded border px-3.5 text-sm font-medium text-ink-dim hover:text-ink [&::-webkit-details-marker]:hidden">
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
