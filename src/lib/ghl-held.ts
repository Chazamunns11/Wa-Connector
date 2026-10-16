/**
 * Release pass for outbound messages held while a WhatsApp number was
 * disconnected (reliability T8). Run from the hourly drain and from the
 * bridge's reconnect poke, immediately before `drainGhlOutboundStatuses`.
 *
 * DECISIONS
 * - The pass never gates on the DB session status. The reconnect poke can
 *   arrive before the bridge persists status=connected, so each held number
 *   is simply attempted and the bridge's live `session_not_connected` answer
 *   decides: the row stays held and that number's loop stops.
 * - Each row re-runs the sending gate and the opt-out check first, so a
 *   cancelled subscription or a STOP received while held is honoured.
 * - Oldest first per number, so a conversation keeps its order.
 * - Every state write is guarded with `onlyIfSendState: "held"`, so a
 *   concurrent pass never has its work overwritten. The original idempotency
 *   key is reused, so a double send is a bridge replay, not a duplicate.
 * - A message held longer than `OUTBOUND_HOLD_MAX_HOURS` is reported to GHL
 *   as failed with an honest reason rather than sent late.
 * - W11 stays: a daily-cap overflow is reported not sent, never carried over.
 * Never throws.
 */
import type { GhlRepository } from "@/lib/data";
import {
  defaultGhlProviderDeps,
  GHL_PROVIDER_REASONS,
  isTransientBridgeFailure,
  mapBridgeFailureReason,
  outboundRefusalReason,
  reportGhlOutcome,
  type GhlProviderDeps,
  type GhlProviderRepo,
} from "@/lib/ghl-provider";
import { heldExpiredReason, holdMaxHours } from "@/lib/ghl-held-rules";
import type { GhlOutboundMessage } from "@/lib/types";

export type GhlHeldRepo = GhlProviderRepo & Pick<GhlRepository, "listHeldTenantIds" | "listHeldGhlOutboundMessages" | "listExpiredHeldGhlOutboundMessages">;

export interface ReleaseHeldResult {
  tenantsChecked: number;
  released: number;
  stillHeld: number;
  expired: number;
  refused: number;
  reportFailed: number;
  timeBudgetExceeded: boolean;
}

const RELEASE_TIME_BUDGET_MS = 25_000;
const BATCH = 50;

export async function releaseHeldOutboundMessages(
  repo: GhlHeldRepo,
  deps: GhlProviderDeps = defaultGhlProviderDeps,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<ReleaseHeldResult> {
  const result: ReleaseHeldResult = { tenantsChecked: 0, released: 0, stillHeld: 0, expired: 0, refused: 0, reportFailed: 0, timeBudgetExceeded: false };
  const startedAt = Date.now();
  const overBudget = () => {
    if (Date.now() - startedAt >= RELEASE_TIME_BUDGET_MS) result.timeBudgetExceeded = true;
    return result.timeBudgetExceeded;
  };

  /** Refuse a held row (guarded) and tell GHL it failed. */
  async function refuseAndReport(row: GhlOutboundMessage, reason: string): Promise<boolean> {
    await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason, onlyIfSendState: "held" });
    const account = await repo.getGhlAccountByLocationId(row.locationId);
    const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", reason);
    if (outcome !== "reported") result.reportFailed++;
    return outcome === "reported";
  }

  try {
    const hours = holdMaxHours(env);
    const cutoffIso = new Date(nowMs - hours * 3_600_000).toISOString();
    const expiredRows = await repo.listExpiredHeldGhlOutboundMessages(cutoffIso, BATCH);
    for (const row of expiredRows) {
      if (overBudget()) break;
      try {
        // A concurrent pass may have sent this row since it was listed: if the
        // bridge already has it, never report it failed.
        const ledger = await repo.getWhatsappMessagesByTenantKeys([{ tenantId: row.tenantId, idempotencyKey: row.idempotencyKey }]);
        if (ledger.length > 0) {
          await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted", onlyIfSendState: "held" });
          continue;
        }
        await refuseAndReport(row, heldExpiredReason(hours));
        result.expired++;
      } catch (err) {
        console.error(`[ghl-held] expiring row ${row.id} failed (non-fatal):`, err);
      }
    }

    const tenantIds = await repo.listHeldTenantIds();
    for (const tenantId of tenantIds) {
      if (overBudget()) break;
      result.tenantsChecked++;
      const rows = await repo.listHeldGhlOutboundMessages(tenantId, BATCH);
      for (const row of rows) {
        if (overBudget()) break;
        try {
          if (row.toPhone === null || row.pendingText === null) {
            await refuseAndReport(row, GHL_PROVIDER_REASONS.bridgeUnreachableExhausted);
            result.refused++;
            continue;
          }
          const account = await repo.getGhlAccountByLocationId(row.locationId);
          const gate = await outboundRefusalReason(repo, account, row.toPhone);
          if (gate) {
            await refuseAndReport(row, gate);
            result.refused++;
            continue;
          }
          const sent = await deps.sendWhatsapp({ coachId: row.tenantId, to: row.toPhone, text: row.pendingText, idempotencyKey: row.idempotencyKey });
          if (sent.ok) {
            await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted", onlyIfSendState: "held" });
            result.released++;
            continue;
          }
          if (sent.code === "session_not_connected") {
            result.stillHeld++;
            break; // the bridge dropped again: keep this number's remaining rows held
          }
          if (sent.code === "daily_cap_reached") {
            await refuseAndReport(row, GHL_PROVIDER_REASONS.capReached);
            result.refused++;
            continue;
          }
          if (isTransientBridgeFailure(sent.code)) {
            result.stillHeld++;
            continue;
          }
          await refuseAndReport(row, mapBridgeFailureReason(sent.code));
          result.refused++;
        } catch (err) {
          console.error(`[ghl-held] releasing row ${row.id} failed (non-fatal):`, err);
        }
      }
    }
  } catch (err) {
    console.error("[ghl-held] release pass failed (non-fatal):", err);
  }
  return result;
}
