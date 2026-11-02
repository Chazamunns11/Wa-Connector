import type { BrandConfig } from "@/lib/brand-config";
import { inkFor } from "@/lib/brand";

/**
 * The branded HTML version of every email the app sends (src/lib/email.ts
 * builds it from the plain text, which still goes as the text part).
 *
 * Email clients ignore stylesheets and most of CSS, so this is the classic
 * shape: tables, inline styles, a PNG logo (Gmail and Outlook do not show
 * SVG). Colours are the PingWren kit: Ink #1B1F2A text on White, the accent
 * (Coral by default) as the button fill with `inkFor` text on it (Ink on
 * Coral; white on Coral is never used, it fails contrast).
 *
 * Plain-text rules: paragraphs are separated by a blank line; a paragraph
 * that is only the action's URL becomes the button; any other URL becomes a
 * link. All text is HTML-escaped.
 */
export interface EmailAction {
  label: string;
  url: string;
}

const INK = "#1B1F2A";
const INK_DIM = "#4A5162";
const RULE = "#E6E2DA";
const PAGE = "#F5F3EF";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The PingWren kit's PNG twin of the default SVG logo. */
const DEFAULT_LOGO_SVG = "/brand/pingwren-logo.svg";
const DEFAULT_LOGO_PNG = "/brand/pingwren-logo@3x.png";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkify(escaped: string, accentText: string): string {
  return escaped.replace(URL_RE, (u) => `<a href="${u}" style="color:${accentText};text-decoration:underline;word-break:break-all">${u}</a>`);
}

/** An absolute PNG/JPG logo URL for email, or null (then the brand name is shown as text). */
export function emailLogoUrl(brand: Pick<BrandConfig, "logoPath" | "appUrl">): string | null {
  let path = brand.logoPath;
  if (!path) return null;
  if (path === DEFAULT_LOGO_SVG) path = DEFAULT_LOGO_PNG;
  if (/\.svg($|\?)/i.test(path)) return null;
  return /^https?:\/\//i.test(path) ? path : `${brand.appUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function brandedEmailHtml(
  input: { subject: string; text: string; action?: EmailAction },
  brand: Pick<BrandConfig, "name" | "tagline" | "logoPath" | "accent" | "appUrl">,
): string {
  const accent = brand.accent ?? "#FF5A36";
  const accentInk = inkFor(accent);
  // Links sit on white: the accent is not guaranteed readable as text, Ink always is.
  const linkColour = INK;
  const logo = emailLogoUrl(brand);
  const name = escapeHtml(brand.name);

  const button = (a: EmailAction) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td style="border-radius:8px;background:${accent}">` +
    `<a href="${escapeHtml(a.url)}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:16px;font-weight:700;color:${accentInk};text-decoration:none;border-radius:8px">${escapeHtml(a.label)}</a>` +
    `</td></tr></table>`;

  let buttonPlaced = false;
  const blocks = input.text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (input.action && p === input.action.url) {
        buttonPlaced = true;
        return button(input.action);
      }
      const body = p
        .split("\n")
        .map((line) => linkify(escapeHtml(line), linkColour))
        .join("<br>");
      return `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.55;color:${INK}">${body}</p>`;
    });
  if (input.action && !buttonPlaced) blocks.push(button(input.action));

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${name}" height="30" style="display:block;height:30px;width:auto;border:0">`
    : `<span style="font-family:${FONT};font-size:20px;font-weight:800;color:${INK}">${name}</span>`;

  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${PAGE}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE}"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${RULE};border-radius:12px">`,
    `<tr><td style="padding:22px 28px;border-bottom:4px solid ${accent}">${header}</td></tr>`,
    `<tr><td style="padding:26px 28px 10px">${blocks.join("")}</td></tr>`,
    `<tr><td style="padding:16px 28px 22px;border-top:1px solid ${RULE};font-family:${FONT};font-size:13px;line-height:1.5;color:${INK_DIM}">` +
      `${name} · ${escapeHtml(brand.tagline)}<br><a href="${escapeHtml(brand.appUrl)}" style="color:${INK_DIM}">${escapeHtml(brand.appUrl.replace(/^https?:\/\//, ""))}</a></td></tr>`,
    "</table></td></tr></table></body></html>",
  ].join("");
}
