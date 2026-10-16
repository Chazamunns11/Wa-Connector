import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Docs | ${name}`,
    description: `Setup, answers to common questions, billing and data handling for ${name}.`,
  };
}

const DOCS = [
  { href: SITE_ROUTES.setup, title: "Setup guide", text: "Install, set the Telephony Provider, scan the QR code and send a test. About ten minutes." },
  { href: SITE_ROUTES.faq, title: "FAQ", text: "Straight answers on linked devices, ban risk, the daily cap and what happens when a phone goes offline." },
  { href: SITE_ROUTES.billingHelp, title: "Billing", text: "How the free trial works, what a failed payment does and how to cancel." },
  { href: SITE_ROUTES.privacySummary, title: "Privacy and data", text: "What we store, for how long, and what we do not keep." },
] as const;

export default function DocsIndexPage() {
  const { name } = brandConfig();
  return (
    <section className="pb-12 pt-12 md:pb-20">
      <Container>
        <div className="max-w-[760px]">
          <h1 className="font-display text-[clamp(32px,6vw,48px)] font-extrabold leading-[1.15]">{name} docs</h1>
          <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">
            Start with the setup guide. The rest is here when you need it.
          </p>
          <ul role="list" className="mt-8 grid list-none gap-4 p-0 sm:grid-cols-2">
            {DOCS.map((d) => (
              <li key={d.href}>
                <Link
                  href={d.href}
                  className="block h-full min-h-11 rounded-lg border bg-raised p-6 transition-colors hover:border-accent-text"
                >
                  <span className="font-display text-lg font-medium text-accent-text underline underline-offset-2">
                    {d.title}
                  </span>
                  <span className="mt-2 block text-ink-dim">{d.text}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-ink-dim">
            Legal:{" "}
            <Link href={SITE_ROUTES.terms} className="underline underline-offset-2">
              Terms
            </Link>{" "}
            and{" "}
            <Link href={SITE_ROUTES.privacy} className="underline underline-offset-2">
              Privacy policy
            </Link>{" "}
            (drafts).
          </p>
        </div>
      </Container>
    </section>
  );
}
