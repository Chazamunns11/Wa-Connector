import { RESEARCH_FINDINGS } from "@/lib/site/proof";

/** Cited research. The numbers are the content, so they lead; Ink, never Coral. */
export function ReminderResearch({ headingClass }: { headingClass: string }) {
  return (
    <>
      <h2 className={headingClass}>Why reminders on WhatsApp</h2>
      <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">
        Outside our own clients, two published trials on reminders and missed appointments.
      </p>
      <ul className="mt-10 grid list-none gap-0 p-0">
        {RESEARCH_FINDINGS.map((f) => (
          <li
            key={f.sourceId}
            className="grid gap-4 border-t border-border-strong py-8 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] md:gap-12"
          >
            <div>
              <p className="font-display text-[3.0625rem] font-extrabold leading-none tracking-[-0.035em]">
                {f.from}{" "}
                <span className="mx-1 text-xl font-medium tracking-normal text-ink-dim">to</span>{" "}
                {f.to}
              </p>
              <p className="mt-2 text-ink-dim">{f.measure}</p>
            </div>
            <div className="max-w-[60ch]">
              <p className="text-xl leading-snug">{f.claim}</p>
              <p className="mt-3 text-ink-dim">{f.caveat}</p>
              <p className="mt-3 text-[0.9375rem] text-ink-dim">
                Source:{" "}
                <a href={f.href} rel="noopener" className="text-accent-text underline">
                  {f.sourceTitle}
                </a>{" "}
                ({f.sourceId}, PubMed Central)
              </p>
            </div>
          </li>
        ))}
      </ul>
      <div className="border-t border-border-strong pt-8">
        <p className="max-w-[60ch] text-lg">
          Both studies used SMS reminders. PingWren sends the same GoHighLevel reminders on WhatsApp instead, from your own
          number, and replies land back in Conversations.
        </p>
      </div>
    </>
  );
}
