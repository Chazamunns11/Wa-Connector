/**
 * Route guard (Next.js 16 renamed the `middleware.ts` convention to
 * `proxy.ts`). The shape of PortalHub `src/proxy.ts`'s `liveProxy`: refresh
 * the Supabase session cookie per the @supabase/ssr proxy pattern, then gate
 * the one guarded prefix. There is no demo mode and no booking-host rewrite
 * here (both Hub-only).
 *
 * `/admin/**` needs an OWNER session: no signed-in user, or a user whose
 * `profiles.role` isn't `owner`, is redirected to `/login`. The role lookup
 * is one indexed primary-key read, and it only runs for `/admin` paths — the
 * same "one cheap optimistic role check" PortalHub's proxy makes at `/`.
 * The admin page and every admin server action still re-check with
 * `getSession()`/`assertOwner()` (src/lib/auth.ts): this is the optimistic
 * check, not the authorization (node_modules/next/dist/docs/01-app/
 * 01-getting-started/16-proxy.md).
 *
 * `/dashboard/**` needs a signed-in user (no role lookup): the page's
 * `requireAccountSession()` (src/lib/account-session.ts) is the authorisation.
 *
 * Everything else — `/login`, `/auth/callback`, `/embed/crm`,
 * `/connect/[token]` — falls through with the refreshed-session response.
 * API routes are excluded by the matcher (webhooks must never be redirected
 * to /login).
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getProfile } from "@/lib/auth";

const OWNER_PREFIX = "/admin";
const APP_PREFIX = "/dashboard";

function isAppPath(pathname: string): boolean {
  return pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`);
}

function isOwnerPath(pathname: string): boolean {
  return pathname === OWNER_PREFIX || pathname.startsWith(`${OWNER_PREFIX}/`);
}

function redirectTo(request: NextRequest, pathname: string, carryCookiesFrom?: NextResponse) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  const response = NextResponse.redirect(url);
  carryCookiesFrom?.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Public pages (marketing, signup, login) must render before Supabase is
    // configured; only the guarded prefix needs it.
    if (isOwnerPath(pathname) || isAppPath(pathname)) {
      throw new Error("Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are both required.");
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser() (not getSession()) — validates the token against Supabase Auth
  // rather than trusting the cookie payload, and refreshes it if expired.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (isOwnerPath(pathname)) {
    if (!user) return redirectTo(request, "/login", response);
    const profile = await getProfile(user.id);
    if (profile?.role !== "owner") return redirectTo(request, "/login", response);
  }

  if (isAppPath(pathname)) {
    // Optimistic only: signed in is enough here. requireAccountSession() on
    // the page decides whether this user may see a dashboard at all.
    if (!user) return redirectTo(request, "/login", response);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on everything except Next internals, static files and API routes
     * (webhooks must never be redirected to /login).
     */
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};
