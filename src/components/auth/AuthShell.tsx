import type { ReactNode } from "react";
import { BrandMark } from "@/components/site/BrandMark";
import { PreviewBadge } from "@/components/site/PreviewBadge";

/**
 * Centred card for sign-up and sign-in. The preview badge is opt-in: /signup
 * sets `preview`, the real /login does not. Below 640px the badge sits on its
 * own line under the brand mark.
 */
export function AuthShell({
  title,
  intro,
  children,
  preview = false,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  preview?: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
      <div className="rounded-lg border bg-card p-5 sm:p-8">
        <header className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <BrandMark size={36} />
          {preview ? <PreviewBadge /> : null}
        </header>
        <h1 className="mt-6 font-display text-[28px] font-extrabold leading-[1.15]">{title}</h1>
        {intro ? <div className="mt-3 text-ink-dim">{intro}</div> : null}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
