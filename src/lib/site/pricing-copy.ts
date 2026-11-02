import { TRIAL_DAYS, pricingConfig, tierSentence } from "@/lib/pricing";

export interface PricingCopy {
  trialTerms: string[];
  failedPayment: string[];
  cancel: string;
}

/** Trial and billing facts for /pricing. Prices come from src/lib/pricing.ts. */
export function pricingCopy(): PricingCopy {
  return {
    // One paragraph (Task 13C). Kept as an array because /docs/billing renders it.
    trialTerms: [
      `Save a card once, then each number you add gets its own ${TRIAL_DAYS}-day free trial. Nothing is charged until that number's trial ends. After that it's ${tierSentence(pricingConfig().currency)} Each number is billed per month as its own payment, on the day its trial ended.`,
    ],
    failedPayment: [
      "If a payment fails, Stripe retries it for about 7 days. That number keeps sending while that happens, and a banner on your dashboard asks you to update the card.",
      "If it still ends unpaid, that number stops sending until you pay.",
    ],
    cancel:
      "You can cancel any time. Removing a number, or deactivating its sub-account, stops its billing straight away, and any unused part of the month is credited to your next bill.",
  };
}
