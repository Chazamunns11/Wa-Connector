import type { GhlEmbedWhatsappSummary, WhatsappSessionSummary } from "@/lib/types";

/**
 * The session summary an unauthenticated GoHighLevel iframe or connect link may see.
 * Fields are ENUMERATED, never spread: `coachId` is the tenant id and must never
 * ride along, and a field added to `WhatsappSessionSummary` later must not leak by default.
 */
export function toEmbedWhatsappSummary(summary: WhatsappSessionSummary | null): GhlEmbedWhatsappSummary | null {
  if (!summary) return null;
  const { status, phoneNumber, lastConnectedAt, lastDisconnectReason, sentToday, heldMessages } = summary;
  return { status, phoneNumber, lastConnectedAt, lastDisconnectReason, sentToday, heldMessages };
}
