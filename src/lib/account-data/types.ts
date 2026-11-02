import type { AccountKind, BillingStatus } from "@/lib/types";

export type { AccountKind, BillingStatus };

export interface AccountSummary {
  id: string;
  name: string;
  kind: AccountKind;
  email: string;
  /** `pending` = no card yet, `active` = card on file, `comped` = never billed. */
  billingStatus: BillingStatus;
  stripeCustomerId: string | null;
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
  /** How many WhatsApp numbers the sub-account has (per-number billing counts these while it is activated). */
  numbers: number;
  /** Connected, but GoHighLevel has never sent this sub-account a message, so the Telephony Provider is probably not set yet. Shown at once as the last setup step (no 24h wait, unlike `providerNudge`). */
  awaitingFirstMessage?: boolean;
}

/** Billing is per WhatsApp number: these are counts over the account's numbers (ghl_location_numbers). */
export interface BillingSummary {
  /** Only read from Stripe when asked for (`getBilling({ withCard: true })`). */
  cardLast4: string | null;
  /** Numbers that count toward the tier: trialing, active or past due. */
  billedNumbers: number;
  /** Of those, still in their free trial. */
  trialingNumbers: number;
  /** Of those, with a failed payment Stripe is retrying (still sending). */
  pastDueNumbers: number;
  /** Numbers whose billing stopped them sending (Stripe paused, unpaid or incomplete). */
  stoppedNumbers: number;
  /** The month at the current tier, every number at the tier price. Major units, in `currency`. */
  monthlyAmount: number;
  /** ISO 4217 code of `monthlyAmount` (from pricingConfig()). */
  currency: string;
  portalAvailable: boolean;
}

export interface AccountDataSource {
  readonly preview: boolean;
  getAccount(): Promise<AccountSummary>;
  listLocations(): Promise<LocationRow[]>;
  /** One database read; `withCard` adds one Stripe read for the card on file. */
  getBilling(opts?: { withCard?: boolean }): Promise<BillingSummary>;
}
