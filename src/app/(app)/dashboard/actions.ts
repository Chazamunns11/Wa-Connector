"use server";

import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import { dashboardHref, parseFilter } from "@/lib/site/dashboard-url";

/**
 * Placeholder until the row actions land: every row action goes back to the
 * dashboard saying the sub-account was not found. Changes nothing.
 */
export async function rowAction(formData: FormData): Promise<void> {
  await requireAccountSession();
  const filter = parseFilter(String(formData.get("filter") ?? ""));
  redirect(dashboardHref({ filter, result: "not_found" }));
}
