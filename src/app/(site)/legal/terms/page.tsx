import type { Metadata } from "next";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { DraftNotice } from "@/components/site/DraftNotice";
import { brandConfig } from "@/lib/brand-config";
import { LEGAL_OUTLINE } from "@/lib/site/legal-outline";

const outline = LEGAL_OUTLINE.terms;

export function generateMetadata(): Metadata {
  return { title: `${outline.title} | ${brandConfig().name}`, description: `Draft outline of the ${outline.title.toLowerCase()} for ${brandConfig().name}. The full text is coming before launch.` };
}

export default function TermsPage() {
  return (
    <>
    <PageTop title={outline.title} />
    <section className="pb-12 pt-2 md:pb-20">
      <Container>
        <div className="max-w-[760px]">
          <DraftNotice />
          {outline.headings.map((h) => (
            <h2 key={h} className="mt-12 font-display text-[clamp(1.5rem,3vw,2.2rem)] font-extrabold leading-[1.05] tracking-[-0.02em]">
              {h}
            </h2>
          ))}
        </div>
      </Container>
    </section>
    </>
  );
}
