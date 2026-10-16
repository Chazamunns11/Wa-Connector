/**
 * Session helpers — the shape of PortalHub `src/lib/auth.ts`'s
 * `getLiveSession`, cut down to this app's `profiles` columns (`role`,
 * `email`) and its two roles (`owner` | `account`). There is no demo mode:
 * the session always comes from the authenticated Supabase user.
 *
 * TWO CLIENTS, DELIBERATELY: the request-scoped cookie client (anon key)
 * proves WHO is signed in (`auth.getUser()` validates the token against
 * Supabase Auth rather than trusting the cookie payload); the `profiles` row
 * is then read with the service-role client, because `profiles` has RLS on
 * and no policies (supabase/migrations/0001_init.sql) — the anon client can
 * never see it. The only id the service read is keyed on is the one Supabase
 * Auth just vouched for.
 */
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/types";

export interface Session {
  /** `profiles.id` = `auth.users.id`. */
  profileId: string;
  role: Role;
  /** `profiles.email` — the address the owner signs in with. */
  email: string;
}

const VALID_ROLES: Role[] = ["owner", "account"];

export function isRole(value: string | undefined | null): value is Role {
  return !!value && VALID_ROLES.includes(value as Role);
}

interface ProfileRow {
  role: string;
  email: string;
}

/**
 * Request-scoped Supabase server client (cookies from `next/headers`), built
 * per the @supabase/ssr conventions.
 */
async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are both required.");
  }
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component render with no mutable response —
          // safe to ignore; session refresh is handled by proxy.ts.
        }
      },
    },
  });
}

/**
 * Read one `profiles` row's role through the service-role client (see this
 * file's header for why). Shared with `src/proxy.ts`'s `/admin` check so the
 * two can never disagree on what "owner" means. `null` for no row, a read
 * error, or an unconfigured service key — every one of those is "not an
 * owner", never a throw that could 500 a page.
 */
export async function getProfile(userId: string): Promise<{ role: Role; email: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await supabase.from("profiles").select("role, email").eq("id", userId).maybeSingle();
  if (error || !data) return null;
  const profile = data as ProfileRow;
  if (!isRole(profile.role)) return null;
  return { role: profile.role, email: profile.email };
}

/** Read the signed-in user + their `profiles` row. */
async function getLiveSession(): Promise<Session | null> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return null;

  const profile = await getProfile(user.id);
  if (!profile) return null;

  return { profileId: user.id, role: profile.role, email: profile.email };
}

/** Read the current session (server components/actions/route handlers only). */
export async function getSession(): Promise<Session | null> {
  return getLiveSession();
}

/** Throws unless the current session is an owner. Call first in every owner server action. */
export async function assertOwner(): Promise<Session> {
  const session = await getSession();
  if (!session || session.role !== "owner") {
    throw new Error("Unauthorized: no owner session");
  }
  return session;
}
