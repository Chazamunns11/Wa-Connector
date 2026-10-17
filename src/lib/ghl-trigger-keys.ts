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
