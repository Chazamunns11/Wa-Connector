"use server";

import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { createCheckoutForAccount } from "@/lib/billing/onboard";
import { repo } from "@/lib/data";
import { dashboardHref, parseFilter } from "@/lib/site/dashboard-url";
import { isStripeConfigured } from "@/lib/stripe/client";
import { createCheckoutSession } from "@/lib/stripe/billing";

/**
 * Placeholder until the row actions land: every row action goes back to the
 * dashboard saying the sub-account was not found. Changes nothing.
 */
export async function rowAction(formData: FormData): Promise<void> {
  await requireAccountSession();
  const filter = parseFilter(String(formData.get("filter") ?? ""));
  redirect(dashboardHref({ filter, result: "not_found" }));
}

/**
 * A pending account (Checkout abandoned) opens a fresh Checkout for the same
 * account id. Only a 'pending' account can; anyone else goes back to the dashboard.
 */
export async function startCheckoutAction(): Promise<void> {
  const session = await requireAccountSession();
  const account = await repo.getAccountById(session.accountId);
  if (!account || account.billingStatus !== "pending") redirect(dashboardHref());
  if (!isStripeConfigured()) redirect(dashboardHref({ result: "stripe_failed" }));
  const outcome = await createCheckoutForAccount(repo, { checkout: createCheckoutSession, appUrl: brandConfig().appUrl }, account);
  if (outcome.kind === "checkout") redirect(outcome.url);
  redirect(dashboardHref({ result: "stripe_failed" }));
}
