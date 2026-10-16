import type { BrandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS } from "@/lib/pricing";

export interface PricingCopy {
  trialTerms: string[];
  failedPayment: string[];
  cancel: string;
}

/** Trial and billing facts for /pricing. Prices are rendered from pricingConfig(), not here. */
export function pricingCopy(brand: BrandConfig): PricingCopy {
  const { name } = brand;
  return {
    trialTerms: [
      `${TRIAL_DAYS}-day free trial with up to ${TRIAL_MAX_NUMBERS} numbers`,
      "Card taken up front; nothing is charged until the trial ends",
      `After the trial, ${name} bills one price per connected number, every month`,
    ],
    failedPayment: [
      "If a payment fails, Stripe retries it for about 7 days. Sending continues while that happens, and a banner on your dashboard tells you to update the card.",
      "If the subscription still ends unpaid, sending pauses until you pay.",
    ],
    cancel:
      "Cancel any time from the billing portal. It takes effect at the end of the period you have paid for.",
  };
}
