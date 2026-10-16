import type { AccountKind, BillingStatus } from "@/lib/types";

export type { AccountKind, BillingStatus };

export interface AccountSummary {
  id: string;
  name: string;
  kind: AccountKind;
  email: string;
  billingStatus: BillingStatus;
  /** ISO timestamp, or null when there is no trial. */
  trialEndsAt: string | null;
}

export type WhatsappState =
  | { kind: "not_active" }
  | { kind: "waiting_qr" }
  | { kind: "connected"; number: string }
  | { kind: "disconnected"; waiting: number };

export interface LocationRow {
  id: string;
  name: string;
  activated: boolean;
  state: WhatsappState;
  sentToday: number;
  dailyCap: number;
  heldMessages: number;
  failedLast7Days: { count: number; reasons: string[] };
  optOuts: number;
  providerNudge: boolean;
}

export interface BillingSummary {
  cardLast4: string | null;
  /** ISO timestamp. */
  nextInvoiceAt: string | null;
  /** Major units, in `currency`. */
  nextInvoiceAmount: number | null;
  /** ISO 4217 code of `nextInvoiceAmount` (from pricingConfig()). */
  currency: string;
  portalAvailable: boolean;
}

export interface AccountDataSource {
  readonly preview: boolean;
  getAccount(): Promise<AccountSummary>;
  listLocations(): Promise<LocationRow[]>;
  getBilling(): Promise<BillingSummary>;
}
