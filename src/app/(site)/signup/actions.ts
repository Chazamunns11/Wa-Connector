"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { brandConfig } from "@/lib/brand-config";
import { applyCheckoutSession, startSignup } from "@/lib/billing/onboard";
import { repo } from "@/lib/data";
import { verifyClaimToken } from "@/lib/ghl-claim";
import { signupRedirectQuery, validateSignup } from "@/lib/site/signup";
import { isStripeConfigured } from "@/lib/stripe/client";
import { createCheckoutSession, retrieveCheckoutSession } from "@/lib/stripe/billing";

/** The claim token travels only in the form and the URL; it is never logged. */
function readClaim(formData: FormData): string | undefined {
  const raw = formData.get("claim");
  return typeof raw === "string" && raw ? raw.slice(0, 200) : undefined;
}

function signupUrl(query: URLSearchParams, claim: string | undefined, hash = ""): string {
  if (claim) query.set("claim", claim);
  return `/signup?${query.toString()}${hash}`;
}

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function createAuthUser(email: string): Promise<{ id: string } | { error: "exists" | "failed" }> {
  const admin = supabaseAdmin();
  if (!admin) return { error: "failed" };
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) return { error: error && /already/i.test(error.message) ? "exists" : "failed" };
  return { id: data.user.id };
}

/** Validates the form, creates the account and auth user ('pending'), then sends the customer to Stripe Checkout. */
export async function startSignupAction(formData: FormData): Promise<void> {
  const claim = readClaim(formData);
  const result = validateSignup({
    accountName: formData.get("accountName"),
    kind: formData.get("kind"),
    email: formData.get("email"),
  });
  if (!result.ok) {
    redirect(signupUrl(new URLSearchParams(signupRedirectQuery(result)), claim, "#signup-errors"));
  }
  if (!isStripeConfigured() || !supabaseAdmin()) {
    redirect(signupUrl(new URLSearchParams({ error: "unavailable" }), claim));
  }

  const claimLocationId = claim ? (verifyClaimToken(claim)?.locationId ?? null) : null;
  const outcome = await startSignup(
    repo,
    { createAuthUser, checkout: createCheckoutSession, appUrl: brandConfig().appUrl },
    { ...result.value, claimLocationId },
  );
  if (outcome.kind === "checkout") redirect(outcome.url);
  if (outcome.kind === "exists") redirect("/login?error=exists");
  redirect(signupUrl(new URLSearchParams({ error: outcome.kind }), claim));
}

/**
 * After Checkout: retrieve the session, apply it to the account (the webhook
 * may already have), then email the sign-in link. Runs as an action because
 * signInWithOtp sets the PKCE cookie, which a Server Component cannot do.
 */
export async function sendCompleteLinkAction(formData: FormData): Promise<void> {
  const raw = formData.get("session_id");
  const sessionId = typeof raw === "string" && /^cs_[A-Za-z0-9_]{1,200}$/.test(raw) ? raw : null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!sessionId || !url || !anonKey || !isStripeConfigured()) redirect("/login");

  let email: string | null = null;
  const session = await retrieveCheckoutSession(sessionId);
  if (session.ok) {
    const applied = await applyCheckoutSession(repo, session.data);
    if (applied.applied && applied.accountId) {
      email = (await repo.getAccountById(applied.accountId))?.ownerEmail ?? null;
    }
  }
  if (!email) redirect("/login?error=checkout");

  const cookieStore = await cookies();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      },
    },
  });
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${brandConfig().appUrl}/auth/callback`, shouldCreateUser: false },
  });
  if (error) console.warn("[signup] signInWithOtp refused:", error.message);
  redirect("/login?sent=1");
}
