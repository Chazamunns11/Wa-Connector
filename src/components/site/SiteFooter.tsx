import Link from "next/link";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";

const LINK = "inline-flex min-h-11 items-center text-ink-dim hover:text-ink";

export function SiteFooter() {
  const { name, supportEmail, supportWhatsApp } = brandConfig();
  const waDigits = supportWhatsApp?.replace(/\D/g, "");
  return (
    <footer className="border-t py-8 text-sm text-ink-faint">
      <Container className="flex flex-wrap justify-between gap-x-6 gap-y-4">
        <p className="max-w-[62ch]">
          {name} is a linked-device connector, not the official WhatsApp Business API. {name} is
          not affiliated with or endorsed by Meta, WhatsApp or HighLevel.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6">
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
