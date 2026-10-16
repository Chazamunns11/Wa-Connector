import { DRAFT_NOTICE } from "@/lib/site/legal-outline";

/** Marks a placeholder legal page. */
export function DraftNotice() {
  return (
    <div role="note" className="mt-6 max-w-[62ch] rounded-lg border bg-raised p-4">
      <p className="font-semibold text-ink">{DRAFT_NOTICE}</p>
    </div>
  );
}
