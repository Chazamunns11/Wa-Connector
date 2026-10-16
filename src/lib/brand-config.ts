export interface BrandConfig {
  name: string;
  supportEmail: string | null;
  appUrl: string;
}

const DEFAULT_NAME = "WA Connector";
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
  const rawUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!rawUrl && process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL must be set in production");
  }
  const appUrl = (rawUrl || DEV_APP_URL).replace(/\/+$/, "");
  return { name, supportEmail, appUrl };
}
