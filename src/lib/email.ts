import { brandConfig } from "@/lib/brand-config";
import { brandedEmailHtml, type EmailAction } from "@/lib/email-html";

/**
 * Operator/customer email through Resend's REST API — the same plain-fetch
 * shape PortalHub's reminder emails use (no SDK). Env-gated: without
 * `RESEND_API_KEY` and `EMAIL_FROM` nothing is sent and the caller gets
 * `false` (it falls back to Slack). Never throws; never logs a body.
 *
 * Every email goes out branded: a plain-text part (what callers write) plus
 * an HTML part built from it in the brand's logo and colours
 * (src/lib/email-html.ts). `action` turns its URL's paragraph into a button.
 * `EMAIL_FROM` should carry the brand name too, e.g.
 * `PingWren <hello@pingwren.co.uk>`.
 */
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 5000;

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());
}

/** Where operator alerts go: `ALERT_EMAIL_TO` (comma-separated), else the PingWren operator inbox. */
export function operatorAlertEmails(): string[] {
  const raw = process.env.ALERT_EMAIL_TO?.trim() || "charlie@pingwren.co.uk";
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.includes("@"));
}

export interface EmailInput {
  to: string[];
  subject: string;
  text: string;
  action?: EmailAction;
}

/** The branded HTML part, or undefined if the brand cannot be read (then the email goes text-only rather than not at all). */
function htmlFor(input: EmailInput): string | undefined {
  try {
    return brandedEmailHtml(input, brandConfig());
  } catch {
    return undefined;
  }
}

export async function sendEmail(input: EmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  const to = [...new Set(input.to.filter((e) => e.includes("@")))];
  if (!apiKey || !from || to.length === 0) return false;
  const html = htmlFor(input);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, subject: input.subject, text: input.text, ...(html ? { html } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[email] Resend responded ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] send failed:", err);
    return false;
  }
}
