/**
 * Which in-GoHighLevel state the embed shows for an installed location.
 * Pure (no Next imports) so `node --test` covers it. The route calls it after
 * the `not_installed` check.
 */
import type { BillingStatus, GhlAccount, NumberBilling } from "@/lib/types";

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

/** Account statuses that let the embed open. Per-number billing is checked when sending (`sendingGate`, src/lib/billing/gate.ts) and when adding a number. */
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

/** Why one number can't send for billing reasons, or null when it can. */
export type NumberBillingPaused = null | "paused" | "trial_ended";

/**
 * Per-number billing (0020): a number sends only while its own subscription is
 * trialing, active or past due (`sendingGate`). A comped account never touches
 * Stripe, so its numbers are never paused. A Stripe `paused` number that kept
 * its trial end is one whose trial ended with no usable card.
 */
export function numberBillingPaused(
  owner: BillingStatus | null,
  number: Pick<NumberBilling, "billingStatus" | "trialEndsAt"> | null,
): NumberBillingPaused {
  if (owner === "comped") return null;
  const status = number?.billingStatus ?? null;
  if (status === "trialing" || status === "active" || status === "past_due") return null;
  return status === "paused" && number?.trialEndsAt ? "trial_ended" : "paused";
}

/**
 * The whole embed shows "billing paused" only when NONE of the location's
 * numbers can send; the reason is "trial ended" only if that is true of every
 * one. Otherwise each paused number is marked on its own card. Null = carry on.
 */
export function embedStateForNumbers(numbers: { billingPaused: NumberBillingPaused }[]): EmbedState | null {
  if (numbers.length === 0 || numbers.some((n) => n.billingPaused === null)) return null;
  return numbers.every((n) => n.billingPaused === "trial_ended") ? { state: "billing_paused", reason: "trial_ended" } : { state: "billing_paused" };
}
