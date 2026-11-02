import { formatMoney, monthlyCostPence, pricingConfig, TRIAL_DAYS } from "@/lib/pricing";
import type { AccountSummary, BillingSummary, LocationRow } from "./types";

export interface PlanStatus {
  label: string;
  tone: "win" | "warn" | "loss" | "info" | "muted";
  banner: string | null;
}

const numbers = (n: number) => `${n} ${n === 1 ? "number" : "numbers"}`;

/** Shown on the dashboard and billing page while no card is on file. */
export const NO_CARD_BANNER = `Save a card to start. Nothing is charged then: each WhatsApp number you add gets its own ${TRIAL_DAYS}-day free trial.`;

/**
 * The account's plan, from its status (is a card on file?) and, when known,
 * its numbers' billing. Billing is per number, so a payment problem names how
 * many numbers it affects.
 */
export function planStatus(account: AccountSummary, billing?: Pick<BillingSummary, "pastDueNumbers" | "stoppedNumbers">): PlanStatus {
  switch (account.billingStatus) {
    case "comped":
      return { label: "Active", tone: "win", banner: null };
    case "cancelled":
      return { label: "Cancelled", tone: "muted", banner: null };
    case "active": {
      if (billing && billing.stoppedNumbers > 0) {
        return {
          label: "Billing stopped",
          tone: "loss",
          banner: `${numbers(billing.stoppedNumbers)} stopped sending because a payment could not be taken. Add a card to restart.`,
        };
      }
      if (billing && billing.pastDueNumbers > 0) {
        return {
          label: "Payment failed",
          tone: "loss",
          banner: `Payment failed for ${numbers(billing.pastDueNumbers)} — update your card. Sending continues while we retry.`,
        };
      }
      return { label: "Active", tone: "win", banner: null };
    }
    // `pending`: signup Checkout abandoned. The rest are statuses from the old
    // one-subscription-per-account model; none of them has a card on file now.
    case "pending":
    case "trialing":
    case "past_due":
    case "paused":
      return { label: "No card yet", tone: "warn", banner: NO_CARD_BANNER };
  }
}

/** True when the page should offer "Add a card": a card is on file but some numbers stopped on billing. */
export function needsCard(account: AccountSummary, billing: Pick<BillingSummary, "stoppedNumbers">): boolean {
  return account.billingStatus === "active" && billing.stoppedNumbers > 0;
}

/** The single most important reason a row needs attention, or null. */
export function needsAttention(row: LocationRow): string | null {
  if (row.state.kind === "disconnected") {
    const n = row.state.waiting;
    return `Disconnected — ${n} ${n === 1 ? "message" : "messages"} waiting`;
  }
  if (row.state.kind === "waiting_qr") return "Waiting for QR scan";
  if (row.providerNudge) return "No messages from GoHighLevel yet. Is the Telephony Provider set?";
  // Setup's last step, shown the moment WhatsApp connects. Ticks itself off
  // when GoHighLevel's first message arrives (that proves the provider is set).
  if (row.awaitingFirstMessage) return "Last step: set the Telephony Provider in GoHighLevel, then send a test message";
  if (row.activated && row.dailyCap > 0 && row.sentToday >= row.dailyCap) return "Daily cap reached";
  return null;
}

/** How close a row is to its daily cap: "full" at the cap, "near" from 90%. */
export type CapLevel = "ok" | "near" | "full";

export function capLevel(row: LocationRow): CapLevel {
  if (!row.activated || row.dailyCap <= 0) return "ok";
  if (row.sentToday >= row.dailyCap) return "full";
  return row.sentToday / row.dailyCap >= 0.9 ? "near" : "ok";
}

/** The at-a-glance counts at the top of the dashboard. Every figure is a plain count of the rows. */
export interface FleetSummary {
  connected: number;
  offline: number;
  /** Messages held across every offline number. */
  waiting: number;
  awaitingScan: number;
  sentToday: number;
  attention: number;
}

export function fleetSummary(rows: LocationRow[]): FleetSummary {
  const sum: FleetSummary = { connected: 0, offline: 0, waiting: 0, awaitingScan: 0, sentToday: 0, attention: 0 };
  for (const r of rows) {
    if (r.state.kind === "connected") sum.connected += 1;
    if (r.state.kind === "disconnected") {
      sum.offline += 1;
      sum.waiting += r.state.waiting;
    }
    if (r.state.kind === "waiting_qr") sum.awaitingScan += 1;
    if (r.activated) sum.sentToday += r.sentToday;
    if (needsAttention(r) !== null) sum.attention += 1;
  }
  return sum;
}

/** e.g. "2 numbers billed · £19.98/month". Volume pricing over the account's billed numbers. */
export function headline(billedNumbers: number): string {
  const cost = formatMoney(monthlyCostPence(billedNumbers) / 100, pricingConfig().currency);
  return `${numbers(billedNumbers)} billed · ${cost}/month`;
}

export interface RowActions {
  activate: boolean;
  showQr: boolean;
  sendLink: boolean;
  disconnect: boolean;
  deactivate: boolean;
}

export function rowActionsFor(row: LocationRow): RowActions {
  const connected = row.state.kind === "connected";
  return {
    activate: !row.activated,
    showQr: row.state.kind === "waiting_qr",
    sendLink: row.activated && !connected,
    disconnect: connected,
    deactivate: row.activated,
  };
}

export interface PrimaryAction {
  /** Matches a RowActions key; the row action treats it as an intent. */
  key: "activate" | "show-qr";
  label: string;
}

/** The one action worth showing inline on a row, or null (connected rows need none). Built on rowActionsFor. */
export function primaryActionFor(row: LocationRow): PrimaryAction | null {
  const a = rowActionsFor(row);
  if (a.activate) return { key: "activate", label: "Activate" };
  if (a.showQr) return { key: "show-qr", label: "Show QR" };
  if (a.sendLink) return { key: "show-qr", label: "Reconnect" };
  return null;
}
