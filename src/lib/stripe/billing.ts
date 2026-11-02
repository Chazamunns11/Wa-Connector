import { stripeConfig, stripeRequest, type StripeResult } from "./client";
import { FIRST_TIER_NUMBERS, LATER_PRICE_PER_NUMBER_PENCE, PRICE_PER_NUMBER_PENCE, TRIAL_DAYS, CURRENCY } from "../pricing";

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
  /** `subscription` for signup and restarts, `setup` for "Add a card". */
  mode: string | null;
  customer: string | null;
  subscription: StripeSubscription | null;
  /** The payment method a setup-mode session saved (from the expanded setup_intent). */
  setupPaymentMethod: string | null;
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
  const setupIntent = o.setup_intent as { payment_method?: unknown } | null | undefined;
  return {
    id,
    status: str(o.status),
    mode: str(o.mode),
    customer: idOf(o.customer),
    subscription: parseSubscription(o.subscription),
    setupPaymentMethod: setupIntent && typeof setupIntent === "object" ? idOf(setupIntent.payment_method) : null,
    metadata: stringMap(o.metadata),
  };
}

function mapData<A, B>(r: StripeResult<A>, fn: (a: A) => B | null): StripeResult<B> {
  if (!r.ok) return r;
  const b = fn(r.data);
  return b === null ? { ok: false, status: 502, code: null, message: "unexpected Stripe response" } : { ok: true, data: b };
}

export async function createCheckoutSession(
  input: {
    accountId: string;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    /** Default true. False bills straight away (restarts never get a second trial). */
    trial?: boolean;
    /** Re-use this Stripe customer instead of creating one from the email. */
    customerId?: string;
  },
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string; url: string }>> {
  const cfg = stripeConfig();
  const trial = input.trial !== false;
  const params: Record<string, unknown> = {
    mode: "subscription",
    ...(input.customerId ? { customer: input.customerId } : { customer_email: input.customerEmail }),
    client_reference_id: input.accountId,
    line_items: [{ price: cfg.priceId, quantity: 1 }],
    // Nov 2026 (Charlie: "it must charge"): the trial TAKES A CARD at checkout
    // and Stripe charges it automatically on day 7. `pause` stays as a safety
    // net for a card later removed: then sending stops until one is added.
    subscription_data: trial
      ? {
          trial_period_days: TRIAL_DAYS,
          trial_settings: { end_behavior: { missing_payment_method: "pause" } },
          metadata: { account_id: input.accountId },
        }
      : { metadata: { account_id: input.accountId } },
    metadata: { account_id: input.accountId, owner_email: input.customerEmail },
    // Always collect a card: a trial is charged on day 7, a restart today.
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

/**
 * "Add a card": a setup-mode Checkout on the account's existing customer. It
 * only saves a card; the webhook then makes it the default and, if the trial
 * ended without one, resumes the paused subscription. The Customer Portal is
 * not used for this because adding a card there does not resume a paused
 * subscription.
 */
export async function createCardSetupSession(
  input: {
    accountId: string;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    /** Set when the card is added to end the trial straight away ("Start my paid plan now"). */
    then?: "end_trial";
  },
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string; url: string }>> {
  const metadata = { account_id: input.accountId, purpose: "add_card", ...(input.then ? { then: input.then } : {}) };
  const r = await req(deps)<{ id?: unknown; url?: unknown }>("POST", "/checkout/sessions", {
    mode: "setup",
    customer: input.customerId,
    payment_method_types: ["card"],
    client_reference_id: input.accountId,
    metadata,
    setup_intent_data: { metadata },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  return mapData(r, (d) => (typeof d.id === "string" && typeof d.url === "string" ? { id: d.id, url: d.url } : null));
}

export async function retrieveCheckoutSession(id: string, deps?: BillingDeps): Promise<StripeResult<StripeCheckoutSession>> {
  const r = await req(deps)<unknown>("GET", `/checkout/sessions/${id}`, {
    expand: ["subscription", "subscription.default_payment_method", "setup_intent"],
  });
  return mapData(r, parseCheckoutSession);
}

export async function retrieveSubscription(id: string, deps?: BillingDeps): Promise<StripeResult<StripeSubscription>> {
  const r = await req(deps)<unknown>("GET", `/subscriptions/${id}`, { expand: ["default_payment_method"] });
  return mapData(r, parseSubscription);
}

/**
 * Set the number of billed WhatsApp numbers. Nov 2026 (Charlie: "a new
 * invoice per change, so nobody reaches month end owing loads"):
 *   - `always_invoice`: Stripe invoices the prorated difference IMMEDIATELY,
 *     instead of saving it up for the next monthly invoice
 *     (docs.stripe.com/billing/subscriptions/prorations). A decrease becomes
 *     a credit on the customer's balance, used against the next invoice.
 *   - `refuseIfUnpaid` (for an increase the customer asked for: activating a
 *     sub-account, adding a number): `payment_behavior: error_if_incomplete`,
 *     so if that invoice cannot be paid Stripe returns an error and does NOT
 *     change the quantity (docs.stripe.com/api/subscription_items/update).
 *     The caller then refuses the change. Re-syncs use `allow_incomplete`:
 *     they correct the count and must never be blocked by a card.
 */
export async function setSubscriptionItemQuantity(
  itemId: string,
  quantity: number,
  deps?: BillingDeps,
  opts: { refuseIfUnpaid?: boolean } = {},
): Promise<StripeResult<{ id: string; quantity: number }>> {
  const r = await req(deps)<{ id?: unknown; quantity?: unknown }>("POST", `/subscription_items/${itemId}`, {
    quantity,
    proration_behavior: "always_invoice",
    payment_behavior: opts.refuseIfUnpaid ? "error_if_incomplete" : "allow_incomplete",
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

/** Makes a saved card the customer's default for invoices (what a resume charges). */
export async function setCustomerDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string,
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string }>> {
  const r = await req(deps)<{ id?: unknown }>("POST", `/customers/${customerId}`, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  return mapData(r, (d) => (typeof d.id === "string" ? { id: d.id } : null));
}

/** Makes a saved card the subscription's own default (what the billing page shows). */
export async function setSubscriptionDefaultPaymentMethod(
  subscriptionId: string,
  paymentMethodId: string,
  deps?: BillingDeps,
): Promise<StripeResult<StripeSubscription>> {
  const r = await req(deps)<unknown>("POST", `/subscriptions/${subscriptionId}`, {
    default_payment_method: paymentMethodId,
    expand: ["default_payment_method"],
  });
  return mapData(r, parseSubscription);
}

/**
 * Resumes a subscription Stripe paused because the trial ended with no card.
 * The billing period restarts today and the first invoice is charged now.
 */
export async function resumeSubscription(subscriptionId: string, deps?: BillingDeps): Promise<StripeResult<StripeSubscription>> {
  const r = await req(deps)<unknown>("POST", `/subscriptions/${subscriptionId}/resume`, { billing_cycle_anchor: "now" });
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
 * The Stripe Price the app expects behind STRIPE_PRICE_ID (Nov 2026): a
 * monthly GRADUATED price per connected WhatsApp number (the quantity, set
 * by src/lib/billing/quantity.ts): numbers 1-10 at 999p each, and each
 * number from the 11th at 799p. Used by the go-live checklist to
 * create the Price; the app itself only needs STRIPE_PRICE_ID.
 */
export function stripeNumberPrice() {
  return {
    currency: CURRENCY.toLowerCase(),
    billing_scheme: "tiered" as const,
    tiers_mode: "graduated" as const,
    tiers: [
      { up_to: FIRST_TIER_NUMBERS, unit_amount: PRICE_PER_NUMBER_PENCE },
      { up_to: "inf" as const, unit_amount: LATER_PRICE_PER_NUMBER_PENCE },
    ],
    recurring: { interval: "month" as const },
  };
}
