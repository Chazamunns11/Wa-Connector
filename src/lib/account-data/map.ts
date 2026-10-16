import type { GhlAccountSummary, LocationStats, WhatsappSessionSummary } from "@/lib/types";
import type { LocationRow, WhatsappState } from "./types";

/** Activated this long ago, connected, and still nothing received from GoHighLevel: nudge about the Telephony Provider. */
export const PROVIDER_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Mirrors the bridge's WA_DAILY_CAP default. */
export const DEFAULT_DAILY_CAP = 150;

export function toWhatsappState(
  activated: boolean,
  summary: WhatsappSessionSummary | null,
  pendingSend: number,
): WhatsappState {
  if (!activated) return { kind: "not_active" };
  if (summary?.status === "connected") return { kind: "connected", number: summary.phoneNumber ?? "" };
  if (!summary || summary.status === "waiting_qr" || summary.lastConnectedAt === null) return { kind: "waiting_qr" };
  return { kind: "disconnected", waiting: pendingSend };
}

export function toLocationRow(
  loc: GhlAccountSummary,
  summary: WhatsappSessionSummary | null,
  stats: LocationStats,
  now: Date,
  dailyCap: number,
  optOuts: number,
): LocationRow {
  const activated = loc.activatedAt !== null;
  const state = toWhatsappState(activated, summary, stats.pendingSend);
  const activatedAt = loc.activatedAt ? Date.parse(loc.activatedAt) : NaN;
  const providerNudge =
    state.kind === "connected" &&
    !stats.everReceived &&
    Number.isFinite(activatedAt) &&
    now.getTime() - activatedAt >= PROVIDER_NUDGE_AFTER_MS;
  return {
    id: loc.locationId,
    name: loc.label,
    activated,
    state,
    sentToday: summary?.sentToday ?? 0,
    dailyCap,
    heldMessages: stats.pendingSend,
    failedLast7Days: stats.failedLast7Days,
    optOuts,
    providerNudge,
  };
}

/** The panel's session summary, derived from the dashboard row (null when there is nothing to show). */
export function panelSummaryFromRow(row: LocationRow): WhatsappSessionSummary | null {
  const base = { coachId: "", lastDisconnectReason: null, sentToday: row.sentToday, heldMessages: row.heldMessages } as const;
  switch (row.state.kind) {
    case "connected":
      return { ...base, status: "connected", phoneNumber: row.state.number || null, lastConnectedAt: null };
    case "disconnected":
      return { ...base, status: "disconnected", phoneNumber: null, lastConnectedAt: new Date(0).toISOString() };
    default:
      return null;
  }
}
