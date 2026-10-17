/**
 * The signed-in customer account for pages and actions under /dashboard.
 * `requireAccountSession` is the authorisation (the proxy only checks that
 * someone is signed in): owners are sent to /admin, and an account profile
 * with no account is refused rather than shown an empty dashboard.
 */
import { redirect } from "next/navigation";
import { getSession, type Session } from "@/lib/auth";

export interface AccountSession extends Session {
  role: "account";
  accountId: string;
}

export function isAccountSession(s: Session | null): s is AccountSession {
  return !!s && s.role === "account" && typeof s.accountId === "string" && s.accountId.length > 0;
}

export async function requireAccountSession(): Promise<AccountSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "owner") redirect("/admin");
  if (!isAccountSession(session)) redirect("/login?error=no_account");
  return session;
}
