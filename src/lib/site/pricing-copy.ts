import { TRIAL_DAYS, TRIAL_MAX_SUB_ACCOUNTS, pricingConfig, tierSentence } from "@/lib/pricing";

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
      `${TRIAL_DAYS}-day free trial, no card needed. The trial covers up to ${TRIAL_MAX_SUB_ACCOUNTS} sub-accounts. If it ends before you add a card, sending pauses until you add one. After that it's ${tierSentence(pricingConfig().currency)} The price is per activated sub-account, billed monthly, and the tier you reach applies to every sub-account.`,
    ],
    failedPayment: [
      "If a payment fails, Stripe retries it for about 7 days. Sending continues while that happens, and a banner on your dashboard asks you to update the card.",
      "If the subscription still ends unpaid, sending pauses until you pay.",
    ],
    cancel:
      "You can cancel any time from the billing portal. It takes effect at the end of the period you've paid for, and your numbers keep sending until then.",
  };
}
