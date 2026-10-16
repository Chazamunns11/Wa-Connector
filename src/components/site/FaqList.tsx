import Link from "next/link";
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
          {e.link ? (
            <p className="mt-2">
              <Link href={e.link.href} className="font-semibold text-ink underline underline-offset-2">
                {e.link.text}
              </Link>
            </p>
          ) : null}
        </details>
      ))}
    </div>
  );
}
