import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { FaqList } from "@/components/site/FaqList";
import { brandConfig } from "@/lib/brand-config";
import { faqEntries } from "@/lib/site/faq";
import { SITE_ROUTES } from "@/lib/site/routes";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `FAQ | ${name}`,
    description: `Answers on how ${name} connects to WhatsApp, the risks, the daily cap, the free trial and cancelling.`,
  };
}

export default function FaqPage() {
  const brand = brandConfig();
  return (
    <section className="pb-12 pt-12 md:pb-20">
      <Container>
        <h1 className="font-display text-[clamp(32px,6vw,48px)] font-bold leading-[1.15]">Frequently asked questions</h1>
        <FaqList entries={faqEntries(brand)} />
        <p className="mt-8 max-w-[62ch] text-ink-dim">
          Not here? The{" "}
          <Link href={SITE_ROUTES.setup} className="underline underline-offset-2">
            setup guide
          </Link>{" "}
          has troubleshooting for the common snags.
        </p>
      </Container>
    </section>
  );
}
