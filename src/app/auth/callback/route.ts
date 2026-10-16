/**
 * GET /auth/callback — the emailed link lands here with `?code=`.
 * The shape of PortalHub `src/app/auth/callback/route.ts`: exchange the code
 * for a session (PKCE — the verifier cookie was set by `sendLoginLinkAction`
 * or `startSignupAction`), then redirect.
 *
 * `decideCallback` (src/lib/billing/onboard.ts) picks the route: an owner goes
 * to `/admin`, an account with an `account_id` to `/dashboard`. A verified
 * user with NO profile but a pending signup in their metadata is a new
 * customer: the account and profile are created here, for the verified email
 * only, and they go on to Stripe Checkout. Anything else is signed out and
 * sent to `/signup`. A missing code or failed exchange goes to
 * `/login?error=auth_callback`. Every redirect target is a fixed path on this
 * origin or the Checkout URL Stripe returned: no `next=` parameter, so no
 * open redirect.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getProfile } from "@/lib/auth";
import { brandConfig } from "@/lib/brand-config";
import { completeSignup, decideCallback, parsePendingSignup } from "@/lib/billing/onboard";
import { repo } from "@/lib/data";
import { verifyClaimToken } from "@/lib/ghl-claim";
import { isStripeConfigured } from "@/lib/stripe/client";
import { createCheckoutSession } from "@/lib/stripe/billing";

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
      const pending = user ? parsePendingSignup(user.user_metadata) : null;
      const decision = decideCallback(profile, pending);

      if (decision === "owner") return NextResponse.redirect(`${origin}/admin`);
      if (decision === "dashboard") return NextResponse.redirect(`${origin}/dashboard`);

      if (decision === "complete_signup" && user?.email && pending) {
        if (!isStripeConfigured()) {
          await supabase.auth.signOut();
          return NextResponse.redirect(`${origin}/signup?error=unavailable`);
        }
        const outcome = await completeSignup(
          repo,
          { checkout: createCheckoutSession, appUrl: brandConfig().appUrl, verifyClaim: verifyClaimToken },
          { userId: user.id, email: user.email, pending },
        );
        if (outcome.kind === "checkout") return NextResponse.redirect(outcome.url);
        // The account exists but Checkout failed: the dashboard offers "Add a card".
        return NextResponse.redirect(`${origin}/dashboard`);
      }

      // Signed in but belongs to nothing: drop the session rather than leave a dangling login.
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/signup`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
