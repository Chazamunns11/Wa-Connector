"use server";

import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { addCardFlow, endTrialFlow, openPortalFlow, startCheckoutFlow } from "@/lib/billing/self-serve";
import { repo } from "@/lib/data";
import { billingHref, dashboardHref } from "@/lib/site/dashboard-url";
import { createCardSetupSession, createCheckoutSession, createPortalSession, endTrialNow, retrieveSubscription } from "@/lib/stripe/billing";
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
  const out = await endTrialFlow(account, { endTrial: endTrialNow, retrieve: retrieveSubscription });
  if (out.kind === "ended") redirect(billingHref({ result: "trial_ended" }));
  if (out.kind === "needs_card") {
    // No card yet: collect one first; the webhook then ends the trial.
    const card = await addCardFlow(account, { appUrl: brandConfig().appUrl, setup: createCardSetupSession, then: "end_trial" });
    if (card.kind === "redirect") redirect(card.url);
    redirect(billingHref({ error: "stripe_failed" }));
  }
  redirect(out.kind === "not_trialing" ? billingHref() : billingHref({ error: "stripe_failed" }));
}

/** "Add a card": during the trial, or once a trial has ended with no card and sending is paused. */
export async function addCardAction(): Promise<void> {
  const session = await requireAccountSession();
  const account = await repo.getAccountById(session.accountId);
  if (!account) redirect(billingHref());
  if (!isStripeConfigured()) redirect(billingHref({ error: "stripe_failed" }));
  const out = await addCardFlow(account, { appUrl: brandConfig().appUrl, setup: createCardSetupSession });
  if (out.kind === "redirect") redirect(out.url);
  redirect(out.kind === "not_needed" ? billingHref() : billingHref({ error: "stripe_failed" }));
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
