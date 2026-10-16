import type { ReactNode } from "react";

/**
 * The three steps as a vertical timeline (a Wren line with the steps hanging
 * off it). From 1024px the connect sample sits beside the steps, so neither
 * side leaves a hole. Numbers stay because this really is a sequence.
 */
export function HowItWorks({ steps, aside }: { steps: { title: string; body: string }[]; aside?: ReactNode }) {
  return (
    <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:items-start lg:gap-16">
      <ol className="grid list-none p-0">
        {steps.map((s, i) => (
          <li key={s.title} className="relative border-l-2 border-rule pb-12 pl-8 last:pb-0">
            <span
              aria-hidden="true"
              className="absolute -left-[17px] top-0 flex h-8 w-8 items-center justify-center rounded bg-bg font-display text-lg font-extrabold ring-2 ring-rule"
            >
              {i + 1}
            </span>
            <h3 className="font-display text-[1.375rem] font-medium leading-tight tracking-[-0.015em] md:text-[1.5625rem]">{s.title}</h3>
            <p className="mt-3 max-w-[40ch] text-ink-dim">{s.body}</p>
          </li>
        ))}
      </ol>
      {aside ? <div>{aside}</div> : null}
    </div>
  );
}
