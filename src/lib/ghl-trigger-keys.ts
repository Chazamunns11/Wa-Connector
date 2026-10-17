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
 * True only for an https URL whose host is `services.leadconnectorhq.com` or a
 * subdomain of `leadconnectorhq.com`. Parsed with `URL` (never substring
 * matching), so `leadconnectorhq.com.evil.example` and userinfo tricks fail.
 * Used both when a subscription is stored and again at fire time, because we
 * POST to this URL with a location token.
 */
export function isAllowedTriggerTargetUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === "services.leadconnectorhq.com" || host.endsWith(".leadconnectorhq.com");
}
