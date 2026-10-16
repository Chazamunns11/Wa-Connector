import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { brandCssVars, brandConfig } from "@/lib/brand-config";
import NotFoundBody from "@/app/(site)/not-found";

// Unmatched URLs render outside every route group, so this carries its own shell.
export default function RootNotFound() {
  return (
    <div style={brandCssVars(brandConfig())} className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        <NotFoundBody />
      </main>
      <SiteFooter />
    </div>
  );
}
