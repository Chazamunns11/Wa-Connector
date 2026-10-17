import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { siteButton } from "@/components/site/button";
import { brandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS } from "@/lib/pricing";
import { sendCompleteLinkAction } from "../actions";

export function generateMetadata(): Metadata {
  return { title: `You're nearly there — ${brandConfig().name}`, robots: { index: false } };
}

export default async function SignupCompletePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sessionId = typeof params.session_id === "string" ? params.session_id.slice(0, 250) : "";
  return (
    <AuthShell
      title="You're nearly there"
      intro={
        sessionId ? (
          <p>Your {TRIAL_DAYS}-day free trial has started. No card needed until it ends.</p>
        ) : (
          <p>One more step: sign in.</p>
        )
      }
    >
      {sessionId ? (
        <form action={sendCompleteLinkAction} className="flex flex-col gap-4">
          <input type="hidden" name="session_id" value={sessionId} />
          <p className="text-ink-dim">You confirmed your email at the start, so you should already be signed in. If not, we&apos;ll email you a sign-in link: open it in this browser.</p>
          <button type="submit" className={siteButton("coral", "w-full")}>
            Go to my dashboard
          </button>
        </form>
      ) : (
        <p className="text-ink-dim">
          If you&apos;ve just finished checkout, request a sign-in link from the{" "}
          <Link href="/login" className="font-semibold text-ink underline underline-offset-2">
            login page
          </Link>
          .
        </p>
      )}
    </AuthShell>
  );
}
