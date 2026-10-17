import { activateLocation, deactivateLocation, type ActivateDeps, type ActivateRepo } from "@/lib/billing/activate";
import type { ActivateRefusal } from "@/lib/billing/activation";
import type { GhlRepository } from "@/lib/data/repository";
import { dashboardHref, parseFilter, type DashboardResult } from "@/lib/site/dashboard-url";

export const INTENTS = ["activate", "deactivate", "disconnect", "send-link", "show-qr"] as const;
type Intent = (typeof INTENTS)[number];

export type RowActionRepo = ActivateRepo & Pick<GhlRepository, "listGhlAccountsForAccount">;

export interface RowActionDeps {
  activate: ActivateDeps;
  logout: (tenantId: string) => Promise<{ ok: boolean }>;
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
 * Every dashboard row button, as a pure function returning the redirect href.
 * The form's location id is only a claim: it is checked against the signed-in
 * account's own locations before anything runs, and the WhatsApp tenant id is
 * read from that owned row, never from the form.
 */
export async function runRowAction(
  repo: RowActionRepo,
  deps: RowActionDeps,
  session: { accountId: string },
  formData: FormData,
): Promise<string> {
  const filter = parseFilter(String(formData.get("filter") ?? ""));
  const intent = String(formData.get("intent") ?? "");
  const locationId = String(formData.get("location") ?? "");
  const back = (result: DashboardResult) => dashboardHref({ filter, result, focus: locationId });

  const owned = (await repo.listGhlAccountsForAccount(session.accountId)).find((a) => a.locationId === locationId);
  if (!owned || !(INTENTS as readonly string[]).includes(intent)) return dashboardHref({ filter, result: "not_found" });

  switch (intent as Intent) {
    case "activate": {
      const outcome = await activateLocation(repo, deps.activate, session.accountId, locationId);
      return back(outcome.ok ? "activated" : REFUSAL_RESULT[outcome.reason]);
    }
    case "deactivate": {
      const outcome = await deactivateLocation(repo, deps.activate, session.accountId, locationId);
      if (!outcome.ok) return back("not_found");
      return back(outcome.quantitySynced ? "deactivated" : "deactivated_billing_pending");
    }
    case "disconnect": {
      const outcome = await deps.logout(owned.tenantId);
      return back(outcome.ok ? "disconnected" : "bridge_failed");
    }
    case "send-link":
      // The page mints the link for the focused row; the token never rides in the URL.
      return back("link");
    case "show-qr":
      return dashboardHref({ filter, focus: locationId, qr: locationId });
  }
}
