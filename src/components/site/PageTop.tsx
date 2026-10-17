import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";

/**
 * Ink top band for docs and other inner pages: it continues the header, so the
 * two read as one block. White h1, lead in the Ink scope's dim white.
 */
export function PageTop({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <section className="surface-dark pb-[clamp(48px,6vw,80px)] pt-10 md:pt-14">
      <Container>
        <h1 className="h-page max-w-[20ch] font-display">{title}</h1>
        {children ? <div className="mt-5 max-w-[52ch] text-[1.3rem] font-medium leading-[1.4] text-ink-dim">{children}</div> : null}
      </Container>
    </section>
  );
}
