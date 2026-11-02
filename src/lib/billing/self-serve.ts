import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import type { createCardSetupSession, createCustomer, createPortalSession } from "@/lib/stripe/billing";
import { hasCardOnFile } from "./activation";
import { createCheckoutForAccount } from "./onboard";

/**
 * Decisions behind the billing page's buttons. Each takes the account row the
 * server action loaded from the session, never an id from the form.
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

export type AddCardOutcome = { kind: "redirect"; url: string } | { kind: "not_needed" } | { kind: "failed" };

/**
 * "Add a card" for an account that already has one on file: a setup-mode
 * Checkout on its own customer, offered when a number stopped sending because
 * its trial ended with no usable card (Stripe `paused`). Saving resumes those
 * numbers. Accounts with no card yet use `startCheckoutFlow`.
 */
export async function addCardFlow(
  account: Account,
  deps: { appUrl: string; setup: typeof createCardSetupSession },
): Promise<AddCardOutcome> {
  if (account.billingStatus !== "active" || !account.stripeCustomerId) return { kind: "not_needed" };
  const r = await deps.setup({
    accountId: account.id,
    customerId: account.stripeCustomerId,
    successUrl: `${deps.appUrl}/dashboard/billing?result=card_added`,
    cancelUrl: `${deps.appUrl}/dashboard/billing`,
  });
  return r.ok ? { kind: "redirect", url: r.data.url } : { kind: "failed" };
}

export type CheckoutOutcome = { kind: "redirect"; url: string } | { kind: "not_pending" } | { kind: "failed" };

/** No card on file yet (signup Checkout abandoned, a returning cancelled account, or an old-model status): open the save-a-card Checkout. */
export async function startCheckoutFlow(
  repo: Pick<GhlRepository, "updateAccountBilling">,
  account: Account,
  deps: { appUrl: string; createCustomer: typeof createCustomer; setup: typeof createCardSetupSession },
): Promise<CheckoutOutcome> {
  if (hasCardOnFile(account.billingStatus)) return { kind: "not_pending" };
  const o = await createCheckoutForAccount(repo, deps, account);
  return o.kind === "checkout" ? { kind: "redirect", url: o.url } : { kind: "failed" };
}
