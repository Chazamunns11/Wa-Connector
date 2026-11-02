import type { BillingStatus } from "@/lib/types";

export type ActivateRefusal = "already_active" | "billing_inactive" | "platform_cap";

/** Thrown by the repository when the database refuses an activation at the platform cap (the race backstop). */
export class ActivationCapError extends Error {
  readonly reason: "platform_cap";
  constructor(reason: "platform_cap") {
    super(reason);
    this.reason = reason;
    this.name = "ActivationCapError";
  }
}

/**
 * Accounts that may add (and so be billed for) numbers: a card is on file
 * (`active`, set when the setup Checkout completes) or the account is comped.
 * A `pending` account has no card yet, so it is refused.
 */
const CARD_ON_FILE: ReadonlySet<BillingStatus> = new Set(["active", "comped"]);

export const hasCardOnFile = (status: BillingStatus): boolean => CARD_ON_FILE.has(status);

/** Precedence: already_active, billing_inactive, platform_cap. */
export function canActivate(input: {
  billingStatus: BillingStatus;
  alreadyActive: boolean;
  platformActive: number;
  platformCap: number | null;
}): { ok: true } | { ok: false; reason: ActivateRefusal } {
  if (input.alreadyActive) return { ok: false, reason: "already_active" };
  if (!hasCardOnFile(input.billingStatus)) return { ok: false, reason: "billing_inactive" };
  if (input.platformCap !== null && input.platformActive >= input.platformCap) {
    return { ok: false, reason: "platform_cap" };
  }
  return { ok: true };
}

/** `BRAND_MAX_ACTIVE_NUMBERS` as a positive integer, else null (no cap). */
export function platformCap(): number | null {
  const raw = process.env.BRAND_MAX_ACTIVE_NUMBERS;
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
