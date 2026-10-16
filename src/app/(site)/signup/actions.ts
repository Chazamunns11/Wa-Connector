"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { brandConfig } from "@/lib/brand-config";
import { applyCheckoutSession, prepareSignup } from "@/lib/billing/onboard";
import { repo } from "@/lib/data";
import { signupRedirectQuery, validateSignup } from "@/lib/site/signup";
import { isStripeConfigured } from "@/lib/stripe/client";
import { retrieveCheckoutSession } from "@/lib/stripe/billing";

/** The claim token travels only in the form and the URL; it is never logged. */
function readClaim(formData: FormData): string | undefined {
  const raw = formData.get("claim");
  return typeof raw === "string" && raw ? raw.slice(0, 200) : undefined;
}

function signupUrl(query: URLSearchParams, claim: string | undefined, hash = ""): string {
  if (claim) query.set("claim", claim);
  return `/signup?${query.toString()}${hash}`;
}

function supabaseUrlAndKey(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/**
 * Step 1 of signup: validate, then email a sign-in link. Nothing is created
 * here beyond Supabase's own unconfirmed auth user: the account, profile and
 * Checkout only happen in /auth/callback once the link proves the address.
 * PKCE: signInWithOtp sets the verifier cookie, so the link must be opened in
 * this browser.
 */
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
  const keys = supabaseUrlAndKey();
  if (!isStripeConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY || !keys) {
    redirect(signupUrl(new URLSearchParams({ error: "unavailable" }), claim));
  }

  const prepared = await prepareSignup(repo, { ...result.value, claim: claim ?? null });
  if (prepared.kind === "exists") redirect("/login?error=exists");

  const cookieStore = await cookies();
  const supabase = createServerClient(keys.url, keys.anonKey, {
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
    email: prepared.email,
    options: {
      emailRedirectTo: `${brandConfig().appUrl}/auth/callback`,
      shouldCreateUser: true,
      data: prepared.data,
    },
  });
  if (error) {
    console.warn("[signup] signInWithOtp refused:", error.message);
    redirect(signupUrl(new URLSearchParams({ error: "failed" }), claim));
  }
  redirect("/signup/check-email");
}

/**
 * After Checkout: retrieve the session, apply it to the account (the webhook
 * may already have). The owner confirmed their email to start signup so they
 * are normally signed in already and go straight to the dashboard; otherwise
 * (another browser, expired session) email the sign-in link. Runs as an action because
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
  const {
    data: { user: current },
  } = await supabase.auth.getUser();
  if (current?.email?.toLowerCase() === email.toLowerCase()) redirect("/dashboard");
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${brandConfig().appUrl}/auth/callback`, shouldCreateUser: false },
  });
  if (error) console.warn("[signup] signInWithOtp refused:", error.message);
  redirect("/login?sent=1");
}
