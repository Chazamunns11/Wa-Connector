import { SITE_ROUTES } from "@/lib/site/routes";
import { parseScenario, type PreviewScenario } from "@/lib/account-data";

export type DashboardFilter = "all" | "attention";

export function parseFilter(value: string | string[] | undefined): DashboardFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "attention" ? "attention" : "all";
}

/** /dashboard URL that keeps the sample scenario and filter. */
export function dashboardHref(opts: { scenario: PreviewScenario; filter?: DashboardFilter; notice?: boolean }): string {
  const q = new URLSearchParams();
  if (opts.scenario !== "trial") q.set("scenario", opts.scenario);
  if (opts.filter === "attention") q.set("filter", "attention");
  if (opts.notice) q.set("notice", "preview");
  const s = q.toString();
  return `${SITE_ROUTES.dashboard}${s ? `?${s}` : ""}${opts.notice ? "#preview-notice" : ""}`;
}

export { parseScenario };
