import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import type { createCheckoutSession, StripeCheckoutSession } from "@/lib/stripe/billing";
import type { AccountKind } from "@/lib/account-data/types";
import type { SignupInput } from "@/lib/site/signup";
import { mapStripeSubscriptionStatus } from "./status";

export type OnboardRepo = Pick<
  GhlRepository,
  "getProfileByEmail" | "createAccount" | "createProfile" | "claimGhlAccount" | "getAccountById" | "updateAccountBilling"
>;

export interface OnboardDeps {
  checkout: typeof createCheckoutSession;
  appUrl: string;
  /** Verifies a signed claim token (first-wins, location-bound, 30-minute expiry). */
  verifyClaim: (token: string) => { locationId: string } | null;
}

export type SignupOutcome =
  | { kind: "checkout"; url: string }
  | { kind: "exists" }
  | { kind: "unavailable" }
  | { kind: "failed" };

/** The signup details parked in the user's metadata until the email is proven. */
export interface PendingSignup {
  accountName: string;
  kind: AccountKind;
  /** A signed claim token; verified (never trusted) when the account is created. */
  claim: string | null;
}

const KINDS: readonly AccountKind[] = ["agency", "business"];

/**
 * Reads the pending signup back out of auth user metadata. The user can edit
 * their own metadata, so this is display input only: name and kind. The claim
 * token proves itself by its signature.
 */
export function parsePendingSignup(meta: unknown): PendingSignup | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const accountName = typeof m.accountName === "string" ? m.accountName.trim() : "";
  if (accountName.length < 2 || accountName.length > 80) return null;
  if (!KINDS.includes(m.kind as AccountKind)) return null;
  const claim = typeof m.claim === "string" && m.claim.length > 0 && m.claim.length <= 200 ? m.claim : null;
  return { accountName, kind: m.kind as AccountKind, claim };
}

export type PrepareOutcome =
  | { kind: "send"; email: string; data: { accountName: string; kind: AccountKind; claim?: string } }
  | { kind: "exists" };

/**
 * Step 1 of signup. Creates NOTHING: it only checks the email is free and
 * returns what to put in the sign-in link's user metadata.
 */
export async function prepareSignup(
  repo: Pick<GhlRepository, "getProfileByEmail">,
  input: SignupInput & { claim?: string | null },
): Promise<PrepareOutcome> {
  const email = input.email.trim().toLowerCase();
  if (await repo.getProfileByEmail(email)) return { kind: "exists" };
  return {
    kind: "send",
    email,
    data: { accountName: input.accountName, kind: input.kind, ...(input.claim ? { claim: input.claim } : {}) },
  };
}

export type CallbackDecision = "owner" | "dashboard" | "complete_signup" | "reject";

/** Where a verified sign-in goes. An existing profile always wins over pending metadata. */
export function decideCallback(
  profile: { role: string; accountId: string | null } | null,
  pending: PendingSignup | null,
): CallbackDecision {
  if (profile?.role === "owner") return "owner";
  if (profile?.role === "account" && profile.accountId) return "dashboard";
  if (!profile && pending) return "complete_signup";
  return "reject";
}

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
 * Step 2, from /auth/callback once the emailed link has proven the address:
 * account (pending), profile, optional claim, then Checkout. The account is
 * bound to the verified email, never to anything typed. If Checkout fails the
 * account stays 'pending': signing in later offers "Add a card".
 */
export async function completeSignup(
  repo: OnboardRepo,
  deps: OnboardDeps,
  input: { userId: string; email: string; pending: PendingSignup },
): Promise<SignupOutcome> {
  const email = input.email.trim().toLowerCase();
  const account = await repo.createAccount({ name: input.pending.accountName, kind: input.pending.kind, ownerEmail: email });
  await repo.createProfile({ id: input.userId, role: "account", email, accountId: account.id });

  const locationId = input.pending.claim ? (deps.verifyClaim(input.pending.claim)?.locationId ?? null) : null;
  if (locationId) {
    try {
      await repo.claimGhlAccount(locationId, account.id);
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
