/**
 * GET /auth/callback — the owner sign-in link lands here with `?code=`.
 * The shape of PortalHub `src/app/auth/callback/route.ts`: exchange the code
 * for a session (PKCE — the verifier cookie was set by
 * `sendLoginLinkAction`, src/app/login/actions.ts), then redirect.
 *
 * Role-aware: an owner goes to `/admin`, an account with an `account_id` to
 * `/dashboard`; anything else is signed out and sent to
 * `/login?error=no_account`. A missing code or a failed exchange goes to
 * `/login?error=auth_callback`, which the login page explains.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (code && url && anonKey) {
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

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const profile = user ? await getProfile(user.id) : null;
      if (profile?.role === "owner") return NextResponse.redirect(`${origin}/admin`);
      if (profile?.role === "account" && profile.accountId) return NextResponse.redirect(`${origin}/dashboard`);
      // Signed in but belongs to nothing: drop the session rather than leave a dangling login.
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=no_account`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
