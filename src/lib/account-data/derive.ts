import { formatMoney, monthlyCostPence, pricingConfig, TRIAL_DAYS, TRIAL_MAX_SUB_ACCOUNTS } from "@/lib/pricing";
import type { AccountSummary, LocationRow } from "./types";

const DAY_MS = 86_400_000;

/** Whole days left (rounded up), never negative; null or unparseable → 0. */
export function trialDaysLeft(trialEndsAt: string | null, now: Date): number {
  if (!trialEndsAt) return 0;
  const end = Date.parse(trialEndsAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
}

export interface PlanStatus {
  label: string;
  tone: "win" | "warn" | "loss" | "info" | "muted";
  banner: string | null;
}

/** Shown on the dashboard and billing page once a trial has ended with no card. */
export const TRIAL_ENDED_NO_CARD = "Your trial has ended. Add a card to keep sending.";

/** Days before the trial ends when a trial with no card starts showing the reminder. */
export const TRIAL_REMINDER_DAYS = 2;

/**
 * `hasCard` is only known where the page has read the Stripe subscription;
 * when it is false, a trial in its last days gets an "add a card" reminder.
 */
export function planStatus(account: AccountSummary, now: Date, opts: { hasCard?: boolean } = {}): PlanStatus {
  switch (account.billingStatus) {
    case "pending":
      // Checkout abandoned: the dashboard offers a working "start your trial" button.
      return { label: "Trial not started", tone: "warn", banner: `Finish signing up to start your ${TRIAL_DAYS}-day free trial. No card needed.` };
    case "trialing": {
      const n = trialDaysLeft(account.trialEndsAt, now);
      if (n === 0) return { label: "Trial ended", tone: "warn", banner: null };
      const banner =
        opts.hasCard === false && n <= TRIAL_REMINDER_DAYS
          ? `Your trial ends in ${n} ${n === 1 ? "day" : "days"}. Add a card to keep sending.`
          : null;
      return { label: `Trial: ${n} ${n === 1 ? "day" : "days"} left`, tone: "warn", banner };
    }
    case "active":
    case "comped":
      return { label: "Active", tone: "win", banner: null };
    case "past_due":
      return {
        label: "Payment failed",
        tone: "loss",
        banner: "Payment failed — update your card. Sending continues while we retry.",
      };
    case "paused":
      // Stripe `paused` (trial ended, no card) keeps trialEndsAt; `unpaid` (retries ran out) does not.
      if (account.trialEndsAt) return { label: "Trial ended", tone: "loss", banner: TRIAL_ENDED_NO_CARD };
      return { label: "Paused", tone: "loss", banner: "Sending is paused — update billing to resume" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted", banner: null };
  }
}

/** True when the dashboard should offer "Add a card": a trial ended with no card, or a trial with none in its last days. */
export function needsCard(account: AccountSummary, now: Date, hasCard: boolean | undefined): boolean {
  if (account.billingStatus === "paused") return !!account.trialEndsAt;
  if (account.billingStatus !== "trialing" || hasCard !== false) return false;
  const n = trialDaysLeft(account.trialEndsAt, now);
  return n > 0 && n <= TRIAL_REMINDER_DAYS;
}

/** The single most important reason a row needs attention, or null. */
export function needsAttention(row: LocationRow): string | null {
  if (row.state.kind === "disconnected") {
    const n = row.state.waiting;
    return `Disconnected — ${n} ${n === 1 ? "message" : "messages"} waiting`;
  }
  if (row.state.kind === "waiting_qr") return "Waiting for QR scan";
  if (row.providerNudge) return "No messages from GoHighLevel yet. Is the Telephony Provider set?";
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

export function activeCount(rows: LocationRow[]): number {
  return rows.filter((r) => r.activated).length;
}

/** e.g. "2 sub-accounts active · £29.98/month". Volume pricing over activated sub-accounts. */
export function headline(rows: LocationRow[]): string {
  const n = activeCount(rows);
  const cost = formatMoney(monthlyCostPence(n) / 100, pricingConfig().currency);
  return `${n} ${n === 1 ? "sub-account" : "sub-accounts"} active · ${cost}/month`;
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

/** Shown when a trialing account tries to activate past the trial cap. */
export const TRIAL_CAP_MESSAGE = `Your trial includes ${TRIAL_MAX_SUB_ACCOUNTS} sub-accounts. Start your paid plan now to add more.`;
