import type { ReactNode } from "react";

interface Note {
  title: string;
  body: string;
}

/** One sample thread, annotated: each safety behaviour sits beside the message it explains. */
export function SafetyThread({ items }: { items: Note[] }) {
  const [paced, held, stop] = items;
  return (
    <ul className="mt-10 grid list-none gap-y-10 p-0 md:gap-y-8">
      <Row note={paced}>
        <Out status="Delivered">Hi Sam, your call is booked for 2pm tomorrow.</Out>
      </Row>
      <Row note={held}>
        <Out status="Waiting for the phone to reconnect">Your booking link is ready.</Out>
      </Row>
      <Row
        note={stop}
        lead={
          <div className="flex flex-col items-start">
            <p className="bubble bubble-in font-medium">STOP</p>
          </div>
        }
      >
        <Out status="Not sent. Sam opted out." notSent>
          We have a new offer for you.
        </Out>
      </Row>
    </ul>
  );
}

function Out({ children, status, notSent = false }: { children: ReactNode; status: string; notSent?: boolean }) {
  return (
    <div className="flex flex-col items-end">
      <p className={`bubble bubble-out${notSent ? " bubble-unsent" : ""}`}>{children}</p>
      <p className="mt-1.5 text-[0.8rem] text-ink-dim">{status}</p>
    </div>
  );
}

/** The bubble column is illustration (aria-hidden); the note carries the meaning. */
function Row({ note, lead, children }: { note: Note; lead?: ReactNode; children: ReactNode }) {
  return (
    <li>
      {lead ? (
        <div aria-hidden="true" className="mb-3 md:max-w-[22rem]">
          {lead}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-[minmax(0,22rem)_3rem_minmax(0,1fr)] md:gap-0">
        <div aria-hidden="true" className="min-w-0">
          {children}
        </div>
        {/* Thin connector, drawn level with the bubble the note explains. */}
        <span aria-hidden="true" className="mt-[22px] hidden h-px bg-border-strong md:block" />
        <div className="border-l-2 border-border-strong pl-4 md:max-w-[34ch]">
          <h3 className="font-display text-xl font-medium leading-snug">{note.title}</h3>
          <p className="mt-1 text-ink-dim">{note.body}</p>
        </div>
      </div>
    </li>
  );
}
