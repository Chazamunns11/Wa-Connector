import { OWN_RESULTS_AVERAGE } from "@/lib/site/proof";

/**
 * Our own clients' average show rate. The most prominent figure on the page,
 * set like the research band's: plain display numbers, no card.
 */
export function OwnResults({ headingClass }: { headingClass: string }) {
  const r = OWN_RESULTS_AVERAGE;
  return (
    <>
      <h2 className={headingClass}>What we&apos;ve seen</h2>
      <div className="mt-8 grid gap-6 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] md:gap-12">
        <div>
          <p className="font-display text-[3.0625rem] font-extrabold leading-none tracking-[-0.035em]">
            {r.before}{" "}
            <span className="mx-1 text-xl font-medium tracking-normal text-ink-dim">to</span>{" "}
            {r.after}
          </p>
          <p className="mt-2 text-ink-dim">{r.measure}</p>
        </div>
        <div className="max-w-[60ch]">
          <p className="text-xl leading-snug">{r.claim}</p>
          <p className="mt-3 text-ink-dim">{r.note}</p>
        </div>
      </div>
    </>
  );
}
