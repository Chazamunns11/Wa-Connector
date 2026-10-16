import { stripeConfig, stripeRequest, type StripeResult } from "./client";
import { STANDARD_PENCE, VOLUME_PENCE, VOLUME_FROM, TRIAL_DAYS, CURRENCY } from "../pricing";

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  trialEnd: number | null;
  canceledAt: number | null;
  endedAt: number | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  itemId: string | null;
  quantity: number;
  cardLast4: string | null;
  metadata: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  status: string | null;
  customer: string | null;
  subscription: StripeSubscription | null;
  metadata: Record<string, string>;
}

export interface BillingDeps {
  request?: typeof stripeRequest;
}

const req = (deps?: BillingDeps) => deps?.request ?? stripeRequest;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" ? str((v as { id?: unknown }).id) : null;

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
  }
  return out;
}

/** Narrow a raw Stripe subscription object; null when unusable. */
export function parseSubscription(raw: unknown): StripeSubscription | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  const status = str(o.status);
  const customer = idOf(o.customer);
  const items = (o.items as { data?: unknown } | undefined)?.data;
  if (!id || !status || !customer || !Array.isArray(items)) return null;
  const first = (items[0] ?? null) as { id?: unknown; quantity?: unknown } | null;
  const card = (o.default_payment_method as { card?: { last4?: unknown } } | null | undefined)?.card;
  return {
    id,
    status,
    customer,
    trialEnd: num(o.trial_end),
    canceledAt: num(o.canceled_at),
    endedAt: num(o.ended_at),
    cancelAtPeriodEnd: o.cancel_at_period_end === true,
    currentPeriodEnd: num(o.current_period_end),
    itemId: str(first?.id),
    quantity: num(first?.quantity) ?? 0,
    cardLast4: str(card?.last4),
    metadata: stringMap(o.metadata),
  };
}

function parseCheckoutSession(raw: unknown): StripeCheckoutSession | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    status: str(o.status),
    customer: idOf(o.customer),
    subscription: parseSubscription(o.subscription),
    metadata: stringMap(o.metadata),
  };
}

function mapData<A, B>(r: StripeResult<A>, fn: (a: A) => B | null): StripeResult<B> {
  if (!r.ok) return r;
  const b = fn(r.data);
  return b === null ? { ok: false, status: 502, code: null, message: "unexpected Stripe response" } : { ok: true, data: b };
}

export async function createCheckoutSession(
  input: { accountId: string; customerEmail: string; successUrl: string; cancelUrl: string },
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string; url: string }>> {
  const cfg = stripeConfig();
  const params: Record<string, unknown> = {
    mode: "subscription",
    customer_email: input.customerEmail,
    client_reference_id: input.accountId,
    line_items: [{ price: cfg.priceId, quantity: 1 }],
    subscription_data: { trial_period_days: TRIAL_DAYS, metadata: { account_id: input.accountId } },
    metadata: { account_id: input.accountId, owner_email: input.customerEmail },
    payment_method_collection: "always",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
  if (cfg.automaticTax) {
    params.automatic_tax = { enabled: true };
    params.customer_update = { address: "auto" };
  }
  const r = await req(deps)<{ id?: unknown; url?: unknown }>("POST", "/checkout/sessions", params);
  return mapData(r, (d) => (typeof d.id === "string" && typeof d.url === "string" ? { id: d.id, url: d.url } : null));
}

export async function retrieveCheckoutSession(id: string, deps?: BillingDeps): Promise<StripeResult<StripeCheckoutSession>> {
  const r = await req(deps)<unknown>("GET", `/checkout/sessions/${id}`, {
    expand: ["subscription", "subscription.default_payment_method"],
  });
  return mapData(r, parseCheckoutSession);
}

export async function retrieveSubscription(id: string, deps?: BillingDeps): Promise<StripeResult<StripeSubscription>> {
  const r = await req(deps)<unknown>("GET", `/subscriptions/${id}`, { expand: ["default_payment_method"] });
  return mapData(r, parseSubscription);
}

export async function setSubscriptionItemQuantity(
  itemId: string,
  quantity: number,
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string; quantity: number }>> {
  const r = await req(deps)<{ id?: unknown; quantity?: unknown }>("POST", `/subscription_items/${itemId}`, {
    quantity,
    proration_behavior: "create_prorations",
  });
  return mapData(r, (d) => (typeof d.id === "string" ? { id: d.id, quantity: num(d.quantity) ?? quantity } : null));
}

export async function endTrialNow(subscriptionId: string, deps?: BillingDeps): Promise<StripeResult<StripeSubscription>> {
  const r = await req(deps)<unknown>("POST", `/subscriptions/${subscriptionId}`, {
    trial_end: "now",
    proration_behavior: "none",
  });
  return mapData(r, parseSubscription);
}

export async function createPortalSession(
  customerId: string,
  returnUrl: string,
  deps?: BillingDeps,
): Promise<StripeResult<{ url: string }>> {
  const r = await req(deps)<{ url?: unknown }>("POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
  return mapData(r, (d) => (typeof d.url === "string" ? { url: d.url } : null));
}

/**
 * The Stripe Price definition that implements W40 volume pricing, built from
 * the pricing constants (pence). Volume mode: the tier the total quantity
 * lands in prices every unit. Used by the go-live checklist to create the
 * Price; the app itself only needs STRIPE_PRICE_ID.
 */
export function stripeVolumeTiers() {
  return {
    currency: CURRENCY.toLowerCase(),
    billing_scheme: "tiered" as const,
    tiers_mode: "volume" as const,
    tiers: [
      { up_to: VOLUME_FROM - 1, unit_amount: STANDARD_PENCE },
      { up_to: "inf" as const, unit_amount: VOLUME_PENCE },
    ],
  };
}
