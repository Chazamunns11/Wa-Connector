"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { brandConfig } from "@/lib/brand-config";

/**
 * Owner sign-in: email a Supabase OTP sign-in link.
 *
 * PKCE, ON PURPOSE — the client is `@supabase/ssr`'s `createServerClient`
 * with a mutable cookie jar (PortalHub `src/lib/auth-otp.ts`'s
 * `createOtpClient`): the code verifier lands in this browser's cookies and
 * `/auth/callback` reads `?code=` on the SERVER, which is the only shape a
 * server can ever see (a fragment never reaches it). The link therefore has
 * to be opened in the browser that asked for it.
 *
 * `shouldCreateUser: false` — this form never creates an auth user. Owners
 * are provisioned (auth user + `profiles` row) by the operator; an unknown
 * address gets no email. The page shows the SAME "check your inbox" result
 * either way, so this form can't be used to probe which addresses exist.
 */
export async function sendLoginLinkAction(formData: FormData): Promise<void> {
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email || !email.includes("@") || email.length > 320) {
    redirect("/login?error=invalid_email");
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are both required.");
  }

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
  if (error) {
    // Logged, never shown: see this function's JSDoc on enumeration.
    console.warn("[login] signInWithOtp refused:", error.message);
  }

  redirect("/login?sent=1");
}

/** Ends the session (cookie client, so the auth cookies are cleared) and returns to /login. */
export async function signOutAction(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anonKey) {
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
    await supabase.auth.signOut();
  }
  redirect("/login");
}
