import Link from "next/link";
import { groupPath } from "@/lib/site/routes";
import type { WhatsappGroup } from "@/lib/types";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

export function GroupList({ groups, numberLabel }: { groups: WhatsappGroup[]; numberLabel: (locationId: string) => string }) {
  return (
    <ul aria-label="Groups" className="divide-y divide-divider overflow-hidden rounded-lg border bg-card">
      {groups.map((g) => (
        <li key={g.id}>
          <Link href={groupPath(g.id)} className="flex min-h-14 flex-col gap-1 px-4 py-4 hover:bg-raised sm:flex-row sm:items-center sm:justify-between sm:gap-4 md:px-6">
            <span className="min-w-0 truncate font-medium text-ink">{g.subject}</span>
            <span className="text-sm text-ink-dim">
              {numberLabel(g.locationId)} · {g.participantCount} {g.participantCount === 1 ? "person" : "people"} · {fmt(g.createdAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
