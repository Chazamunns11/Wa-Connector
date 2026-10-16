import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";
import { parseSubscription, type StripeCheckoutSession, type retrieveCheckoutSession, type retrieveSubscription } from "@/lib/stripe/billing";
import { mapStripeSubscriptionStatus } from "@/lib/billing/status";

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export type WebhookRepo = Pick<
  GhlRepository,
  "recordStripeEvent" | "deleteStripeEvent" | "getAccountById" | "getAccountByStripeCustomerId" | "updateAccountBilling"
>;

export interface WebhookDeps {
  applyCheckout: (session: StripeCheckoutSession) => Promise<unknown>;
  retrieveCheckoutSession: typeof retrieveCheckoutSession;
  retrieveSubscription: typeof retrieveSubscription;
  syncQuantity: (account: Account) => Promise<unknown>;
  notify: (text: string) => void;
}

export type WebhookOutcome =
  | { kind: "duplicate" }
  | { kind: "ignored"; type: string }
  | { kind: "handled"; type: string }
  | { kind: "unknown_account"; type: string };

const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());

function customerId(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string") return (raw as { id: string }).id;
  return null;
}

/**
 * Applies one verified Stripe event. Idempotent on the event id: a replay
 * returns `duplicate` before any side effect. `billing_status` is only ever
 * written from a Stripe subscription object, mapped through the status map;
 * an unmapped status (e.g. `incomplete`) leaves the account untouched.
 */
export async function handleBillingEvent(repo: WebhookRepo, deps: WebhookDeps, event: StripeEvent): Promise<WebhookOutcome> {
  if (!(await repo.recordStripeEvent(event.id, event.type))) return { kind: "duplicate" };
  try {
    return await processEvent(repo, deps, event);
  } catch (err) {
    // Release the id so Stripe's retry is processed rather than dropped as a duplicate.
    try {
      await repo.deleteStripeEvent(event.id);
    } catch {
      // If even this fails the original error still surfaces as a 500.
    }
    throw err;
  }
}

async function processEvent(repo: WebhookRepo, deps: WebhookDeps, event: StripeEvent): Promise<WebhookOutcome> {
  switch (event.type) {
    case "checkout.session.completed": {
      const id = event.data.object.id;
      if (typeof id !== "string") return { kind: "ignored", type: event.type };
      // Never trust the event body's subscription: fetch the session fresh and expanded.
      const fetched = await deps.retrieveCheckoutSession(id);
      if (!fetched.ok) throw new Error(`checkout session ${id} could not be retrieved: ${fetched.message}`);
      await deps.applyCheckout(fetched.data);
      const accountId = fetched.data.metadata.account_id;
      const account = accountId ? await repo.getAccountById(accountId) : null;
      if (!account) {
        deps.notify(`Stripe checkout ${id} completed for an unknown account`);
        return { kind: "unknown_account", type: event.type };
      }
      await deps.syncQuantity(account);
      return { kind: "handled", type: event.type };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const raw = event.data.object;
      const sub = parseSubscription({ ...raw, items: (raw.items as { data?: unknown } | undefined) ?? { data: [] } });
      if (!sub) return { kind: "ignored", type: event.type };
      const accountId = sub.metadata.account_id;
      const account = accountId ? await repo.getAccountById(accountId) : await repo.getAccountByStripeCustomerId(sub.customer);
      if (!account) {
        deps.notify(`Stripe ${event.type} for unknown customer ${sub.customer}`);
        return { kind: "unknown_account", type: event.type };
      }
      // A subscription other than the account's current one (e.g. a replaced, cancelled one) must not overwrite it.
      if (account.stripeSubscriptionId && account.stripeSubscriptionId !== sub.id) return { kind: "ignored", type: event.type };
      // Events can arrive out of order: apply the subscription's current state, never the event body's.
      const fetchedSub = await deps.retrieveSubscription(sub.id);
      if (!fetchedSub.ok) throw new Error(`subscription ${sub.id} could not be retrieved: ${fetchedSub.message}`);
      const live = fetchedSub.data;
      const status = mapStripeSubscriptionStatus(live.status);
      if (status === null) return { kind: "handled", type: event.type };
      await repo.updateAccountBilling(account.id, {
        billingStatus: status,
        trialEndsAt: status === "trialing" ? iso(live.trialEnd) : null,
        cancelledAt: status === "cancelled" ? (iso(live.canceledAt) ?? new Date().toISOString()) : null,
        stripeSubscriptionId: sub.id,
      });
      return { kind: "handled", type: event.type };
    }
    case "invoice.payment_failed": {
      // The banner state comes from the subscription turning past_due (above);
      // this just tells the operator which customer to chase.
      deps.notify(`Stripe payment failed for customer ${customerId(event.data.object.customer) ?? "unknown"}`);
      return { kind: "handled", type: event.type };
    }
    default:
      return { kind: "ignored", type: event.type };
  }
}
