import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";

// Placeholder: replaced by the sales page in Task 4.
export default function HomePage() {
  return (
    <Container className="py-12">
      <h1 className="text-[clamp(32px,6vw,48px)] font-bold">{brandConfig().name}</h1>
    </Container>
  );
}
