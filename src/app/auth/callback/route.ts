/**
 * GET /auth/callback — the owner sign-in link lands here with `?code=`.
 * The shape of PortalHub `src/app/auth/callback/route.ts`: exchange the code
 * for a session (PKCE — the verifier cookie was set by
 * `sendLoginLinkAction`, src/app/login/actions.ts), then redirect.
 *
 * Success goes to `/admin`; the proxy and the page re-check that the session
 * really is an owner, so a signed-in `account` user simply bounces on to
 * `/login`. A missing code or a failed exchange goes to
 * `/login?error=auth_callback`, which the login page explains.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
      return NextResponse.redirect(`${origin}/admin`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
