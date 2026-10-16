/**
 * Which in-GoHighLevel state the embed shows for an installed location.
 * Pure (no Next imports) so `node --test` covers it. The route calls it after
 * the `not_installed` check.
 */
import type { BillingStatus, GhlAccount } from "@/lib/types";

export type EmbedState =
  | { state: "disabled" }
  | { state: "unclaimed"; claimUrl: string | null }
  | { state: "billing_paused" }
  | { state: "not_activated" }
  | { state: "ok" };

/** Billing statuses that may send; mirrors `sendingGate` in `src/lib/billing/gate.ts`. */
const LIVE: ReadonlySet<BillingStatus> = new Set(["trialing", "active", "past_due", "comped"]);

export function embedStateFor(account: GhlAccount, billing: BillingStatus | null, claimUrl: string | null): EmbedState {
  if (account.status === "disabled") return { state: "disabled" };
  if (!account.accountId) return { state: "unclaimed", claimUrl };
  if (billing === null || !LIVE.has(billing)) return { state: "billing_paused" };
  if (!account.activatedAt) return { state: "not_activated" };
  return { state: "ok" };
}
