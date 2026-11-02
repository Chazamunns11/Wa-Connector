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
  "recordStripeEvent" | "deleteStripeEvent" | "getAccountById" | "getAccountByStripeCustomerId" | "getGhlAccountByLocationId" | "getNumberBilling" | "updateNumberBilling"
>;

export interface WebhookDeps {
  /** "Save a card" (setup-mode Checkout): make it the default, mark the account as having a card, resume paused numbers. */
  applyCardSetup: (session: StripeCheckoutSession) => Promise<unknown>;
  retrieveCheckoutSession: typeof retrieveCheckoutSession;
  retrieveSubscription: typeof retrieveSubscription;
  /** Re-prices the account's number subscriptions when its billed count moved tier. */
  syncPrices: (account: Account) => Promise<unknown>;
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
 * returns `duplicate` before any side effect. A number's `billing_status` is
 * only ever written from a Stripe subscription object, mapped through the
 * status map; an unmapped status leaves the number untouched.
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
      // Never trust the event body: fetch the session fresh and expanded.
      const fetched = await deps.retrieveCheckoutSession(id);
      if (!fetched.ok) throw new Error(`checkout session ${id} could not be retrieved: ${fetched.message}`);
      // This app only creates setup-mode sessions; number subscriptions are created by the API, not Checkout.
      if (fetched.data.mode !== "setup") return { kind: "ignored", type: event.type };
      await deps.applyCardSetup(fetched.data);
      return { kind: "handled", type: event.type };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    // A trial that ends with no card pauses the subscription; adding one resumes it.
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const raw = event.data.object;
      const sub = parseSubscription({ ...raw, items: (raw.items as { data?: unknown } | undefined) ?? { data: [] } });
      if (!sub) return { kind: "ignored", type: event.type };
      // Every subscription this app creates is one number's, tagged with its tenant.
      const tenantId = sub.metadata.tenant_id;
      if (!tenantId) return { kind: "ignored", type: event.type };
      const number = await repo.getNumberBilling(tenantId);
      if (!number) {
        // The number was removed. Its subscription was cancelled then; say so if it somehow still runs.
        if (mapStripeSubscriptionStatus(sub.status) !== "cancelled") {
          deps.notify(`Stripe subscription ${sub.id} is ${sub.status} but its number no longer exists: cancel it by hand`);
        }
        return { kind: "ignored", type: event.type };
      }
      if (number.stripeSubscriptionId === null) {
        // One the create call cancelled after its row write failed: nothing to record.
        if (mapStripeSubscriptionStatus(sub.status) === "cancelled") return { kind: "ignored", type: event.type };
        // Created but not yet recorded (the create call is still writing the row): retry later.
        throw new Error(`subscription ${sub.id} arrived before its number recorded it`);
      }
      if (number.stripeSubscriptionId !== sub.id) {
        // An older, replaced subscription must not overwrite the current one.
        if (mapStripeSubscriptionStatus(sub.status) !== "cancelled") {
          deps.notify(`Stripe subscription ${sub.id} is ${sub.status} but is not its number's current one: cancel it by hand`);
        }
        return { kind: "ignored", type: event.type };
      }
      // Events can arrive out of order: apply the subscription's current state, never the event body's.
      const fetchedSub = await deps.retrieveSubscription(sub.id);
      if (!fetchedSub.ok) throw new Error(`subscription ${sub.id} could not be retrieved: ${fetchedSub.message}`);
      const live = fetchedSub.data;
      const status = mapStripeSubscriptionStatus(live.status);
      if (status === null) return { kind: "handled", type: event.type };
      await repo.updateNumberBilling(tenantId, {
        billingStatus: status,
        // Kept for a trial that ended with no card (Stripe `paused`), so the dashboard can say the trial ended.
        trialEndsAt: status === "trialing" || live.status === "paused" ? iso(live.trialEnd) : null,
        pricePence: live.unitAmount,
        // Starts the 14-day credential cleanup grace (src/lib/billing/cleanup.ts); ended_at is when it actually ended.
        ...(status === "cancelled" && !number.cancelledAt ? { cancelledAt: iso(live.endedAt) ?? new Date().toISOString() } : {}),
      });
      // The billed count may have moved tier (e.g. Stripe cancelled an unpaid number): re-price the rest.
      const location = await repo.getGhlAccountByLocationId(number.locationId);
      const account = location?.accountId ? await repo.getAccountById(location.accountId) : null;
      if (!account) {
        deps.notify(`Stripe ${event.type} for a number with no owning account`);
        return { kind: "unknown_account", type: event.type };
      }
      if (number.billingStatus !== status) await deps.syncPrices(account);
      return { kind: "handled", type: event.type };
    }
    case "invoice.payment_failed": {
      // The banner state comes from the number's subscription turning past_due (above);
      // this just tells the operator which customer to chase. The Stripe account is shared with
      // the CRM business, so only this app's own customers raise an alert.
      const cus = customerId(event.data.object.customer);
      if (!cus || !(await repo.getAccountByStripeCustomerId(cus))) return { kind: "ignored", type: event.type };
      deps.notify(`Stripe payment failed for customer ${cus}`);
      return { kind: "handled", type: event.type };
    }
    default:
      return { kind: "ignored", type: event.type };
  }
}
