import Link from "next/link";
import type { ReactNode } from "react";
import { brandConfig } from "@/lib/brand-config";
import { BrandMark } from "@/components/site/BrandMark";

/**
 * Centred card for sign-up and sign-in.
 */
export function AuthShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
      <div className="slab p-5 sm:p-8">
        <header className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href="/"
            aria-label={`${brandConfig().name} home`}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <BrandMark size={40} />
          </Link>
        </header>
        <h1 className="mt-6 h-app font-display">{title}</h1>
        {intro ? <div className="mt-3 text-ink-dim">{intro}</div> : null}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
