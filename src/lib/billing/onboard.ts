import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import type { createCheckoutSession, StripeCheckoutSession } from "@/lib/stripe/billing";
import type { AccountKind } from "@/lib/account-data/types";
import type { SignupInput } from "@/lib/site/signup";
import { signKindedState, verifyKindedState } from "@/lib/signed-state";
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

/** The signup details carried in the signed `wa_signup` cookie until the email is proven. */
export interface PendingSignup {
  accountName: string;
  kind: AccountKind;
  /** A signed claim token; verified (never trusted) when the account is created. */
  claim: string | null;
}

const KINDS: readonly AccountKind[] = ["agency", "business"];

/** Cookie holding the signed pending signup; scoped to the callback path. */
export const SIGNUP_COOKIE = "wa_signup";
export const SIGNUP_COOKIE_MAX_AGE_S = 60 * 60;

/** Signs the pending signup, bound to the address the link is sent to. */
export function signSignupToken(email: string, pending: PendingSignup): string {
  return signKindedState(
    "signup",
    {
      email: email.trim().toLowerCase(),
      accountName: pending.accountName,
      kind: pending.kind,
      ...(pending.claim ? { claim: pending.claim } : {}),
      iat: Date.now(),
    },
    SIGNUP_COOKIE_MAX_AGE_S * 1000,
  );
}

/**
 * Reads the pending signup from the signed cookie. Null unless the signature,
 * kind and expiry hold AND the token was minted for the verified user's email.
 * Supabase user metadata is never consulted: anyone can pre-set it.
 */
export function pendingFromSignupToken(token: string | undefined, verifiedEmail: string | undefined): PendingSignup | null {
  if (!token || !verifiedEmail) return null;
  const d = verifyKindedState("signup", token);
  if (!d) return null;
  if (typeof d.email !== "string" || d.email !== verifiedEmail.trim().toLowerCase()) return null;
  const accountName = typeof d.accountName === "string" ? d.accountName.trim() : "";
  if (accountName.length < 2 || accountName.length > 80) return null;
  if (!KINDS.includes(d.kind as AccountKind)) return null;
  const claim = typeof d.claim === "string" && d.claim.length > 0 && d.claim.length <= 200 ? d.claim : null;
  return { accountName, kind: d.kind as AccountKind, claim };
}

export type PrepareOutcome = { kind: "send"; email: string; pending: PendingSignup } | { kind: "exists" };

/**
 * Step 1 of signup. Creates NOTHING: it only checks the email is free and
 * returns the pending signup to sign into the cookie.
 */
export async function prepareSignup(
  repo: Pick<GhlRepository, "getProfileByEmail">,
  input: SignupInput & { claim?: string | null },
): Promise<PrepareOutcome> {
  const email = input.email.trim().toLowerCase();
  if (await repo.getProfileByEmail(email)) return { kind: "exists" };
  return { kind: "send", email, pending: { accountName: input.accountName, kind: input.kind, claim: input.claim || null } };
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
