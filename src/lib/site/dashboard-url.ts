import { SITE_ROUTES } from "@/lib/site/routes";
import { TRIAL_DAYS } from "@/lib/pricing";

export type DashboardFilter = "all" | "attention";

export function parseFilter(value: string | string[] | undefined): DashboardFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "attention" ? "attention" : "all";
}

/** What a row action tells the customer when it sends them back to the dashboard. Fixed strings only. */
export type DashboardResult =
  | "activated"
  | "deactivated"
  | "deactivated_billing_pending"
  | "disconnected"
  | "link"
  | "platform_cap"
  | "billing_inactive"
  | "stripe_failed"
  | "bridge_failed"
  | "link_unavailable"
  | "not_found";

export const DASHBOARD_RESULT_COPY: Record<DashboardResult, string> = {
  activated: `Sub-account activated. A number new to billing starts a ${TRIAL_DAYS}-day free trial. Scan the QR code to connect WhatsApp.`,
  deactivated: "Sub-account deactivated. Its numbers no longer send or get billed.",
  deactivated_billing_pending: "Deactivated. Your bill will update shortly.",
  disconnected: "WhatsApp disconnected from this number.",
  link: "Connect link ready to share.",
  platform_cap: "We are at capacity for new numbers right now. Please try again soon.",
  billing_inactive: "Save a card on the Billing page before you activate numbers.",
  stripe_failed: "We could not update billing just now, so nothing was changed. Please try again.",
  bridge_failed: "We could not reach WhatsApp just now. Please try again.",
  link_unavailable: "Connect links are not available right now. Please try again later.",
  not_found: "We could not find that sub-account.",
};

export function parseResult(value: string | string[] | undefined): DashboardResult | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && Object.hasOwn(DASHBOARD_RESULT_COPY, v) ? (v as DashboardResult) : null;
}

/** /dashboard URL keeping the filter, with an optional result notice, a row to focus, and a row whose details are open. */
export function dashboardHref(opts: { filter?: DashboardFilter; result?: DashboardResult; focus?: string; qr?: string; open?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.filter === "attention") q.set("filter", "attention");
  if (opts.result) q.set("result", opts.result);
  if (opts.focus) q.set("focus", opts.focus);
  if (opts.qr) q.set("qr", opts.qr);
  if (opts.open) q.set("open", opts.open);
  const s = q.toString();
  const anchor = opts.focus ?? opts.open;
  return `${SITE_ROUTES.dashboard}${s ? `?${s}` : ""}${anchor ? `#row-${anchor}` : ""}`;
}

/** Fixed notices the billing page can show after an action. */
export type BillingNotice = { result?: "card_added"; error?: "no_portal" | "stripe_failed" };

export function billingHref(notice: BillingNotice = {}): string {
  const q = new URLSearchParams();
  if (notice.result) q.set("result", notice.result);
  if (notice.error) q.set("error", notice.error);
  const s = q.toString();
  return `${SITE_ROUTES.billing}${s ? `?${s}` : ""}`;
}

export function parseBillingNotice(params: Record<string, string | string[] | undefined>): BillingNotice {
  const f = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const r = f(params.result);
  const result = r === "card_added" ? r : undefined;
  const e = f(params.error);
  const error = e === "no_portal" || e === "stripe_failed" ? e : undefined;
  return { result, error };
}
