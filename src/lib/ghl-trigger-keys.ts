/** The GHL workflow trigger keys PingWren fires. Any other key is refused. */
export const TRIGGER_KEYS = [
  "whatsapp_disconnected",
  "whatsapp_reconnected",
  "whatsapp_message_received",
  "whatsapp_missed_call",
  "whatsapp_message_read",
  "whatsapp_not_on_whatsapp",
] as const;

export type TriggerKey = (typeof TRIGGER_KEYS)[number];

export function isTriggerKey(value: unknown): value is TriggerKey {
  return typeof value === "string" && (TRIGGER_KEYS as readonly string[]).includes(value);
}

/**
 * Normalises a workflow target URL, or returns null if it is not allowed.
 * Allowed: https, host exactly `services.leadconnectorhq.com` or ending
 * `.services.leadconnectorhq.com`, no userinfo, no explicit port (checked on
 * the raw authority, because `URL` silently drops `:443`), no empty label, no
 * trailing dot, at most 2048 characters. Parsed with `URL`, never substring
 * matching. Returns `url.href` (host lowercased) so what we store is what we
 * later POST to. Used when a subscription is stored and again at fire time.
 */
export function normalizeTriggerTargetUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  const authority = /^https:\/\/([^/?#\\]*)/i.exec(value)?.[1];
  if (authority === undefined || authority.includes("@") || authority.includes(":")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname;
  if (host.endsWith(".") || host.split(".").some((label) => label === "")) return null;
  if (host !== "services.leadconnectorhq.com" && !host.endsWith(".services.leadconnectorhq.com")) return null;
  return url.href;
}

export function isAllowedTriggerTargetUrl(value: unknown): value is string {
  return normalizeTriggerTargetUrl(value) !== null;
}
