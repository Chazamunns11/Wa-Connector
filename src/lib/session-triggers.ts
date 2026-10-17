/**
 * Fires "WhatsApp disconnected" and "WhatsApp reconnected" to subscribed GHL
 * workflows. Run from the drains (the hourly cron, and the bridge's pokes: the
 * bridge pokes on every open or close, and once more 5 min 15 s after a close).
 *
 * Per number (a session of a location that has a subscription):
 *   - down: the first pass that sees it down stamps `downSince`. It fires once
 *     `now - downSince >= 5 min`, or at once for `logged_out` / `banned`.
 *   - up after a fired "down": fires reconnected once.
 *   - up before the 5 minutes: a blip, nothing fires, `downSince` is cleared.
 *
 * ORDER: the session state is written BEFORE the fire, as a compare-and-set on
 * `lastFired`; only the pass that wins it fires, so overlapping passes fire once.
 * Each location has its own trigger pass, so one location's failing endpoint
 * cannot drop another location's alerts.
 * ORDER (detail): the session state is written BEFORE the fire. A crash between the two
 * loses one fire; it can never repeat one on every pass.
 *
 * Fires run in the background under the drain's pass cap (`startTrigger` /
 * `settleTriggers`), so a slow trigger endpoint never holds the drain up. With
 * the flag off nothing is read. Nothing logs a phone, id or URL.
 */
import { brandConfig } from "@/lib/brand-config";
import { isConnectLinkConfigured, mintConnectLinkToken } from "@/lib/ghl-connect-link";
import { newTriggerPass, settleTriggers, startTrigger, type TriggerPass } from "@/lib/ghl-provider";
import { fireWorkflowTrigger, type TriggerDeps, type TriggerPayloads, type TriggerRepo } from "@/lib/ghl-triggers";
import type { GhlRepository } from "@/lib/data/repository";
import type { LocationSlot } from "@/lib/location-numbers";
import type { TriggerSessionRow } from "@/lib/types";

/** A number must be down this long before "disconnected" fires (unless logged out or banned). */
export const DISCONNECT_AFTER_MS = 5 * 60 * 1000;

export type SessionTriggerRepo = TriggerRepo &
  Pick<GhlRepository, "listLocationsWithTriggerKeys" | "listSessionsForTriggers" | "setSessionTriggerState" | "stampSessionTriggerPhone" | "countHeldByTenant">;

export interface SessionTriggerDeps extends TriggerDeps {
  /** A fresh "send" connect link for the number's slot, or "" when connect links are not configured. */
  reconnectUrl(locationId: string, connectLinkVersion: number | null, slot: number): string;
}

export function defaultSessionTriggerDeps(base: TriggerDeps): SessionTriggerDeps {
  return {
    ...base,
    reconnectUrl: (locationId, version, slot) => {
      if (!isConnectLinkConfigured() || version === null) return "";
      return `${brandConfig().appUrl}/connect/${mintConnectLinkToken(locationId, version, "send", slot as LocationSlot)}`;
    },
  };
}

function disconnectReason(status: TriggerSessionRow["status"]): TriggerPayloads["whatsapp_disconnected"]["reason"] {
  return status === "logged_out" ? "logged_out" : status === "banned" ? "banned" : "connection_lost";
}

export async function drainSessionTriggers(repo: SessionTriggerRepo, deps: SessionTriggerDeps, now: number = Date.now()): Promise<{ fired: number }> {
  const result = { fired: 0 };
  if (!deps.enabled()) return result;
  const passes: TriggerPass[] = [];
  try {
    const locationIds = await repo.listLocationsWithTriggerKeys(["whatsapp_disconnected", "whatsapp_reconnected"]);
    if (locationIds.length === 0) return result;
    const sessions = await repo.listSessionsForTriggers(locationIds);
    const passByLocation = new Map<string, TriggerPass>();

    for (const session of sessions) {
      let pass = passByLocation.get(session.locationId);
      if (!pass) {
        pass = newTriggerPass(() => {});
        passByLocation.set(session.locationId, pass);
        passes.push(pass);
      }
      try {
        await handleSession(repo, deps, pass, result, session, now);
      } catch {
        console.error("[session-triggers] session check failed (status none)");
      }
    }
  } catch {
    console.error("[session-triggers] drain failed (status none)");
  }
  await Promise.all(passes.map((pass) => settleTriggers(pass)));
  return result;
}

async function handleSession(
  repo: SessionTriggerRepo,
  deps: SessionTriggerDeps,
  pass: TriggerPass,
  result: { fired: number },
  session: TriggerSessionRow,
  now: number
): Promise<void> {
  // A number that never connected has nothing to lose or regain.
  if (session.lastConnectedAt === null && session.lastFired === null) return;

  // The bridge's credential wipe nulls `phone`; keep our own copy of the number.
  if (session.phone && session.phone !== session.triggerPhone) {
    try {
      await repo.stampSessionTriggerPhone(session.tenantId, session.phone);
    } catch {
      console.error("[session-triggers] phone stamp failed (status none)");
    }
  }
  const number = session.phone ?? session.triggerPhone;
  const numberInfo = { number: number ?? "", numberLabel: session.label };
  const record = (fired: { fired: number; failed: number }) => {
    result.fired += fired.fired;
    return fired.failed === 0;
  };
  /** Starts a fire unless there is no number to put in the payload (the state is still marked). */
  const fire = (run: () => Promise<boolean>) => {
    if (number) startTrigger(pass, run);
  };

  if (session.status === "connected") {
    if (session.lastFired === "down") {
      const downMs = session.downSince ? Math.max(0, now - Date.parse(session.downSince)) : 0;
      if (!(await repo.setSessionTriggerState(session.tenantId, { downSince: null, lastFired: "up" }, "down"))) return;
      fire(async () =>
        record(await fireWorkflowTrigger(repo, deps, session.locationId, "whatsapp_reconnected", { ...numberInfo, downMinutes: Math.round(downMs / 60_000) }))
      );
    } else if (session.downSince !== null) {
      await repo.setSessionTriggerState(session.tenantId, { downSince: null, lastFired: session.lastFired }, session.lastFired);
    }
    return;
  }

  const terminal = session.status === "logged_out" || session.status === "banned";
  let downSinceMs = session.downSince ? Date.parse(session.downSince) : NaN;
  const wasUnstamped = Number.isNaN(downSinceMs);
  if (wasUnstamped) downSinceMs = now;
  const due = terminal || now - downSinceMs >= DISCONNECT_AFTER_MS;

  if (session.lastFired !== "down" && due) {
    // Mark first (compare-and-set), then fire only if this pass won.
    if (!(await repo.setSessionTriggerState(session.tenantId, { downSince: new Date(downSinceMs).toISOString(), lastFired: "down" }, session.lastFired))) return;
    fire(async () => {
      const held = (await repo.countHeldByTenant([session.tenantId])).get(session.tenantId) ?? 0;
      let reconnectUrl = "";
      try {
        const account = await repo.getGhlAccountByLocationId(session.locationId);
        reconnectUrl = deps.reconnectUrl(session.locationId, account?.connectLinkVersion ?? null, session.slot);
      } catch {
        reconnectUrl = "";
      }
      return record(
        await fireWorkflowTrigger(repo, deps, session.locationId, "whatsapp_disconnected", {
          ...numberInfo,
          reason: disconnectReason(session.status),
          heldMessages: held,
          reconnectUrl,
        })
      );
    });
  } else if (wasUnstamped) {
    await repo.setSessionTriggerState(session.tenantId, { downSince: new Date(downSinceMs).toISOString(), lastFired: session.lastFired }, session.lastFired);
  }
}
