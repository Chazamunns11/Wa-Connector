import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";
import { ReplyDiagram } from "@/components/site/diagrams/ReplyDiagram";
import { DashboardSample } from "@/components/site/samples/DashboardSample";
import type { BrandConfig } from "@/lib/brand-config";
import { featureEntries, type Feature } from "@/lib/site/features";

function Visual({
  feature,
  brand,
}: {
  feature: Feature;
  brand: BrandConfig;
}): ReactNode {
  if (feature.visual === "reply") {
    return (
      <div className="sample-chrome mt-6 p-4 min-[901px]:mt-0 min-[901px]:self-center">
        <ReplyDiagram brandName={brand.name} />
      </div>
    );
  }
  if (feature.visual === "dashboard") {
    return (
      <figure className="m-0 mt-8">
        <DashboardSample />
        <figcaption className="small mt-3 font-medium">
          Sample screen, sample businesses.
        </figcaption>
      </figure>
    );
  }
  // TODO: mount GroupChatSample for visual === "group" once the phone mock-ups task lands it.
  return null;
}

/** "What it does": ruled entries, two columns from 901px; the dashboard entry spans both. */
export function FeatureList({ brand }: { brand: BrandConfig }) {
  return (
    <section id="features" className="band hang-pad scroll-mt-4">
      <Container>
        <h2 className="h-page font-display">What it does</h2>
        <p className="mt-4 max-w-[52ch] text-xl text-ink-dim">
          Everything here is on every plan, for every number you connect.
        </p>
        <ul className="mt-10 grid list-none gap-x-12 gap-y-10 p-0 min-[901px]:grid-cols-2">
          {featureEntries(brand).map((f) => (
            <li
              key={f.id}
              className={`border-t-2 border-rule pt-6${f.visual === "dashboard" ? " min-[901px]:col-span-2" : ""}${f.visual === "reply" ? " min-[901px]:col-span-2 min-[901px]:grid min-[901px]:grid-cols-2 min-[901px]:gap-x-12" : ""}`}
            >
              <div>
                <h3 className="h-item font-display flex flex-wrap items-center gap-x-3 gap-y-2">
                  {f.title}
                  {f.soon ? (
                    <span className="small rounded-full bg-chip px-3 py-0.5 font-semibold text-chip-ink">
                      Coming soon
                    </span>
                  ) : null}
                </h3>
                <p
                  className={`mt-3 max-w-[52ch]${f.visual === "dashboard" ? " min-[901px]:max-w-[68ch]" : ""}`}
                >
                  {f.body}
                </p>
              </div>
              <Visual feature={f} brand={brand} />
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
