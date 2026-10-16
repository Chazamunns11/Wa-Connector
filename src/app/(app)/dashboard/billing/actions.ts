"use server";

import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { endTrialFlow, openPortalFlow, startCheckoutFlow } from "@/lib/billing/self-serve";
import { repo } from "@/lib/data";
import { billingHref, dashboardHref } from "@/lib/site/dashboard-url";
import { createCheckoutSession, createPortalSession, endTrialNow } from "@/lib/stripe/billing";
import { isStripeConfigured } from "@/lib/stripe/client";

// Every action loads the account from the session's account id. Nothing here
// reads the form: a customer or subscription id can never come from the client.

export async function openBillingPortalAction(): Promise<void> {
  const session = await requireAccountSession();
  const account = await repo.getAccountById(session.accountId);
  if (!account || !isStripeConfigured()) redirect(billingHref({ error: "no_portal" }));
  const out = await openPortalFlow(account, { appUrl: brandConfig().appUrl, portal: createPortalSession });
  if (out.kind === "redirect") redirect(out.url);
  redirect(billingHref({ error: out.kind === "no_portal" ? "no_portal" : "stripe_failed" }));
}

export async function endTrialNowAction(): Promise<void> {
  const session = await requireAccountSession();
  const account = await repo.getAccountById(session.accountId);
  if (!account) redirect(billingHref());
  if (!isStripeConfigured()) redirect(billingHref({ error: "stripe_failed" }));
  const out = await endTrialFlow(account, { endTrial: endTrialNow });
  if (out.kind === "ended") redirect(billingHref({ result: "trial_ended" }));
  redirect(out.kind === "not_trialing" ? billingHref() : billingHref({ error: "stripe_failed" }));
}

/** A pending account (Checkout abandoned) opens a fresh Checkout for the same account id. */
export async function startCheckoutAction(): Promise<void> {
  const session = await requireAccountSession();
  const account = await repo.getAccountById(session.accountId);
  if (!account || account.billingStatus !== "pending") redirect(dashboardHref());
  if (!isStripeConfigured()) redirect(dashboardHref({ result: "stripe_failed" }));
  const out = await startCheckoutFlow(account, { appUrl: brandConfig().appUrl, checkout: createCheckoutSession });
  if (out.kind === "redirect") redirect(out.url);
  redirect(dashboardHref({ result: "stripe_failed" }));
}
