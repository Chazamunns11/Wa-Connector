import Link from "next/link";
import { BrandMark } from "@/components/site/BrandMark";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";

const LINK = "inline-flex min-h-11 items-center px-2 -mx-2 font-medium text-ink underline-offset-4 hover:underline";

export function SiteFooter() {
  const { name, supportEmail, supportWhatsApp } = brandConfig();
  const waDigits = supportWhatsApp?.replace(/\D/g, "");
  return (
    <footer className="surface-dark pb-10 pt-12 small text-ink-dim">
      <Container className="flex flex-wrap justify-between gap-x-6 gap-y-6">
        <div className="grid max-w-[70ch] gap-4">
          <BrandMark surface="dark" size={40} />
          <p>
            {name} connects to WhatsApp as a linked device, not through the official WhatsApp Business API. {name} is
            not affiliated with or endorsed by Meta, WhatsApp or HighLevel.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 self-start">
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
