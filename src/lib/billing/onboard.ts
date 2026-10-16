import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import type { createCheckoutSession, StripeCheckoutSession } from "@/lib/stripe/billing";
import type { SignupInput } from "@/lib/site/signup";
import { mapStripeSubscriptionStatus } from "./status";

export type OnboardRepo = Pick<
  GhlRepository,
  "getProfileByEmail" | "createAccount" | "createProfile" | "claimGhlAccount" | "getAccountById" | "updateAccountBilling"
>;

export interface OnboardDeps {
  createAuthUser: (email: string) => Promise<{ id: string } | { error: "exists" | "failed" }>;
  checkout: typeof createCheckoutSession;
  appUrl: string;
}

export type SignupOutcome =
  | { kind: "checkout"; url: string }
  | { kind: "exists" }
  | { kind: "unavailable" }
  | { kind: "failed" };

/**
 * Creates (or re-uses) the Checkout for an existing account. The success URL
 * keeps Stripe's literal `{CHECKOUT_SESSION_ID}` placeholder.
 */
export async function createCheckoutForAccount(
  _repo: unknown,
  deps: Pick<OnboardDeps, "checkout" | "appUrl">,
  account: Account,
): Promise<SignupOutcome> {
  // Anyone who has had a Stripe subscription before restarts without a trial.
  const restart = account.billingStatus === "cancelled" || !!account.stripeSubscriptionId || !!account.stripeCustomerId;
  const r = await deps.checkout({
    trial: !restart,
    ...(account.stripeCustomerId ? { customerId: account.stripeCustomerId } : {}),
    accountId: account.id,
    customerEmail: account.ownerEmail,
    successUrl: `${deps.appUrl}/signup/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${deps.appUrl}/login?error=checkout`,
  });
  return r.ok ? { kind: "checkout", url: r.data.url } : { kind: "failed" };
}

/**
 * Auth user, then account, then profile, then Checkout. If Checkout fails the
 * account stays 'pending': signing in later offers "Add a card".
 */
export async function startSignup(
  repo: OnboardRepo,
  deps: OnboardDeps,
  input: SignupInput & { claimLocationId: string | null },
): Promise<SignupOutcome> {
  const email = input.email.trim().toLowerCase();
  if (await repo.getProfileByEmail(email)) return { kind: "exists" };

  const user = await deps.createAuthUser(email);
  if ("error" in user) return { kind: user.error === "exists" ? "exists" : "failed" };

  const account = await repo.createAccount({ name: input.accountName, kind: input.kind, ownerEmail: email });
  await repo.createProfile({ id: user.id, role: "account", email, accountId: account.id });

  if (input.claimLocationId) {
    try {
      await repo.claimGhlAccount(input.claimLocationId, account.id);
    } catch {
      // A failed claim never blocks signup; the owner can link from the dashboard.
    }
  }
  return createCheckoutForAccount(repo, deps, account);
}

/**
 * Writes the facts of a completed Checkout onto its account. Idempotent: the
 * webhook and /signup/complete both call it, in either order.
 */
export async function applyCheckoutSession(
  repo: Pick<GhlRepository, "getAccountById" | "updateAccountBilling">,
  session: StripeCheckoutSession,
): Promise<{ applied: boolean; accountId: string | null }> {
  const accountId = session.metadata.account_id ?? null;
  const sub = session.subscription;
  if (session.status !== "complete" || !accountId || !sub) return { applied: false, accountId };
  const account = await repo.getAccountById(accountId);
  if (!account) return { applied: false, accountId };
  await repo.updateAccountBilling(accountId, {
    stripeCustomerId: session.customer ?? sub.customer,
    stripeSubscriptionId: sub.id,
    billingStatus: mapStripeSubscriptionStatus(sub.status) ?? account.billingStatus,
    trialEndsAt: sub.trialEnd ? new Date(sub.trialEnd * 1000).toISOString() : null,
    // A restarted subscription on a cancelled account must not be cleaned up again.
    ...(account.billingStatus === "cancelled" ? { cancelledAt: null, cleanedUpAt: null } : {}),
  });
  return { applied: true, accountId };
}
