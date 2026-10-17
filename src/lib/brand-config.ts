import type { CSSProperties } from "react";
import { inkFor, normaliseHex } from "@/lib/brand";

export interface BrandConfig {
  /** BRAND_NAME, default "PingWren". */
  name: string;
  /** BRAND_TAGLINE, default "WhatsApp for GoHighLevel". */
  tagline: string;
  supportEmail: string | null;
  /** BRAND_SUPPORT_WHATSAPP, E.164 or null. */
  supportWhatsApp: string | null;
  /** BRAND_LOGO_PATH, a /public path or absolute URL; for light surfaces. Default: the PingWren kit logo. */
  logoPath: string | null;
  /** BRAND_LOGO_REVERSE_PATH; for dark surfaces. Falls back to BRAND_LOGO_PATH when only that is set. */
  logoReversePath: string | null;
  /** BRAND_ACCENT normalised to #RRGGBB; default PingWren Coral. */
  accent: string | null;
  appUrl: string;
}

const DEFAULT_NAME = "PingWren";
const DEFAULT_LOGO = "/brand/pingwren-logo.svg";
const DEFAULT_LOGO_REVERSE = "/brand/pingwren-logo-reverse.svg";
/** PingWren Coral, the kit's accent / CTA colour. Matches `--color-accent` in globals.css. */
export const DEFAULT_ACCENT = "#FF5A36";
const DEFAULT_TAGLINE = "WhatsApp for GoHighLevel";
const DEV_APP_URL = "http://localhost:3000";

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
  const customLogo = process.env.BRAND_LOGO_PATH?.trim() || null;
  const logoPath = customLogo ?? DEFAULT_LOGO;
  const logoReversePath =
    process.env.BRAND_LOGO_REVERSE_PATH?.trim() || customLogo || DEFAULT_LOGO_REVERSE;
  const accent = normaliseHex(process.env.BRAND_ACCENT) ?? DEFAULT_ACCENT;
  // Vercel preview builds get their own address, so a preview of any branch
  // builds without NEXT_PUBLIC_APP_URL. Production still has to set it.
  const previewHost =
    process.env.VERCEL_ENV === "preview"
      ? process.env.VERCEL_BRANCH_URL?.trim() || process.env.VERCEL_URL?.trim()
      : undefined;
  const rawUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || (previewHost ? `https://${previewHost}` : undefined);
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
    logoReversePath,
    accent,
    appUrl,
  };
}

/**
 * Page-scoped accent variables for the site's outermost wrapper, or undefined
 * when the accent is the PingWren default (globals.css already carries it).
 * Sets the fill and the ink that sits on it (`inkFor`). `--color-accent-text`
 * is deliberately left to the theme (Wren on Cream, Tan on Ink): an arbitrary
 * accent is not guaranteed to be readable as text on either ground.
 */
export function brandCssVars(brand: BrandConfig): CSSProperties | undefined {
  if (!brand.accent || brand.accent.toUpperCase() === DEFAULT_ACCENT) return undefined;
  return {
    "--color-accent": brand.accent,
    "--color-accent-ink": inkFor(brand.accent),
  } as CSSProperties;
}
