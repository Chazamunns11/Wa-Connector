import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { brandConfig } from "@/lib/brand-config";

export function generateMetadata(): Metadata {
  return { title: `Check your email — ${brandConfig().name}`, robots: { index: false } };
}

export default function SignupCheckEmailPage() {
  return (
    <AuthShell
      title="Check your email to continue"
      intro={<p>We&apos;ve sent a confirmation link to the address you gave us.</p>}
    >
      <div role="status" className="flex flex-col gap-3 text-ink-dim">
        <p>
          Open the link in this same browser. It confirms the address is yours, creates your account and takes you
          straight to checkout. Nothing is set up until you do.
        </p>
        <p>
          Nothing arrived after a few minutes? Check spam, or{" "}
          <Link href="/signup" className="font-semibold text-ink underline underline-offset-2">
            start again
          </Link>
          . Already confirmed? <Link href="/login" className="font-semibold text-ink underline underline-offset-2">Log in</Link>.
        </p>
      </div>
    </AuthShell>
  );
}
