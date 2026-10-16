import type { ReactNode } from "react";

/**
 * The three steps as a timeline: a vertical Wren line with the steps hanging
 * off it on a phone, a horizontal one from 1024px. Numbers stay because this
 * really is a sequence. `aside` hangs under the last step (the connect sample).
 */
export function HowItWorks({ steps, aside }: { steps: { title: string; body: string }[]; aside?: ReactNode }) {
  return (
    <ol className="mt-12 grid list-none p-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)]">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className="relative border-l-2 border-rule pb-12 pl-8 last:pb-0 lg:border-l-0 lg:border-t-2 lg:pb-0 lg:pl-0 lg:pr-10 lg:pt-8"
        >
          <span
            aria-hidden="true"
            className="absolute -left-[17px] top-0 flex h-8 w-8 items-center justify-center rounded bg-bg font-display text-lg font-extrabold ring-2 ring-rule lg:-top-[17px] lg:left-0"
          >
            {i + 1}
          </span>
          <h3 className="font-display text-[1.375rem] font-medium leading-tight tracking-[-0.015em] md:text-[1.5625rem]">{s.title}</h3>
          <p className="mt-3 max-w-[40ch] text-ink-dim">{s.body}</p>
          {i === steps.length - 1 && aside ? <div className="mt-8">{aside}</div> : null}
        </li>
      ))}
    </ol>
  );
}
