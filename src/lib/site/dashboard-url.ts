import { SITE_ROUTES } from "@/lib/site/routes";
import { TRIAL_MAX_NUMBERS } from "@/lib/pricing";

export type DashboardFilter = "all" | "attention";

export function parseFilter(value: string | string[] | undefined): DashboardFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "attention" ? "attention" : "all";
}

/** What a row action tells the customer when it sends them back to the dashboard. Fixed strings only. */
export type DashboardResult =
  | "activated"
  | "deactivated"
  | "disconnected"
  | "link"
  | "trial_cap"
  | "platform_cap"
  | "billing_inactive"
  | "stripe_failed"
  | "not_found";

export const DASHBOARD_RESULT_COPY: Record<DashboardResult, string> = {
  activated: "Number activated. Scan the QR code to connect WhatsApp.",
  deactivated: "Number deactivated. It will no longer send or be billed.",
  disconnected: "WhatsApp disconnected from this number.",
  link: "Connect link ready to share.",
  trial_cap: `Your free trial includes up to ${TRIAL_MAX_NUMBERS} numbers. End the trial early to activate more.`,
  platform_cap: "We are at capacity for new numbers right now. Please try again soon.",
  billing_inactive: "Billing is not active on this account. Update billing to activate numbers.",
  stripe_failed: "We could not update billing just now, so nothing was changed. Please try again.",
  not_found: "We could not find that sub-account.",
};

export function parseResult(value: string | string[] | undefined): DashboardResult | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && Object.hasOwn(DASHBOARD_RESULT_COPY, v) ? (v as DashboardResult) : null;
}

/** /dashboard URL keeping the filter, with an optional result notice and a row to focus. */
export function dashboardHref(opts: { filter?: DashboardFilter; result?: DashboardResult; focus?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.filter === "attention") q.set("filter", "attention");
  if (opts.result) q.set("result", opts.result);
  if (opts.focus) q.set("focus", opts.focus);
  const s = q.toString();
  return `${SITE_ROUTES.dashboard}${s ? `?${s}` : ""}${opts.focus ? `#row-${opts.focus}` : ""}`;
}

export function billingHref(): string {
  return SITE_ROUTES.billing;
}
