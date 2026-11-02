import type { GhlRepository } from "@/lib/data/repository";
import type { resumeSubscription, retrieveSubscription, setCustomerDefaultPaymentMethod, StripeCheckoutSession } from "@/lib/stripe/billing";

export interface CardSetupDeps {
  retrieveSubscription: typeof retrieveSubscription;
  setCustomerDefault: typeof setCustomerDefaultPaymentMethod;
  resume: typeof resumeSubscription;
}

export type CardSetupOutcome = { kind: "ignored" } | { kind: "unknown_account" } | { kind: "saved"; resumed: number };

const fail = (what: string, message: string): never => {
  throw new Error(`card setup: ${what} failed: ${message}`);
};

/**
 * Applies a completed "save a card" (setup-mode Checkout), at signup or from
 * the billing page. The account comes from the session's metadata and the
 * customer from the account row, never from the event body. The card becomes
 * the customer's default (what every number subscription charges) with its
 * billing address saved on the customer (for Stripe Tax), a `pending`
 * account becomes `active` (card on file: it may now add numbers), and any
 * number Stripe paused because its trial ended with no card is resumed (which
 * charges it now). Number statuses are not written here: Stripe's own
 * subscription events do that. Safe to replay: each step is idempotent, and a
 * subscription that is no longer paused is not resumed again.
 */
export async function applyCardSetup(
  repo: Pick<GhlRepository, "getAccountById" | "updateAccountBilling" | "listNumberBillingForAccount">,
  deps: CardSetupDeps,
  session: StripeCheckoutSession,
): Promise<CardSetupOutcome> {
  if (session.mode !== "setup" || session.status !== "complete" || session.metadata.purpose !== "add_card") return { kind: "ignored" };
  const pm = session.setupPaymentMethod;
  const accountId = session.metadata.account_id;
  if (!pm || !accountId) return { kind: "ignored" };
  const account = await repo.getAccountById(accountId);
  if (!account || !account.stripeCustomerId) return { kind: "unknown_account" };
  // A session for another customer can never move this account's card.
  if (session.customer && session.customer !== account.stripeCustomerId) return { kind: "ignored" };

  // The card's billing address goes on the customer too, so automatic tax can price number subscriptions.
  const c = await deps.setCustomerDefault(account.stripeCustomerId, pm, undefined, session.setupBillingAddress);
  if (!c.ok) fail("customer default", c.message);

  if (account.billingStatus !== "active" && account.billingStatus !== "comped") {
    await repo.updateAccountBilling(account.id, {
      billingStatus: "active",
      // A returning cancelled account must not be cleaned up again.
      ...(account.billingStatus === "cancelled" ? { cancelledAt: null, cleanedUpAt: null } : {}),
    });
  }

  let resumed = 0;
  for (const n of await repo.listNumberBillingForAccount(account.id)) {
    if (n.billingStatus !== "paused" || !n.stripeSubscriptionId) continue;
    const live = await deps.retrieveSubscription(n.stripeSubscriptionId);
    if (!live.ok) return fail("retrieve subscription", live.message);
    // `unpaid` is stored as paused too, but only Stripe `paused` can be resumed; an unpaid invoice is paid in the portal.
    if (live.data.status !== "paused") continue;
    const r = await deps.resume(n.stripeSubscriptionId);
    if (!r.ok) fail("resume", r.message);
    resumed += 1;
  }
  return { kind: "saved", resumed };
}
