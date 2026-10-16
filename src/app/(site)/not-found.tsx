import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { Container } from "@/components/site/Container";
import { SITE_ROUTES } from "@/lib/site/routes";

export default function NotFound() {
  return (
    <Container className="py-16">
      <h1 className="text-[clamp(32px,6vw,48px)] font-bold">Page not found</h1>
      <p className="mt-4 max-w-[62ch] text-lg text-ink-dim">
        That page doesn&rsquo;t exist, or it has moved.
      </p>
      <Link href={SITE_ROUTES.home} className={buttonClasses("primary", "md", "mt-8 min-h-11")}>
        Back to the home page
      </Link>
    </Container>
  );
}
