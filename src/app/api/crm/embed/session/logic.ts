/**
 * Which in-GoHighLevel state the embed shows for an installed location.
 * Pure (no Next imports) so `node --test` covers it. The route calls it after
 * the `not_installed` check.
 */
import type { BillingStatus, GhlAccount } from "@/lib/types";

export type EmbedState =
  | { state: "disabled" }
  | { state: "unclaimed"; claimUrl: string | null }
  | { state: "billing_paused"; reason?: "trial_ended" }
  | { state: "not_activated" }
  | { state: "ok" };

export const EMBED_PAUSED_MESSAGE = "The account owner needs to update billing.";
export const EMBED_TRIAL_ENDED_MESSAGE = "The free trial has ended. The account owner needs to add a card to keep sending.";

/** The line under "Sending is paused" in the embed. */
export function embedPausedMessage(trialEnded: boolean): string {
  return trialEnded ? EMBED_TRIAL_ENDED_MESSAGE : EMBED_PAUSED_MESSAGE;
}

/** Billing statuses that may send; mirrors `sendingGate` in `src/lib/billing/gate.ts`. */
const LIVE: ReadonlySet<BillingStatus> = new Set(["trialing", "active", "past_due", "comped"]);

/**
 * `trialEndsAt` is the owning account's trial end. A Stripe `paused` account that
 * still has one is a trial that ended with no card (the dashboard's rule, see
 * `planStatus` in `src/lib/account-data/derive.ts`); `unpaid` has none.
 */
export function embedStateFor(
  account: GhlAccount,
  billing: BillingStatus | null,
  claimUrl: string | null,
  trialEndsAt: string | null = null,
): EmbedState {
  if (account.status === "disabled") return { state: "disabled" };
  if (!account.accountId) return { state: "unclaimed", claimUrl };
  if (billing === null || !LIVE.has(billing)) {
    return billing === "paused" && trialEndsAt ? { state: "billing_paused", reason: "trial_ended" } : { state: "billing_paused" };
  }
  if (!account.activatedAt) return { state: "not_activated" };
  return { state: "ok" };
}
