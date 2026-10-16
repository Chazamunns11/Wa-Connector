/**
 * Tiny Stripe REST client over fetch (no SDK). Form-encoded requests, pinned
 * API version. The secret key and response bodies are never logged.
 */
export const STRIPE_API_VERSION = "2024-11-20.acacia";

const API_BASE = "https://api.stripe.com/v1";

export interface StripeConfig {
  secretKey: string;
  priceId: string;
  webhookSecret: string | null;
  automaticTax: boolean;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

export function stripeConfig(): StripeConfig {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) throw new Error("Stripe is not configured");
  return {
    secretKey,
    priceId,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    automaticTax: process.env.STRIPE_AUTOMATIC_TAX === "true",
  };
}

function flatten(value: unknown, prefix: string, out: string[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}[${k}]` : k, out);
    }
    return;
  }
  out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
}

/** Stripe form encoding: nested objects a[b]=, arrays a[0]=, nulls skipped. */
export function encodeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  flatten(params, "", out);
  return out.join("&");
}

export type StripeResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; message: string };

export async function stripeRequest<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<StripeResult<T>> {
  const { secretKey } = stripeConfig();
  const doFetch = opts.fetchImpl ?? fetch;
  const body = encodeForm(params);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  let url = `${API_BASE}${path}`;
  const init: RequestInit = { method, headers };
  if (method === "GET") {
    if (body) url += `?${body}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    init.body = body;
  }
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch {
    return { ok: false, status: 0, code: null, message: "network" };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    return {
      ok: false,
      status: res.status,
      code: typeof err?.code === "string" ? err.code : null,
      message: typeof err?.message === "string" ? err.message : `HTTP ${res.status}`,
    };
  }
  return { ok: true, data: json as T };
}
