import Link from "next/link";
import type { PreviewScenario } from "@/lib/account-data";
import { billingHref, dashboardHref, type DashboardFilter } from "@/lib/site/dashboard-url";

const SCENARIOS: { id: PreviewScenario; label: string }[] = [
  { id: "trial", label: "On trial" },
  { id: "active", label: "Active" },
  { id: "past_due", label: "Payment failed" },
];

/** Preview only: flips between sample accounts. Callers render it only when the source is a preview. */
export function ScenarioSwitcher({
  scenario,
  filter,
  billing = false,
}: {
  scenario: PreviewScenario;
  filter?: DashboardFilter;
  /** Link to the billing page instead of the dashboard. */
  billing?: boolean;
}) {
  return (
    <nav aria-label="Sample account" className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-ink-dim">
      <span className="mr-1">Sample account:</span>
      {SCENARIOS.map((s) => {
        const href = billing ? billingHref(s.id) : dashboardHref({ scenario: s.id, filter });
        const current = s.id === scenario;
        return (
          <Link
            key={s.id}
            href={href}
            aria-current={current ? "true" : undefined}
            className={`inline-flex min-h-11 items-center rounded px-3 ${current ? "bg-raised font-semibold text-ink" : "text-accent-text underline underline-offset-2"}`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
