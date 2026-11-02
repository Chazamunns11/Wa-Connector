"use server";

import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import type { ActivateDeps } from "@/lib/billing/activate";
import { platformCap } from "@/lib/billing/activation";
import { numberBillingDeps } from "@/lib/billing/live-deps";
import { repo } from "@/lib/data";
import { runRowAction } from "@/lib/site/row-action";
import { logoutWhatsappSession } from "@/lib/whatsapp-bridge";

function activateDeps(): ActivateDeps {
  return {
    ...numberBillingDeps(),
    now: () => new Date(),
    platformCap,
  };
}

/** Every dashboard row button; see runRowAction for the ownership rules. */
export async function rowAction(formData: FormData): Promise<void> {
  const session = await requireAccountSession();
  redirect(await runRowAction(repo, { activate: activateDeps(), logout: logoutWhatsappSession }, session, formData));
}
