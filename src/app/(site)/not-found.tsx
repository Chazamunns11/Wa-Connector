import Link from "next/link";
import { siteButton } from "@/components/site/button";
import { Container } from "@/components/site/Container";
import { SITE_ROUTES } from "@/lib/site/routes";

export default function NotFound() {
  return (
    <Container className="band-tight">
      <h1 className="h-page font-display">Page not found</h1>
      <p className="mt-4 max-w-[62ch] text-lg text-ink-dim">
        That page doesn&rsquo;t exist, or it has moved.
      </p>
      <Link href={SITE_ROUTES.home} className={siteButton("coral", "mt-8")}>
        Back to the home page
      </Link>
    </Container>
  );
}
