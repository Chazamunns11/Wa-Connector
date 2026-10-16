import type { FaqEntry } from "@/lib/site/faq";

/** Native disclosure per entry: works without JavaScript and by keyboard. Ids are anchors. */
export function FaqList({ entries }: { entries: FaqEntry[] }) {
  return (
    <div className="mt-6 max-w-[760px]">
      {entries.map((e) => (
        <details key={e.id} id={e.id} className="group scroll-mt-4 border-b border-divider">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
            <span>{e.question}</span>
            <span aria-hidden="true" className="text-accent-text group-open:hidden">
              +
            </span>
            <span aria-hidden="true" className="hidden text-accent-text group-open:inline">
              &minus;
            </span>
          </summary>
          <p className="max-w-[62ch] pb-4 text-ink-dim">{e.answer}</p>
        </details>
      ))}
    </div>
  );
}
