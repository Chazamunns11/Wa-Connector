/**
 * Pure hold rules for messages aimed at a disconnected WhatsApp number.
 * No I/O, no Next imports — the provider and the release pass inject the
 * session summary and the clock.
 */
import type { WhatsappSessionSummary } from "@/lib/types";

export const DEFAULT_HOLD_MAX_HOURS = 24;
const MIN_HOLD_MAX_HOURS = 1;
const MAX_HOLD_MAX_HOURS = 168;

/** `OUTBOUND_HOLD_MAX_HOURS` as an integer in 1..168, else the default. */
export function holdMaxHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OUTBOUND_HOLD_MAX_HOURS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_HOLD_MAX_HOURS;
  const n = Number(raw);
  return n >= MIN_HOLD_MAX_HOURS && n <= MAX_HOLD_MAX_HOURS ? n : DEFAULT_HOLD_MAX_HOURS;
}

/** Fixed string reported to GoHighLevel when a held message expires. */
export function heldExpiredReason(hours: number): string {
  return `phone was disconnected for more than ${hours} hours — message not sent`;
}

export const REASON_NUMBER_BANNED = "this WhatsApp number has been banned by WhatsApp — message not sent";

export type NotConnectedDecision = { kind: "hold" } | { kind: "refuse"; reason: string };

/**
 * The bridge said `session_not_connected`. Hold only for a number that was
 * linked once and is now offline; banned fails at once; never-linked or
 * inconsistent states fail with the caller's fixed reason.
 */
export function decideNotConnected(
  summary: WhatsappSessionSummary | null,
  notConnectedReason: string,
): NotConnectedDecision {
  if (summary === null) return { kind: "refuse", reason: notConnectedReason };
  if (summary.status === "banned") return { kind: "refuse", reason: REASON_NUMBER_BANNED };
  if (
    summary.lastConnectedAt !== null &&
    (summary.status === "disconnected" || summary.status === "waiting_qr" || summary.status === "logged_out")
  ) {
    return { kind: "hold" };
  }
  return { kind: "refuse", reason: notConnectedReason };
}

/** True once `maxHours` have passed since GoHighLevel asked (`created_at`). */
export function isHeldExpired(createdAtIso: string, nowMs: number, maxHours: number): boolean {
  const created = Date.parse(createdAtIso);
  // An unreadable date can never expire on its own, so treat it as expired
  // and fail it honestly instead of holding it forever.
  if (Number.isNaN(created)) return true;
  return nowMs - created > maxHours * 3_600_000;
}
