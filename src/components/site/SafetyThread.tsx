import type { ReactNode } from "react";

interface Note {
  title: string;
  body: string;
}

/** One sample thread, annotated: each safety behaviour sits beside the message it explains. */
export function SafetyThread({ items }: { items: Note[] }) {
  const [paced, held, stop] = items;
  return (
    <ol className="mt-10 grid list-none gap-y-10 p-0 md:gap-y-8">
      <Row note={paced}>
        <Out status="Delivered">Hi Sam, your call is booked for 2pm tomorrow.</Out>
      </Row>
      <Row note={held}>
        <Out status="Waiting for the phone to reconnect">Your booking link is ready.</Out>
      </Row>
      <Row note={stop}>
        <div className="flex flex-col items-start">
          <p className="bubble bubble-in font-medium">STOP</p>
        </div>
        <Out status="Not sent. Sam opted out." className="mt-3">
          We have a new offer for you.
        </Out>
      </Row>
    </ol>
  );
}

function Out({ children, status, className = "" }: { children: ReactNode; status: string; className?: string }) {
  return (
    <div className={`flex flex-col items-end ${className}`}>
      <p className="bubble bubble-out">{children}</p>
      <p className="mt-1.5 text-[0.8rem] text-ink-dim">{status}</p>
    </div>
  );
}

function Row({ note, children }: { note: Note; children: ReactNode }) {
  return (
    <li className="grid gap-3 md:grid-cols-[minmax(0,22rem)_3rem_minmax(0,1fr)] md:gap-0">
      <div className="min-w-0">{children}</div>
      {/* Thin connector from the bubble to its note (desktop only). */}
      <span aria-hidden="true" className="mt-[22px] hidden h-px bg-border-strong md:block" />
      <div className="border-l-2 border-border-strong pl-4 md:mt-0 md:max-w-[34ch]">
        <h3 className="font-display text-xl font-medium leading-snug">{note.title}</h3>
        <p className="mt-1 text-ink-dim">{note.body}</p>
      </div>
    </li>
  );
}
