import type { FaqEntry } from "@/lib/site/faq";

/** Native disclosure per entry: works without JavaScript and by keyboard. Ids are anchors. */
export function FaqList({ entries }: { entries: FaqEntry[] }) {
  return (
    <div className="disclosure-list mt-6 max-w-[760px]">
      {entries.map((e) => (
        <details key={e.id} id={e.id} className="disclosure scroll-mt-4">
          <summary>
            <span>{e.question}</span>
          </summary>
          <p className="text-ink-dim">{e.answer}</p>
        </details>
      ))}
    </div>
  );
}
