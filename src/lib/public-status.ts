/**
 * Public status page (`/status`) — pure aggregation only, no data-layer or
 * network imports, so scripts/test/public-status.test.ts can exercise every
 * state offline.
 *
 * WHAT IT MAY SHOW: one state per service and nothing else. No location
 * names, ids, counts, error strings or timestamps from the database — the
 * page is unauthenticated, and `GhlHealthSnapshot` is per-location operator
 * data (src/lib/ghl-health.ts). Only the derived state leaves this module.
 *
 * Two services:
 *   - "WhatsApp sending": the bridge's unauthenticated `/health` probe
 *     (`getWhatsappBridgeHealth`, src/lib/whatsapp-bridge.ts).
 *   - "GoHighLevel sync": the OUTBOUND status backlog only. A row stuck
 *     unreported for over an hour, or whose last report errored, means GHL
 *     is showing a message as pending that it shouldn't be. Inbound problem
 *     counts are deliberately left out: they cover a 7-day window
 *     (GHL_HEALTH_INBOUND_WINDOW_DAYS), so one failure would hold the public
 *     page at "degraded" for a week after it was fixed.
 */
import type { GhlHealthSnapshot } from "@/lib/types";

export type PublicServiceState = "operational" | "degraded" | "down" | "unknown";

export interface PublicService {
  name: string;
  state: PublicServiceState;
  /** One fixed sentence per state — never data-derived text. */
  detail: string;
}

export interface PublicStatus {
  overall: PublicServiceState;
  services: PublicService[];
}

/** `null` = the bridge isn't configured on this deployment; otherwise whether `/health` answered. */
export type BridgeProbe = { ok: true } | { ok: false } | null;

const SEVERITY: Record<PublicServiceState, number> = { operational: 0, unknown: 1, degraded: 2, down: 3 };

const WHATSAPP_DETAIL: Record<PublicServiceState, string> = {
  operational: "Messages are sending and arriving normally.",
  degraded: "Some messages are slower than usual.",
  down: "The WhatsApp service isn't responding right now.",
  unknown: "We can't check this right now.",
};

const GHL_DETAIL: Record<PublicServiceState, string> = {
  operational: "Delivery updates are reaching GoHighLevel normally.",
  degraded: "Some delivery updates are taking longer than an hour to reach GoHighLevel.",
  down: "Delivery updates aren't reaching GoHighLevel.",
  unknown: "We can't check this right now.",
};

export function whatsappState(probe: BridgeProbe): PublicServiceState {
  if (probe === null) return "unknown";
  return probe.ok ? "operational" : "down";
}

export function ghlSyncState(snapshot: GhlHealthSnapshot | null): PublicServiceState {
  if (snapshot === null) return "unknown";
  const stuck = snapshot.outbound.some((loc) => loc.pendingOverOneHour > 0 || loc.erroredCount > 0);
  return stuck ? "degraded" : "operational";
}

export function buildPublicStatus(probe: BridgeProbe, snapshot: GhlHealthSnapshot | null): PublicStatus {
  const wa = whatsappState(probe);
  const ghl = ghlSyncState(snapshot);
  const services: PublicService[] = [
    { name: "WhatsApp sending", state: wa, detail: WHATSAPP_DETAIL[wa] },
    { name: "GoHighLevel sync", state: ghl, detail: GHL_DETAIL[ghl] },
  ];
  const overall = services.reduce<PublicServiceState>((worst, s) => (SEVERITY[s.state] > SEVERITY[worst] ? s.state : worst), "operational");
  return { overall, services };
}

export const OVERALL_HEADLINE: Record<PublicServiceState, string> = {
  operational: "All systems working",
  degraded: "Some delays right now",
  down: "Service disruption",
  unknown: "Status partly unavailable",
};
