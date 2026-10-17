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
 * - A picture/file message is held as a whole (parent row `held`, attachment
 *   rows `pending_send`) and released text first, then attachments in seq
 *   order. Parts the bridge ledger already has are never sent again; a drop
 *   part-way leaves the parent held and the next pass sends only what is
 *   missing. The parent ends `accepted` (or the internal no-text marker for an
 *   attachments-only message) and the status drain reports the aggregate.
 * - W11 stays: a daily-cap overflow is reported not sent, never carried over.
 * - Multiple numbers and groups (merge): every row is released from its OWN
 *   number (`row.tenantId` — the sticky/default/group number it was routed
 *   to), never another. A group row (no phone) is released to its group
 *   (`resolveDrainTarget`), and a non-default number's refusal strings come
 *   from `mapSendFailureReason`.
 * Never throws.
 */
import type { GhlRepository } from "@/lib/data";
import {
  defaultGhlProviderDeps,
  GHL_PROVIDER_REASONS,
  TEXT_PART_NOT_APPLICABLE,
  isDefaultNumberForRow,
  isTransientBridgeFailure,
  mapSendFailureReason,
  outboundRefusalReason,
  resolveDrainTarget,
  reportGhlOutcome,
  isReportedOutcome,
  type GhlProviderDeps,
  type GhlProviderRepo,
} from "@/lib/ghl-provider";
import { heldExpiredReason, holdMaxHours, isHeldExpired } from "@/lib/ghl-held-rules";
import type { GhlOutboundAttachment, GhlOutboundMessage } from "@/lib/types";

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

  /** Refuse a held row (guarded) and tell GHL it failed, but only if this pass won the row. */
  async function refuseAndReport(row: GhlOutboundMessage, reason: string): Promise<boolean> {
    const won = await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: reason, onlyIfSendState: "held" });
    if (won !== 1) return false; // another pass already moved the row; it owns the report
    const account = await repo.getGhlAccountByLocationId(row.locationId);
    const outcome = await reportGhlOutcome(repo, deps, account, row, "failed", reason);
    if (!isReportedOutcome(outcome)) result.reportFailed++;
    return isReportedOutcome(outcome);
  }

  /** The parts of a held picture/file message (empty for a plain text row), in seq order. */
  async function partsOf(row: GhlOutboundMessage): Promise<GhlOutboundAttachment[]> {
    if (!row.hadAttachments) return [];
    return (await repo.listGhlOutboundAttachmentsForMessages([row.id])).sort((a, b) => a.seq - b.seq);
  }

  /** Keys of this message's parts the bridge already holds a ledger row for. */
  async function ledgerKeys(row: GhlOutboundMessage, parts: GhlOutboundAttachment[]): Promise<Set<string>> {
    const keys = [row.idempotencyKey, ...parts.map((p) => p.idempotencyKey)];
    const found = await repo.getWhatsappMessagesByTenantKeys(keys.map((idempotencyKey) => ({ tenantId: row.tenantId, idempotencyKey })));
    return new Set(found.map((m) => m.idempotencyKey));
  }

  /**
   * Refuse the not-yet-sent remainder of a held message (expiry, gate, STOP).
   * Nothing sent yet: the usual refuse-and-report, with every pending part
   * refused too. Part of it already went: refuse only the remainder and let
   * the status drain report the honest partial delivery.
   */
  async function refuseMessage(row: GhlOutboundMessage, parts: GhlOutboundAttachment[], reason: string): Promise<void> {
    if (parts.length === 0) {
      await refuseAndReport(row, reason);
      return;
    }
    const sent = await ledgerKeys(row, parts);
    const anySent = sent.size > 0 || parts.some((p) => p.sendState === "accepted");
    if (!anySent) {
      const won = await refuseAndReport(row, reason);
      if (won) {
        for (const p of parts) if (p.sendState === "pending_send") await repo.updateGhlOutboundAttachmentSendState(p.id, { sendState: "refused", refusalReason: reason });
      }
      return;
    }
    for (const p of parts) if (p.sendState === "pending_send" && !sent.has(p.idempotencyKey)) await repo.updateGhlOutboundAttachmentSendState(p.id, { sendState: "refused", refusalReason: reason });
    if (sent.has(row.idempotencyKey)) await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted", onlyIfSendState: "held" });
    else await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: row.pendingText === null ? TEXT_PART_NOT_APPLICABLE : reason, onlyIfSendState: "held" });
  }

  /** Release one held picture/file message. Returns "drop" when this number's loop must stop. */
  async function releaseMultipart(
    row: GhlOutboundMessage,
    parts: GhlOutboundAttachment[],
    target: { to: string } | { groupJid: string },
    isDefaultNumber: boolean
  ): Promise<"done" | "drop" | "next"> {
    const sent = await ledgerKeys(row, parts);
    type TextEnd = { kind: "accepted" } | { kind: "vacuous" } | { kind: "refused"; reason: string };
    let textEnd: TextEnd;
    if (sent.has(row.idempotencyKey)) textEnd = { kind: "accepted" };
    else if (row.pendingText === null) textEnd = { kind: "vacuous" };
    else {
      const r = await deps.sendWhatsapp({ coachId: row.tenantId, ...target, text: row.pendingText, idempotencyKey: row.idempotencyKey });
      if (r.ok) textEnd = { kind: "accepted" };
      else if (r.code === "session_not_connected") {
        result.stillHeld++;
        return "drop";
      } else if (isTransientBridgeFailure(r.code)) {
        result.stillHeld++;
        return "next";
      } else textEnd = { kind: "refused", reason: r.code === "daily_cap_reached" ? GHL_PROVIDER_REASONS.capReached : mapSendFailureReason(r.code, isDefaultNumber) };
    }
    for (const part of parts) {
      if (part.sendState !== "pending_send") continue;
      if (sent.has(part.idempotencyKey)) {
        await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "accepted" });
        continue;
      }
      if (part.pendingUrl === null) {
        await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: GHL_PROVIDER_REASONS.bridgeUnreachableExhausted });
        continue;
      }
      const r = await deps.sendAttachment({ coachId: row.tenantId, ...target, attachment: { url: part.pendingUrl, fileName: part.fileName ?? undefined }, idempotencyKey: part.idempotencyKey });
      if (r.ok) {
        await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "accepted" });
      } else if (r.code === "session_not_connected") {
        result.stillHeld++;
        return "drop"; // the parent stays held; the text part is in the ledger now, so it is never re-sent
      } else if (isTransientBridgeFailure(r.code)) {
        result.stillHeld++;
        return "next";
      } else {
        await repo.updateGhlOutboundAttachmentSendState(part.id, { sendState: "refused", refusalReason: r.code === "daily_cap_reached" ? GHL_PROVIDER_REASONS.capReached : mapSendFailureReason(r.code, isDefaultNumber) });
      }
    }
    if (textEnd.kind === "accepted") await repo.updateGhlOutboundSendState(row.id, { sendState: "accepted", onlyIfSendState: "held" });
    else if (textEnd.kind === "vacuous") await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: TEXT_PART_NOT_APPLICABLE, onlyIfSendState: "held" });
    else await repo.updateGhlOutboundSendState(row.id, { sendState: "refused", refusalReason: textEnd.reason, onlyIfSendState: "held" });
    result.released++;
    return "done";
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
        const parts = await partsOf(row);
        if (parts.length > 0) {
          await refuseMessage(row, parts, heldExpiredReason(hours));
          result.expired++;
          continue;
        }
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
          const parts = await partsOf(row);
          if (isHeldExpired(row.createdAt, nowMs, hours)) {
            // Never send late, whatever the sweep's batch cap left behind.
            await refuseMessage(row, parts, heldExpiredReason(hours));
            result.expired++;
            continue;
          }
          // A phone row goes to its phone; a group row (no phone) to its
          // group on the row's own number (`resolveDrainTarget`).
          const target = await resolveDrainTarget(repo, row);
          if (target === null || (row.pendingText === null && parts.length === 0)) {
            await refuseMessage(row, parts, GHL_PROVIDER_REASONS.bridgeUnreachableExhausted);
            result.refused++;
            continue;
          }
          const account = await repo.getGhlAccountByLocationId(row.locationId);
          const isDefaultNumber = isDefaultNumberForRow(row, account);
          const gate = await outboundRefusalReason(repo, account, row);
          if (gate) {
            await refuseMessage(row, parts, gate);
            result.refused++;
            continue;
          }
          if (parts.length > 0) {
            const outcome = await releaseMultipart(row, parts, target, isDefaultNumber);
            if (outcome === "drop") break; // the bridge dropped again: keep this number's remaining rows held
            continue;
          }
          if (row.pendingText === null) continue; // unreachable: refused above
          const sent = await deps.sendWhatsapp({ coachId: row.tenantId, ...target, text: row.pendingText, idempotencyKey: row.idempotencyKey });
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
          await refuseAndReport(row, mapSendFailureReason(sent.code, isDefaultNumber));
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
