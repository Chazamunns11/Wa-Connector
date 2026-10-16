import type { Account } from "@/lib/types";
import type { createCheckoutSession, createPortalSession, endTrialNow } from "@/lib/stripe/billing";
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

export type EndTrialOutcome = { kind: "ended" } | { kind: "not_trialing" } | { kind: "failed" };

/** Trialing only. The webhook, not this call, moves billing_status. */
export async function endTrialFlow(
  account: Account,
  deps: { endTrial: typeof endTrialNow },
): Promise<EndTrialOutcome> {
  if (account.billingStatus !== "trialing") return { kind: "not_trialing" };
  if (!account.stripeSubscriptionId) return { kind: "failed" };
  const r = await deps.endTrial(account.stripeSubscriptionId);
  return r.ok ? { kind: "ended" } : { kind: "failed" };
}

export type CheckoutOutcome = { kind: "redirect"; url: string } | { kind: "not_pending" } | { kind: "failed" };

export async function startCheckoutFlow(
  account: Account,
  deps: { appUrl: string; checkout: typeof createCheckoutSession },
): Promise<CheckoutOutcome> {
  if (account.billingStatus !== "pending") return { kind: "not_pending" };
  const o = await createCheckoutForAccount(null, deps, account);
  return o.kind === "checkout" ? { kind: "redirect", url: o.url } : { kind: "failed" };
}
