/**
 * The three steps as three columns, each under a 3px Coral rule with a giant
 * numeral in the ground's rule colour (Direction B). Numbers stay because this really is a sequence.
 * Step 2 carries the GoHighLevel path as a chip.
 */
export function HowItWorks({ steps }: { steps: { title: string; body: string; path?: string }[] }) {
  return (
    <ol className="mt-10 grid list-none grid-cols-1 gap-0 p-0 min-[901px]:grid-cols-3 md:mt-16">
      {steps.map((s) => (
        <li key={s.title} className="border-t-[3px] border-rule pb-2 pr-7 pt-7 min-[901px]:mr-7 min-[901px]:last:mr-0 max-[900px]:mb-6">
          <span aria-hidden="true" className="step-num">
            {steps.indexOf(s) + 1}
          </span>
          <h3 className="h-item mb-2.5">{s.title}</h3>
          <p className="max-w-[40ch] text-ink-dim">{s.body}</p>
          {s.path ? <span className="path-chip">{s.path}</span> : null}
        </li>
      ))}
    </ol>
  );
}
