import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";

/**
 * Sign-up and sign-in on the Ink band, like the top of every other page: the heading and
 * intro in white on the left, the form in a white card with the coral lift on the right.
 * Below 900px they stack. The site header above already carries the logo and the home link.
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
    <section className="fill-band surface-dark pb-[clamp(56px,8vw,112px)] pt-[clamp(32px,5vw,72px)]">
      <Container>
        <div className="grid items-start gap-x-[clamp(32px,6vw,96px)] gap-y-8 min-[901px]:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
          <header className="min-[901px]:pt-4">
            <h1 className="h-page font-display max-w-[14ch]">{title}</h1>
            {intro ? (
              <div className="mt-5 max-w-[46ch] text-[clamp(1.05rem,1.5vw,1.25rem)] font-medium leading-[1.5] text-ink-dim">
                {intro}
              </div>
            ) : null}
          </header>
          <div className="light-card slab slab-lift p-5 sm:p-8">{children}</div>
        </div>
      </Container>
    </section>
  );
}
