import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { FaqList } from "@/components/site/FaqList";
import { brandConfig } from "@/lib/brand-config";
import { faqEntries } from "@/lib/site/faq";
import { SITE_ROUTES } from "@/lib/site/routes";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `FAQ — ${name}`,
    description: `Answers on how ${name} connects to WhatsApp, the risks, the daily cap, the free trial and cancelling.`,
  };
}

export default function FaqPage() {
  const brand = brandConfig();
  return (
    <>
    <PageTop title="Frequently asked questions" />
    <section className="band bg-raised">
      <Container>
        <FaqList entries={faqEntries(brand)} />
      </Container>
    </section>
    <section className="band-tight">
      <Container>
        <p className="max-w-[62ch] text-ink-dim">
          Not here? The{" "}
          <Link href={SITE_ROUTES.setup} className="underline underline-offset-2">
            setup guide
          </Link>{" "}
          has troubleshooting for the common snags.
        </p>
      </Container>
    </section>
    </>
  );
}
