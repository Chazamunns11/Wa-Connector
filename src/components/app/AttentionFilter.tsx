import Link from "next/link";
import { dashboardHref, type DashboardFilter } from "@/lib/site/dashboard-url";

const LINK = "inline-flex min-h-11 items-center rounded-full border-2 px-5 text-sm font-semibold tabular-nums";

export function AttentionFilter({
  filter,
  total,
  attention,
}: {
  filter: DashboardFilter;
  total: number;
  attention: number;
}) {
  const items: { id: DashboardFilter; label: string; n: number }[] = [
    { id: "all", label: "All", n: total },
    { id: "attention", label: "Needs attention", n: attention },
  ];
  return (
    <nav aria-label="Filter sub-accounts" className="flex flex-wrap gap-2">
      {items.map((i) => {
        const current = i.id === filter;
        return (
          <Link
            key={i.id}
            href={dashboardHref({ filter: i.id })}
            aria-current={current ? "page" : undefined}
            className={`${LINK} ${current ? "border-ink bg-ink text-bg" : "border-outline text-ink hover:bg-raised"}`}
          >
            {i.label} ({i.n})
          </Link>
        );
      })}
    </nav>
  );
}
