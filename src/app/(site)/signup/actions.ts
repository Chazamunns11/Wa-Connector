"use server";

import { redirect } from "next/navigation";
import { checkoutQuery, signupRedirectQuery, validateSignup } from "@/lib/site/signup";

/**
 * Preview only: validates the form and redirects. It creates no account,
 * sends no email and takes no payment.
 */
export async function previewSignupAction(formData: FormData): Promise<void> {
  const rawClaim = formData.get("claim");
  const claim = typeof rawClaim === "string" && rawClaim ? rawClaim.slice(0, 200) : undefined;
  const result = validateSignup({
    accountName: formData.get("accountName"),
    kind: formData.get("kind"),
    email: formData.get("email"),
  });
  if (!result.ok) {
    const q = new URLSearchParams(signupRedirectQuery(result));
    if (claim) q.set("claim", claim);
    redirect(`/signup?${q.toString()}#signup-errors`);
  }
  redirect(`/signup/checkout${checkoutQuery(result.value, claim)}`);
}
