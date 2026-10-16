export function HowItWorks({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol className="mt-8 grid list-none gap-6 p-0 md:grid-cols-3">
      {steps.map((s, i) => (
        <li key={s.title} className="border-t-2 border-accent pt-4">
          <span aria-hidden="true" className="mb-2 block font-display text-2xl font-extrabold text-accent-text">
            {i + 1}
          </span>
          <h3 className="font-display text-lg font-medium">{s.title}</h3>
          <p className="mt-2 text-ink-dim">{s.body}</p>
        </li>
      ))}
    </ol>
  );
}
