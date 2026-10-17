import type { GhlRepository } from "@/lib/data/repository";
import type {
  endTrialNow,
  resumeSubscription,
  retrieveSubscription,
  setCustomerDefaultPaymentMethod,
  setSubscriptionDefaultPaymentMethod,
  StripeCheckoutSession,
} from "@/lib/stripe/billing";

export interface CardSetupDeps {
  retrieveSubscription: typeof retrieveSubscription;
  setCustomerDefault: typeof setCustomerDefaultPaymentMethod;
  setSubscriptionDefault: typeof setSubscriptionDefaultPaymentMethod;
  resume: typeof resumeSubscription;
  endTrial: typeof endTrialNow;
}

export type CardSetupOutcome =
  | { kind: "ignored" }
  | { kind: "unknown_account" }
  | { kind: "saved" }
  | { kind: "resumed" }
  | { kind: "trial_ended" };

const fail = (what: string, message: string): never => {
  throw new Error(`card setup: ${what} failed: ${message}`);
};

/**
 * Applies a completed "Add a card" (setup-mode Checkout). The account comes
 * from the session's metadata and the customer and subscription from the
 * account row, never from the event body. Order matters for a paused
 * subscription: the customer default first (a resume charges it), then the
 * resume, then the subscription's own default. billing_status is not written
 * here: Stripe's `customer.subscription.resumed` / `updated` event does that.
 * Safe to replay: each step is idempotent on Stripe's side, and a subscription
 * that is no longer paused is not resumed again.
 */
export async function applyCardSetup(
  repo: Pick<GhlRepository, "getAccountById">,
  deps: CardSetupDeps,
  session: StripeCheckoutSession,
): Promise<CardSetupOutcome> {
  if (session.mode !== "setup" || session.status !== "complete" || session.metadata.purpose !== "add_card") return { kind: "ignored" };
  const pm = session.setupPaymentMethod;
  const accountId = session.metadata.account_id;
  if (!pm || !accountId) return { kind: "ignored" };
  const account = await repo.getAccountById(accountId);
  if (!account || !account.stripeCustomerId || !account.stripeSubscriptionId) return { kind: "unknown_account" };
  // A session for another customer can never move this account's card.
  if (session.customer && session.customer !== account.stripeCustomerId) return { kind: "ignored" };
  const subId = account.stripeSubscriptionId;

  const c = await deps.setCustomerDefault(account.stripeCustomerId, pm);
  if (!c.ok) fail("customer default", c.message);

  const live = await deps.retrieveSubscription(subId);
  if (!live.ok) return fail("retrieve subscription", live.message);

  let outcome: CardSetupOutcome = { kind: "saved" };
  if (live.data.status === "paused") {
    const r = await deps.resume(subId);
    if (!r.ok) fail("resume", r.message);
    outcome = { kind: "resumed" };
  }

  const s = await deps.setSubscriptionDefault(subId, pm);
  if (!s.ok) fail("subscription default", s.message);

  if (outcome.kind === "saved" && live.data.status === "trialing" && session.metadata.then === "end_trial") {
    const e = await deps.endTrial(subId);
    if (!e.ok) fail("end trial", e.message);
    outcome = { kind: "trial_ended" };
  }
  return outcome;
}
