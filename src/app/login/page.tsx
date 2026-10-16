import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { EmailLinkForm } from "@/components/auth/EmailLinkForm";
import { brandCssVars, brandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS } from "@/lib/pricing";
import { sendLoginLinkAction } from "./actions";

/**
 * Sign-in: the website auth shell around the foundation's magic-link flow.
 * The form posts to `sendLoginLinkAction`; `/auth/callback` and `actions.ts`
 * are the foundation's and are not touched here.
 */

const AUTH_ERROR_COPY: Record<string, { title: string; body: string }> = {
  auth_callback: {
    title: "That sign-in link didn't work",
    body: "It may have already been used, or it expired — links are single-use and last an hour. Request a fresh one below, and open it in this same browser.",
  },
  no_account: {
    title: "No account for that sign-in",
    body: "This sign-in doesn't belong to an account yet. Contact support.",
  },
  checkout: {
    title: "Billing isn't set up yet",
    body: "Your account exists but no card was added. Sign in to finish setting up billing.",
  },
  exists: {
    title: "That email already has an account",
    body: "We've sent nothing — request a sign-in link below.",
  },
  invalid_email: {
    title: "That email address doesn't look right",
    body: "Check it and try again.",
  },
};

export function generateMetadata(): Metadata {
  return { title: `Sign in — ${brandConfig().name}`, robots: { index: false } };
}

interface LoginPageProps {
  /** `error` is set by /auth/callback or the sign-in action; `sent` by the sign-in action once a link has been requested. */
  searchParams: Promise<{ error?: string; sent?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, sent } = await searchParams;
  const authError = error ? AUTH_ERROR_COPY[error] : undefined;
  const brand = brandConfig();
  const { name } = brand;

  return (
    <main id="main" style={brandCssVars(brand)} className="min-h-screen bg-bg">
      <AuthShell
        title="Sign in"
        intro={sent ? undefined : <p>We&apos;ll email you a sign-in link. No password needed.</p>}
      >
        {authError ? (
          <div
            role="alert"
            className="mb-5 rounded-[12px] border-2 border-border-strong bg-well p-4"
          >
            <p className="text-sm font-semibold text-ink">{authError.title}</p>
            <p className="mt-1 text-sm text-ink-dim">{authError.body}</p>
          </div>
        ) : null}

        {sent ? (
          <p role="status" className="text-ink-dim">
            If that address has a {name} account, a sign-in link is on its way.
            Open it in this browser.
          </p>
        ) : (
          <EmailLinkForm
            action={sendLoginLinkAction}
            buttonLabel="Send me a sign-in link"
          />
        )}

        <p className="mt-6 text-sm text-ink-dim">
          New here?{" "}
          <Link
            href="/signup"
            className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-2"
          >
            Start your {TRIAL_DAYS}-day free trial
          </Link>
        </p>
      </AuthShell>
    </main>
  );
}
