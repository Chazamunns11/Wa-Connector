interface Note {
  title: string;
  body: string;
}

/** The three safety behaviours as ruled rows on the coral band: a bold title, then the plain sentence. */
export function SafetyThread({ items }: { items: Note[] }) {
  const [paced, held, stop] = items;
  return (
    <ul className="rules">
      {[paced, held, stop].map((note) => (
        <li key={note.title}>
          <b>{note.title}</b>
          <span className="block max-w-[52ch] pt-1">{note.body}</span>
        </li>
      ))}
    </ul>
  );
}
