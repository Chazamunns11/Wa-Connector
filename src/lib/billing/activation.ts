import type { BillingStatus } from "@/lib/types";
import { TRIAL_MAX_NUMBERS } from "@/lib/pricing";

export type ActivateRefusal = "already_active" | "billing_inactive" | "trial_cap" | "platform_cap";

const BILLABLE: ReadonlySet<BillingStatus> = new Set(["trialing", "active", "past_due", "comped"]);

/** Precedence: already_active, billing_inactive, trial_cap, platform_cap. */
export function canActivate(input: {
  billingStatus: BillingStatus;
  alreadyActive: boolean;
  accountActive: number;
  platformActive: number;
  platformCap: number | null;
}): { ok: true } | { ok: false; reason: ActivateRefusal } {
  if (input.alreadyActive) return { ok: false, reason: "already_active" };
  if (!BILLABLE.has(input.billingStatus)) return { ok: false, reason: "billing_inactive" };
  if (input.billingStatus === "trialing" && input.accountActive >= TRIAL_MAX_NUMBERS) {
    return { ok: false, reason: "trial_cap" };
  }
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
