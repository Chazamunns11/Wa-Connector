import type { CSSProperties } from "react";
import { inkFor, normaliseHex } from "@/lib/brand";

export interface BrandConfig {
  /** BRAND_NAME, default "WA Connector". */
  name: string;
  /** BRAND_TAGLINE, default "WhatsApp for GoHighLevel". */
  tagline: string;
  supportEmail: string | null;
  /** BRAND_SUPPORT_WHATSAPP, E.164 or null. */
  supportWhatsApp: string | null;
  /** BRAND_LOGO_PATH, a /public path or absolute URL; null = text wordmark. */
  logoPath: string | null;
  /** BRAND_ACCENT normalised to #RRGGBB; null = globals.css teal. */
  accent: string | null;
  /** BRAND_PRICE_PER_NUMBER, a decimal in major units; dev default 29. */
  pricePerNumber: number;
  /** BRAND_CURRENCY, ISO 4217 upper-case; default "GBP". */
  currency: string;
  appUrl: string;
}

const DEFAULT_NAME = "WA Connector";
const DEFAULT_TAGLINE = "WhatsApp for GoHighLevel";
const DEFAULT_CURRENCY = "GBP";
const DEV_PRICE_PER_NUMBER = 29;
const DEV_APP_URL = "http://localhost:3000";

function parsePrice(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BRAND_PRICE_PER_NUMBER must be set in production");
    }
    return DEV_PRICE_PER_NUMBER;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("BRAND_PRICE_PER_NUMBER must be a number");
  }
  return n;
}

/**
 * Product identity, read from env on every call so tests (and deploys) can
 * change it. `NEXT_PUBLIC_APP_URL` is required in production; in dev it
 * defaults to localhost. The trailing slash is stripped so callers can append
 * a path with a single "/".
 */
export function brandConfig(): BrandConfig {
  const name = process.env.BRAND_NAME?.trim() || DEFAULT_NAME;
  const supportEmail = process.env.BRAND_SUPPORT_EMAIL?.trim() || null;
  const tagline = process.env.BRAND_TAGLINE?.trim() || DEFAULT_TAGLINE;
  const supportWhatsApp = process.env.BRAND_SUPPORT_WHATSAPP?.trim() || null;
  const logoPath = process.env.BRAND_LOGO_PATH?.trim() || null;
  const accent = normaliseHex(process.env.BRAND_ACCENT);
  const currency = (process.env.BRAND_CURRENCY?.trim() || DEFAULT_CURRENCY).toUpperCase();
  const pricePerNumber = parsePrice(process.env.BRAND_PRICE_PER_NUMBER);
  const rawUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!rawUrl && process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL must be set in production");
  }
  const appUrl = (rawUrl || DEV_APP_URL).replace(/\/+$/, "");
  return {
    name,
    tagline,
    supportEmail,
    supportWhatsApp,
    logoPath,
    accent,
    pricePerNumber,
    currency,
    appUrl,
  };
}

/**
 * Page-scoped accent variables for the site's outermost wrapper, or undefined
 * when no accent is configured (globals.css teal applies). Mirrors
 * `brandStyle` in `@/lib/brand`, with the ink computed rather than assumed.
 */
export function brandCssVars(brand: BrandConfig): CSSProperties | undefined {
  if (!brand.accent) return undefined;
  return {
    "--color-accent": brand.accent,
    "--color-accent-ink": inkFor(brand.accent),
    "--color-accent-text": brand.accent,
  } as CSSProperties;
}
