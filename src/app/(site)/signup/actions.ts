"use server";

import { redirect } from "next/navigation";
import { checkoutQuery, signupRedirectQuery, validateSignup } from "@/lib/site/signup";

/**
 * Preview only: validates the form and redirects. It creates no account,
 * sends no email and takes no payment.
 */
export async function previewSignupAction(formData: FormData): Promise<void> {
  const result = validateSignup({
    accountName: formData.get("accountName"),
    kind: formData.get("kind"),
    email: formData.get("email"),
  });
  if (!result.ok) {
    const claim = formData.get("claim");
    const q = new URLSearchParams(signupRedirectQuery(result));
    if (typeof claim === "string" && claim) q.set("claim", claim.slice(0, 200));
    redirect(`/signup?${q.toString()}`);
  }
  redirect(`/signup/checkout${checkoutQuery(result.value)}`);
}
