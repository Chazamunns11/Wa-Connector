import type { GhlRepository } from "@/lib/data/repository";
import { payWhatsDue, type ReactivateDeps } from "@/lib/billing/reactivate";
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
  settleInvoice: ReactivateDeps["settleInvoice"];
}

export type CardSetupOutcome =
  | { kind: "ignored" }
  | { kind: "unknown_account" }
  | { kind: "saved" }
  | { kind: "resumed" }
  | { kind: "trial_ended" }
  /** Unpaid or past due: the outstanding invoice was charged to the new card. */
  | { kind: "paid" }
  /** Unpaid or past due: the new card was saved but the outstanding invoice was declined. */
  | { kind: "payment_failed" };

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
 * that is no longer paused is not resumed again. An unpaid or past-due
 * subscription gets its latest invoice paid with the new card last
 * (`payWhatsDue`), and the account is switched back on at once; a paid
 * invoice is not charged twice on a replay.
 */
export async function applyCardSetup(
  repo: Pick<GhlRepository, "getAccountById" | "updateAccountBilling">,
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

  // Unpaid (retries ran out) or past due: a saved card alone does not restart
  // the subscription, the outstanding invoice must be paid. A decline is not an
  // error (Stripe must not replay the webhook for it): sending stays paused and
  // the daily reminder carries on.
  if (live.data.status === "unpaid" || live.data.status === "past_due") {
    const due = await payWhatsDue(repo, deps, account, pm);
    if (due !== "nothing_due") return { kind: due };
  }

  if (outcome.kind === "saved" && live.data.status === "trialing" && session.metadata.then === "end_trial") {
    const e = await deps.endTrial(subId);
    if (!e.ok) fail("end trial", e.message);
    outcome = { kind: "trial_ended" };
  }
  return outcome;
}
