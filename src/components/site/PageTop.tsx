import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";

/**
 * Coral top band for docs and other inner pages: it continues the header's field.
 * Every token in `.surface-coral` is Ink, so the lead needs no colour class.
 */
export function PageTop({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <section className="surface-coral pb-12 pt-10 md:pb-16 md:pt-14">
      <Container>
        <h1 className="h-display max-w-[20ch] font-display font-extrabold">{title}</h1>
        {children ? <div className="mt-5 max-w-[52ch] text-[1.3rem] font-medium leading-[1.4]">{children}</div> : null}
      </Container>
    </section>
  );
}
