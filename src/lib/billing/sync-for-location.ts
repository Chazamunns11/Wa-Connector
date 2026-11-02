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
import { chargeForNewNumber, syncSubscriptionQuantity } from "./quantity";
import { TRIAL_CAP_MESSAGE } from "@/lib/account-data/derive";

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

/** Shown when the new number's payment didn't go through; the number is not added. */
export const NUMBER_PAYMENT_DECLINED =
  "Your card was declined, so the number wasn't added. Update your card in Billing, then try again.";
export const NUMBER_PAYMENT_FAILED = "We couldn't take payment for the new number just now, so it wasn't added. Please try again.";

/**
 * Per-number billing: charge for a new number BEFORE it is added (see
 * `chargeForNewNumber`). `{ ok: false, message }` means: don't add it.
 */
export async function chargeBeforeAddingNumber(locationId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await chargeForNewNumber(repo, { retrieveSubscription, setQuantity: setSubscriptionItemQuantity }, locationId);
    if (r.ok) return { ok: true };
    return {
      ok: false,
      message: r.reason === "declined" ? NUMBER_PAYMENT_DECLINED : r.reason === "trial_cap" ? TRIAL_CAP_MESSAGE : NUMBER_PAYMENT_FAILED,
    };
  } catch (err) {
    console.error("[billing] charge for a new number failed:", err);
    return { ok: false, message: NUMBER_PAYMENT_FAILED };
  }
}
