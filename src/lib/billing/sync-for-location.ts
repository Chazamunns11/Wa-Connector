/**
 * Per-number billing (Nov 2026): after a number is added to or removed from a
 * sub-account, bring the owning account's Stripe quantity up to date. Called
 * from the dashboard number actions and the in-HighLevel numbers route.
 * Never throws and never blocks the number change itself: a Stripe failure is
 * reported to Slack by `syncSubscriptionQuantity` and the next activation,
 * deactivation or number change re-syncs to the true count.
 */
import { repo } from "@/lib/data";
import { notifyText } from "@/lib/slack";
import { retrieveSubscription, setSubscriptionItemQuantity } from "@/lib/stripe/billing";
import { syncSubscriptionQuantity } from "./quantity";

export async function syncQuantityForLocation(locationId: string): Promise<void> {
  try {
    const location = await repo.getGhlAccountByLocationId(locationId);
    if (!location?.accountId) return; // unclaimed sub-account: nobody is billed
    const account = await repo.getAccountById(location.accountId);
    if (!account) return;
    await syncSubscriptionQuantity(
      repo,
      { retrieveSubscription, setQuantity: setSubscriptionItemQuantity, notify: (text) => void notifyText(text) },
      account,
    );
  } catch (err) {
    console.error("[billing] quantity sync after a number change failed:", err);
  }
}
