"use server";

import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import { activateLocation, deactivateLocation, type ActivateDeps } from "@/lib/billing/activate";
import { platformCap, type ActivateRefusal } from "@/lib/billing/activation";
import { repo } from "@/lib/data";
import { notifyText } from "@/lib/slack";
import { dashboardHref, parseFilter, type DashboardResult } from "@/lib/site/dashboard-url";
import { retrieveSubscription, setSubscriptionItemQuantity } from "@/lib/stripe/billing";
import { logoutWhatsappSession } from "@/lib/whatsapp-bridge";

const INTENTS = ["activate", "deactivate", "disconnect", "send-link", "show-qr"] as const;
type Intent = (typeof INTENTS)[number];

function activateDeps(): ActivateDeps {
  return {
    retrieveSubscription,
    setQuantity: setSubscriptionItemQuantity,
    notify: (text) => {
      void notifyText(text);
    },
    now: () => new Date(),
    platformCap,
  };
}

const REFUSAL_RESULT: Record<ActivateRefusal | "not_found" | "stripe_failed", DashboardResult> = {
  already_active: "activated",
  billing_inactive: "billing_inactive",
  trial_cap: "trial_cap",
  platform_cap: "platform_cap",
  not_found: "not_found",
  stripe_failed: "stripe_failed",
};

/**
 * Every dashboard row button. The form's location id is only a claim: it is
 * checked against the signed-in account's own locations before anything runs,
 * and the WhatsApp tenant id is read from that owned row, never from the form.
 */
export async function rowAction(formData: FormData): Promise<void> {
  const session = await requireAccountSession();
  const filter = parseFilter(String(formData.get("filter") ?? ""));
  const intent = String(formData.get("intent") ?? "");
  const locationId = String(formData.get("location") ?? "");
  const back = (result: DashboardResult) => dashboardHref({ filter, result, focus: locationId });

  const owned = (await repo.listGhlAccountsForAccount(session.accountId)).find((a) => a.locationId === locationId);
  if (!owned || !(INTENTS as readonly string[]).includes(intent)) redirect(dashboardHref({ filter, result: "not_found" }));

  switch (intent as Intent) {
    case "activate": {
      const outcome = await activateLocation(repo, activateDeps(), session.accountId, locationId);
      redirect(back(outcome.ok ? "activated" : REFUSAL_RESULT[outcome.reason]));
    }
    case "deactivate": {
      const outcome = await deactivateLocation(repo, activateDeps(), session.accountId, locationId);
      redirect(back(outcome.ok ? "deactivated" : "not_found"));
    }
    case "disconnect": {
      const outcome = await logoutWhatsappSession(owned.tenantId);
      redirect(back(outcome.ok ? "disconnected" : "bridge_failed"));
    }
    case "send-link":
      // The page mints the link for the focused row; the token never rides in the URL.
      redirect(back("link"));
    case "show-qr":
      redirect(dashboardHref({ filter, focus: locationId, qr: locationId }));
  }
}
