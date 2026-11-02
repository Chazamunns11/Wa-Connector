import { TRIAL_DAYS, TRIAL_MAX_NUMBERS, pricingConfig, priceSentence } from "@/lib/pricing";

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
      `${TRIAL_DAYS}-day free trial, no card needed. The trial covers up to ${TRIAL_MAX_NUMBERS} WhatsApp numbers. If it ends before you add a card, sending pauses until you add one. After that it's ${priceSentence(pricingConfig().currency)} Billed monthly in advance. A number you add is charged straight away for the rest of the month, and one you remove is credited to your next bill.`,
    ],
    failedPayment: [
      "If a payment fails, Stripe retries it for about 7 days. Sending continues while that happens, and a banner on your dashboard asks you to update the card.",
      "If the subscription still ends unpaid, sending pauses until you pay.",
    ],
    cancel:
      "You can cancel any time from the billing portal. It takes effect at the end of the period you've paid for, and your numbers keep sending until then.",
  };
}
