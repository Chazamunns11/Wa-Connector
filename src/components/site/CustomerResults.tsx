import { CUSTOMER_RESULTS, resultsToShow, type CustomerResult } from "@/lib/site/proof";
import { Container } from "./Container";

/** Real client show rates, shown only with written permission. Renders nothing while the list is empty. */
export function CustomerResults({
  results = CUSTOMER_RESULTS,
  headingClass,
}: {
  results?: readonly CustomerResult[];
  headingClass: string;
}) {
  const shown = resultsToShow(results);
  if (!shown) return null;
  return (
    <section className="py-12 md:py-20">
      <Container>
        <h2 className={headingClass}>What our customers see</h2>
        <ul className="mt-10 grid list-none gap-0 p-0">
          {shown.map((r) => (
            <li key={r.business} className="grid gap-4 border-t border-border-strong py-8 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] md:gap-12">
              <div>
                <p className="font-display text-[3.0625rem] font-extrabold leading-none tracking-[-0.035em]">
                  {r.showRateBefore}%{" "}
                  <span className="mx-1 text-xl font-medium tracking-normal text-ink-dim">to</span>{" "}
                  {r.showRateAfter}%
                </p>
                <p className="mt-2 text-ink-dim">of booked clients showed up, {r.period}</p>
              </div>
              <div className="max-w-[60ch]">
                <p className="text-xl font-medium leading-snug">{r.business}</p>
                <p className="mt-1 text-ink-dim">{r.businessType}</p>
                {r.quote ? <blockquote className="mt-4 border-l-2 border-border-strong pl-4 text-lg">{r.quote}</blockquote> : null}
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
