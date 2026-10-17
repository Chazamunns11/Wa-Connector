import type { Account } from "@/lib/types";
import type { createCardSetupSession, createCheckoutSession, createPortalSession, endTrialNow, retrieveSubscription } from "@/lib/stripe/billing";
import { createCheckoutForAccount } from "./onboard";

/**
 * Decisions behind the billing page's three buttons. Each takes the account
 * row the server action loaded from the session, never an id from the form.
 */

export type PortalOutcome = { kind: "redirect"; url: string } | { kind: "no_portal" } | { kind: "failed" };

export async function openPortalFlow(
  account: Account,
  deps: { appUrl: string; portal: typeof createPortalSession },
): Promise<PortalOutcome> {
  if (!account.stripeCustomerId) return { kind: "no_portal" };
  const r = await deps.portal(account.stripeCustomerId, `${deps.appUrl}/dashboard/billing`);
  return r.ok ? { kind: "redirect", url: r.data.url } : { kind: "failed" };
}

export type EndTrialOutcome = { kind: "ended" } | { kind: "needs_card" } | { kind: "not_trialing" } | { kind: "failed" };

/**
 * Trialing only. The webhook, not this call, moves billing_status. The trial
 * takes no card, and ending it with none would pause the subscription at
 * once, so a subscription without a card returns `needs_card` instead.
 */
export async function endTrialFlow(
  account: Account,
  deps: { endTrial: typeof endTrialNow; retrieve: typeof retrieveSubscription },
): Promise<EndTrialOutcome> {
  if (account.billingStatus !== "trialing") return { kind: "not_trialing" };
  if (!account.stripeSubscriptionId) return { kind: "failed" };
  const live = await deps.retrieve(account.stripeSubscriptionId);
  if (!live.ok) return { kind: "failed" };
  if (!live.data.cardLast4) return { kind: "needs_card" };
  const r = await deps.endTrial(account.stripeSubscriptionId);
  return r.ok ? { kind: "ended" } : { kind: "failed" };
}

export type AddCardOutcome = { kind: "redirect"; url: string } | { kind: "not_needed" } | { kind: "failed" };

/**
 * "Add a card": a setup-mode Checkout on the account's own customer. Offered
 * while trialing (before the trial ends) and once a trial has ended with no
 * card (Stripe `paused`, which keeps trialEndsAt). An `unpaid` account is
 * also `paused` but has a card and an unpaid invoice: that goes to the portal.
 */
export async function addCardFlow(
  account: Account,
  deps: { appUrl: string; setup: typeof createCardSetupSession; then?: "end_trial" },
): Promise<AddCardOutcome> {
  const eligible = account.billingStatus === "trialing" || (account.billingStatus === "paused" && !!account.trialEndsAt);
  if (!eligible || !account.stripeCustomerId || !account.stripeSubscriptionId) return { kind: "not_needed" };
  const r = await deps.setup({
    accountId: account.id,
    customerId: account.stripeCustomerId,
    successUrl: `${deps.appUrl}/dashboard/billing?result=card_added`,
    cancelUrl: `${deps.appUrl}/dashboard/billing`,
    ...(deps.then ? { then: deps.then } : {}),
  });
  return r.ok ? { kind: "redirect", url: r.data.url } : { kind: "failed" };
}

export type CheckoutOutcome = { kind: "redirect"; url: string } | { kind: "not_pending" } | { kind: "failed" };

export async function startCheckoutFlow(
  account: Account,
  deps: { appUrl: string; checkout: typeof createCheckoutSession },
): Promise<CheckoutOutcome> {
  // A cancelled account gets a fresh Checkout; the webhook then repoints its subscription.
  if (account.billingStatus !== "pending" && account.billingStatus !== "cancelled") return { kind: "not_pending" };
  const o = await createCheckoutForAccount(null, deps, account);
  return o.kind === "checkout" ? { kind: "redirect", url: o.url } : { kind: "failed" };
}
