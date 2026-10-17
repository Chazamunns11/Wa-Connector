import Link from "next/link";
import { siteButton } from "@/components/site/button";
import { Container } from "@/components/site/Container";
import { SITE_ROUTES } from "@/lib/site/routes";

export default function NotFound() {
  return (
    <section className="fill-band surface-dark band-tight">
      <Container>
        <h1 className="h-page font-display">Page not found</h1>
        <p className="mt-5 max-w-[52ch] text-[1.3rem] font-medium leading-[1.4] text-ink-dim">
          That page doesn&rsquo;t exist, or it has moved.
        </p>
        <Link href={SITE_ROUTES.home} className={siteButton("coral", "mt-8")}>
          Back to the home page
        </Link>
      </Container>
    </section>
  );
}
