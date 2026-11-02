import { stripeConfig, stripeRequest, type StripeResult } from "./client";
import { TRIAL_DAYS, CURRENCY } from "../pricing";

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
  /** The first item's unit price in pence (a number subscription has exactly one item). */
  unitAmount: number | null;
  cardLast4: string | null;
  metadata: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  status: string | null;
  /** Always `setup` for sessions this app creates ("save a card"). */
  mode: string | null;
  customer: string | null;
  /** The payment method a setup-mode session saved (from the expanded setup_intent). */
  setupPaymentMethod: string | null;
  /** The billing address entered on that card (`billing_address_collection: required`), in Stripe's shape. */
  setupBillingAddress: Record<string, string> | null;
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
  const first = (items[0] ?? null) as { id?: unknown; quantity?: unknown; price?: { unit_amount?: unknown } | null } | null;
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
    unitAmount: num(first?.price?.unit_amount),
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
  const pm = setupIntent && typeof setupIntent === "object" ? (setupIntent.payment_method as { billing_details?: { address?: unknown } } | null) : null;
  const address = pm && typeof pm === "object" ? stringMap(pm.billing_details?.address) : {};
  return {
    id,
    status: str(o.status),
    mode: str(o.mode),
    customer: idOf(o.customer),
    setupPaymentMethod: setupIntent && typeof setupIntent === "object" ? idOf(setupIntent.payment_method) : null,
    setupBillingAddress: address.country ? address : null,
    metadata: stringMap(o.metadata),
  };
}

/** Inline monthly price for one number at `unitAmountPence`, against the one Stripe Product. */
function priceData(productId: string, unitAmountPence: number) {
  return { currency: CURRENCY.toLowerCase(), product: productId, unit_amount: unitAmountPence, recurring: { interval: "month" } };
}

function mapData<A, B>(r: StripeResult<A>, fn: (a: A) => B | null): StripeResult<B> {
  if (!r.ok) return r;
  const b = fn(r.data);
  return b === null ? { ok: false, status: 502, code: null, message: "unexpected Stripe response" } : { ok: true, data: b };
}

/**
 * "Save a card": a setup-mode Checkout on the account's customer, used at
 * signup and from the billing page. It only saves a card; the webhook then
 * makes it the customer's default (what every number subscription charges),
 * marks the account as having a card, and resumes any number paused because
 * its trial ended with no card. The Customer Portal is not used for this
 * because adding a card there does not resume a paused subscription.
 */
export async function createCardSetupSession(
  input: {
    accountId: string;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
  },
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string; url: string }>> {
  const metadata = { account_id: input.accountId, purpose: "add_card" };
  const r = await req(deps)<{ id?: unknown; url?: unknown }>("POST", "/checkout/sessions", {
    mode: "setup",
    customer: input.customerId,
    payment_method_types: ["card"],
    // Always collect the billing address. It lands on the card's billing
    // details and applyCardSetup copies it onto the customer, which is what
    // Stripe Tax reads when a number subscription is created
    // (STRIPE_AUTOMATIC_TAX). customer_update[address] is not used: Stripe
    // documents it for tax in payment/subscription Checkout, not setup mode.
    billing_address_collection: "required",
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
    expand: ["setup_intent", "setup_intent.payment_method"],
  });
  return mapData(r, parseCheckoutSession);
}

export async function retrieveSubscription(id: string, deps?: BillingDeps): Promise<StripeResult<StripeSubscription>> {
  const r = await req(deps)<unknown>("GET", `/subscriptions/${id}`, { expand: ["default_payment_method"] });
  return mapData(r, parseSubscription);
}

/**
 * One WhatsApp number's own subscription: one item priced inline at the
 * account's current tier (`unitAmountPence`) against STRIPE_PRODUCT_ID, so no
 * per-tier Price objects need creating by hand. With `trial` it runs
 * TRIAL_DAYS free and then charges the customer's default card; Stripe anchors
 * the monthly renewal to the trial end. A trial that ends with no card pauses
 * (sending stops) rather than invoicing. Without `trial` (a number that has had
 * a subscription before) the first month is charged now; a failed charge
 * leaves it `incomplete`, which may not send.
 */
export async function createNumberSubscription(
  input: { customerId: string; accountId: string; locationId: string; tenantId: string; unitAmountPence: number; trial: boolean },
  deps?: BillingDeps,
): Promise<StripeResult<StripeSubscription>> {
  const cfg = stripeConfig();
  const params: Record<string, unknown> = {
    customer: input.customerId,
    items: [{ price_data: priceData(cfg.productId, input.unitAmountPence) }],
    metadata: { account_id: input.accountId, location_id: input.locationId, tenant_id: input.tenantId },
    payment_behavior: "allow_incomplete",
    ...(input.trial
      ? { trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "pause" } } }
      : {}),
  };
  if (cfg.automaticTax) params.automatic_tax = { enabled: true };
  const r = await req(deps)<unknown>("POST", "/subscriptions", params);
  return mapData(r, parseSubscription);
}

/**
 * Moves a number's subscription item to a new tier price with NO proration:
 * the change shows from that subscription's next invoice (its trial-end charge
 * or next monthly renewal).
 */
export async function setSubscriptionItemPrice(
  itemId: string,
  unitAmountPence: number,
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string }>> {
  const r = await req(deps)<{ id?: unknown }>("POST", `/subscription_items/${itemId}`, {
    price_data: priceData(stripeConfig().productId, unitAmountPence),
    proration_behavior: "none",
  });
  return mapData(r, (d) => (typeof d.id === "string" ? { id: d.id } : null));
}

/**
 * Cancels a number's subscription now (the number was removed or its
 * sub-account deactivated). Same convention as the old quantity decrease:
 * immediate, with the unused part of the paid month prorated into a final
 * credit invoice that Stripe keeps as customer balance for the next charge.
 */
export async function cancelSubscription(subscriptionId: string, deps?: BillingDeps): Promise<StripeResult<StripeSubscription>> {
  const r = await req(deps)<unknown>("DELETE", `/subscriptions/${subscriptionId}`, { invoice_now: true, prorate: true });
  return mapData(r, parseSubscription);
}

/** A Stripe Customer for an account, created before its first card is saved. */
export async function createCustomer(
  input: { accountId: string; email: string },
  deps?: BillingDeps,
): Promise<StripeResult<{ id: string }>> {
  const r = await req(deps)<{ id?: unknown }>(
    "POST",
    "/customers",
    { email: input.email, metadata: { account_id: input.accountId } },
    { idempotencyKey: `customer-${input.accountId}` },
  );
  return mapData(r, (d) => (typeof d.id === "string" ? { id: d.id } : null));
}

/** The last four digits of the customer's default card (what every number subscription charges), or null. */
export async function retrieveCustomerCard(customerId: string, deps?: BillingDeps): Promise<StripeResult<{ cardLast4: string | null }>> {
  const r = await req(deps)<{ id?: unknown; invoice_settings?: { default_payment_method?: unknown } }>("GET", `/customers/${customerId}`, {
    expand: ["invoice_settings.default_payment_method"],
  });
  return mapData(r, (d) => {
    if (typeof d.id !== "string") return null;
    const pm = d.invoice_settings?.default_payment_method as { card?: { last4?: unknown } } | null | undefined;
    return { cardLast4: str(pm?.card?.last4) };
  });
}

/**
 * Makes a saved card the customer's default for invoices (what every number
 * subscription charges) and, when given, saves its billing address on the
 * customer (what Stripe Tax uses).
 */
export async function setCustomerDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string,
  deps?: BillingDeps,
  address?: Record<string, string> | null,
): Promise<StripeResult<{ id: string }>> {
  const r = await req(deps)<{ id?: unknown }>("POST", `/customers/${customerId}`, {
    invoice_settings: { default_payment_method: paymentMethodId },
    ...(address ? { address } : {}),
  });
  return mapData(r, (d) => (typeof d.id === "string" ? { id: d.id } : null));
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
