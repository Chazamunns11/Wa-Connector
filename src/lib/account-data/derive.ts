import { formatMoney, monthlyCost, type PricingConfig } from "@/lib/pricing";
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

export function planStatus(account: AccountSummary, now: Date): PlanStatus {
  switch (account.billingStatus) {
    case "trialing": {
      const n = trialDaysLeft(account.trialEndsAt, now);
      return { label: `Trial: ${n} ${n === 1 ? "day" : "days"} left`, tone: "warn", banner: null };
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
      return { label: "Paused", tone: "loss", banner: "Sending is paused — update billing to resume" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted", banner: null };
  }
}

/** The single most important reason a row needs attention, or null. */
export function needsAttention(row: LocationRow): string | null {
  if (row.state.kind === "disconnected") {
    const n = row.state.waiting;
    return `Disconnected — ${n} ${n === 1 ? "message" : "messages"} waiting`;
  }
  if (row.state.kind === "waiting_qr") return "Waiting for QR scan";
  if (row.providerNudge) return "No messages from GHL yet. Is the Telephony Provider set?";
  if (row.activated && row.sentToday >= row.dailyCap) return "Daily cap reached";
  return null;
}

export function activeCount(rows: LocationRow[]): number {
  return rows.filter((r) => r.activated).length;
}

/** e.g. "2 numbers active · £58/month". Price per activated number (W14). */
export function headline(rows: LocationRow[], pricing: PricingConfig): string {
  const n = activeCount(rows);
  const cost = formatMoney(monthlyCost(n, pricing.pricePerNumber), pricing.currency);
  return `${n} ${n === 1 ? "number" : "numbers"} active · ${cost}/month`;
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
