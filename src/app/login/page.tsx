import { Wordmark } from "@/components/shell/Wordmark";
import { Button } from "@/components/ui/Button";
import { brandConfig } from "@/lib/brand-config";
import { sendLoginLinkAction } from "./actions";

/**
 * Owner sign-in — the cut-down shape of PortalHub `src/app/login/page.tsx`:
 * the wordmark, a heading, the `?error=` explainer card, and the magic-link
 * form (PortalHub's `MagicLinkTab`, posted to a server action here instead
 * of the browser client — see `sendLoginLinkAction`). Demo-role cards, the
 * password tab, closer-invite refusals and the self-serve signup promo are
 * Hub-only and not copied.
 */

const AUTH_ERROR_COPY: Record<string, { title: string; body: string }> = {
  auth_callback: {
    title: "That sign-in link didn't work",
    body: "It may have already been used, or it expired — links are single-use and last an hour. Request a fresh one below, and open it in this same browser.",
  },
  invalid_email: {
    title: "That email address doesn't look right",
    body: "Check it and try again.",
  },
};

interface LoginPageProps {
  /** `error` is set by /auth/callback or the sign-in action; `sent` by the sign-in action once a link has been requested. */
  searchParams: Promise<{ error?: string; sent?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, sent } = await searchParams;
  const authError = error ? AUTH_ERROR_COPY[error] : undefined;
  const { name } = brandConfig();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-bg px-4 py-16">
      <Wordmark size="lg" />

      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-display text-2xl font-bold uppercase italic text-ink">Sign in</h1>
        <p className="max-w-md text-sm text-ink-faint">Sign in with your {name} owner account.</p>
      </div>

      {authError ? (
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-center">
          <p className="text-sm font-semibold text-ink">{authError.title}</p>
          <p className="mt-1 text-sm text-ink-faint">{authError.body}</p>
        </div>
      ) : null}

      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        {sent ? (
          <p className="text-sm text-ink-dim">
            If that address has an owner account, a sign-in link is on its way. Open it in this browser.
          </p>
        ) : (
          <form action={sendLoginLinkAction} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm text-ink-dim">
              Email
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="h-[38px] rounded border border-border bg-well px-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
              />
            </label>
            <Button type="submit" className="mt-2">
              Send me a sign-in link
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
