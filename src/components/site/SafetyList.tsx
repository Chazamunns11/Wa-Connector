import { Card } from "@/components/ui/Card";

export function SafetyList({ items }: { items: { title: string; body: string }[] }) {
  return (
    <ul className="mt-8 grid list-none gap-4 p-0 md:grid-cols-3">
      {items.map((s) => (
        <li key={s.title}>
          <Card className="h-full">
            <h3 className="font-display text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-ink-dim">{s.body}</p>
          </Card>
        </li>
      ))}
    </ul>
  );
}
