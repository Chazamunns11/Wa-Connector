"use server";

import { redirect } from "next/navigation";
import { dashboardHref, parseFilter } from "@/lib/site/dashboard-url";
import { parseScenario } from "@/lib/account-data";

/**
 * Preview only: every row action lands here and does nothing. No bridge call,
 * no billing call, no account change. It sends the visitor back to the
 * dashboard with the "Preview" notice, keeping the scenario and filter.
 */
export async function previewRowAction(formData: FormData): Promise<void> {
  const scenario = parseScenario(String(formData.get("scenario") ?? ""));
  const filter = parseFilter(String(formData.get("filter") ?? ""));
  redirect(dashboardHref({ scenario, filter, notice: true }));
}
