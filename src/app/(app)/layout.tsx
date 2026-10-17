import Link from "next/link";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { brandCssVars, brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";
import { signOutAction } from "@/app/login/actions";

const LINK = "inline-flex min-h-11 items-center whitespace-nowrap px-1.5 text-sm font-semibold text-ink hover:underline underline-offset-4 sm:px-2";

/** Account screens: the same header as the site, with the signed-in links in place of the marketing nav. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const groupsOn = process.env.GROUPS_ENABLED === "true";
  return (
    <div style={brandCssVars(brandConfig())} className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <SiteHeader
        accountNav={
          <>
            <Link href={SITE_ROUTES.dashboard} className={LINK}>
              Dashboard
            </Link>
            {groupsOn && (
              <Link href={SITE_ROUTES.groups} className={LINK}>
                Groups
              </Link>
            )}
            <Link href={SITE_ROUTES.billing} className={LINK}>
              Billing
            </Link>
            <form action={signOutAction}>
              <button type="submit" className={LINK}>
                Log out
              </button>
            </form>
          </>
        }
      />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
