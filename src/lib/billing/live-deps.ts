import { notifyText } from "@/lib/slack";
import { cancelSubscription, createNumberSubscription, retrieveSubscription, setSubscriptionItemPrice } from "@/lib/stripe/billing";
import type { NumberBillingDeps } from "./numbers";

/** The real Stripe calls and Slack notifier behind per-number billing, for routes and server actions. */
export function numberBillingDeps(): NumberBillingDeps {
  return {
    createSubscription: createNumberSubscription,
    retrieveSubscription,
    setPrice: setSubscriptionItemPrice,
    cancel: cancelSubscription,
    notify: (text) => {
      void notifyText(text);
    },
  };
}
