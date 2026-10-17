import { SITE_ROUTES } from "@/lib/site/routes";
import { TRIAL_CAP_MESSAGE } from "@/lib/account-data/derive";

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
  | "trial_cap"
  | "platform_cap"
  | "billing_inactive"
  | "stripe_failed"
  | "bridge_failed"
  | "link_unavailable"
  | "not_found";

export const DASHBOARD_RESULT_COPY: Record<DashboardResult, string> = {
  activated: "Number activated. Scan the QR code to connect WhatsApp.",
  deactivated: "Number deactivated. It will no longer send or be billed.",
  deactivated_billing_pending: "Deactivated. Your bill will update shortly.",
  disconnected: "WhatsApp disconnected from this number.",
  link: "Connect link ready to share.",
  trial_cap: TRIAL_CAP_MESSAGE,
  platform_cap: "We are at capacity for new numbers right now. Please try again soon.",
  billing_inactive: "Billing is not active on this account. Update billing to activate numbers.",
  stripe_failed: "We could not update billing just now, so nothing was changed. Please try again.",
  bridge_failed: "We could not reach WhatsApp just now. Please try again.",
  link_unavailable: "Connect links are not available right now. Please try again later.",
  not_found: "We could not find that sub-account.",
};

export function parseResult(value: string | string[] | undefined): DashboardResult | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && Object.hasOwn(DASHBOARD_RESULT_COPY, v) ? (v as DashboardResult) : null;
}

/** /dashboard URL keeping the filter, with an optional result notice and a row to focus. */
export function dashboardHref(opts: { filter?: DashboardFilter; result?: DashboardResult; focus?: string; qr?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.filter === "attention") q.set("filter", "attention");
  if (opts.result) q.set("result", opts.result);
  if (opts.focus) q.set("focus", opts.focus);
  if (opts.qr) q.set("qr", opts.qr);
  const s = q.toString();
  return `${SITE_ROUTES.dashboard}${s ? `?${s}` : ""}${opts.focus ? `#row-${opts.focus}` : ""}`;
}

/** Fixed notices the billing page can show after an action. */
export type BillingNotice = { result?: "trial_ended" | "card_added"; error?: "no_portal" | "stripe_failed" };

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
  const result = r === "trial_ended" || r === "card_added" ? r : undefined;
  const e = f(params.error);
  const error = e === "no_portal" || e === "stripe_failed" ? e : undefined;
  return { result, error };
}
