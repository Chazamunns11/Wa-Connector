import type { Metadata } from "next";
import { Container } from "@/components/site/Container";
import { DraftNotice } from "@/components/site/DraftNotice";
import { brandConfig } from "@/lib/brand-config";
import { LEGAL_OUTLINE } from "@/lib/site/legal-outline";

const outline = LEGAL_OUTLINE.privacy;

export function generateMetadata(): Metadata {
  return { title: `${outline.title} | ${brandConfig().name}`, robots: { index: false } };
}

export default function PrivacyPage() {
  return (
    <section className="pb-12 pt-12 md:pb-20">
      <Container>
        <div className="max-w-[760px]">
          <h1 className="font-display text-[clamp(32px,6vw,48px)] font-bold leading-[1.15]">{outline.title}</h1>
          <DraftNotice />
          {outline.headings.map((h) => (
            <h2 key={h} className="mt-10 font-display text-[clamp(20px,3vw,24px)] font-bold">
              {h}
            </h2>
          ))}
        </div>
      </Container>
    </section>
  );
}
