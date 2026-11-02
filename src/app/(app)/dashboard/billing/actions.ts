"use server";

import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { hasCardOnFile } from "@/lib/billing/activation";
import { addCardFlow, openPortalFlow, startCheckoutFlow } from "@/lib/billing/self-serve";
import { repo } from "@/lib/data";
import { billingHref, dashboardHref } from "@/lib/site/dashboard-url";
import { createCardSetupSession, createCustomer, createPortalSession } from "@/lib/stripe/billing";
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

/** "Add a card": a number stopped sending because its trial ended with no usable card. */
export async function addCardAction(): Promise<void> {
  const session = await requireAccountSession();
  const account = await repo.getAccountById(session.accountId);
  if (!account) redirect(billingHref());
  if (!isStripeConfigured()) redirect(billingHref({ error: "stripe_failed" }));
  const out = await addCardFlow(account, { appUrl: brandConfig().appUrl, setup: createCardSetupSession });
  if (out.kind === "redirect") redirect(out.url);
  redirect(out.kind === "not_needed" ? billingHref() : billingHref({ error: "stripe_failed" }));
}

/** No card on file yet (signup Checkout abandoned): a fresh save-a-card Checkout for the same account id. */
export async function startCheckoutAction(): Promise<void> {
  const session = await requireAccountSession();
  const account = await repo.getAccountById(session.accountId);
  if (!account || hasCardOnFile(account.billingStatus)) redirect(dashboardHref());
  if (!isStripeConfigured()) redirect(dashboardHref({ result: "stripe_failed" }));
  const out = await startCheckoutFlow(repo, account, { appUrl: brandConfig().appUrl, createCustomer, setup: createCardSetupSession });
  if (out.kind === "redirect") redirect(out.url);
  redirect(dashboardHref({ result: "stripe_failed" }));
}
