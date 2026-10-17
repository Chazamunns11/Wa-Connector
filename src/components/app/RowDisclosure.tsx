"use client";

import { useState, type ReactNode } from "react";

/**
 * One sub-account row with its details toggle in the row itself, not on a line of its own.
 * Without JavaScript the toggle is a plain link that reopens the dashboard with the row open
 * (`?open=<id>`); with it, the link just opens and closes the details in place.
 */
export function RowDisclosure({
  id,
  name,
  initiallyOpen,
  openHref,
  closeHref,
  gridClass,
  cells,
  children,
}: {
  id: string;
  name: string;
  initiallyOpen: boolean;
  openHref: string;
  closeHref: string;
  gridClass: string;
  cells: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const panelId = `details-${id}`;
  return (
    <>
      <div className={gridClass}>
        {cells}
        <div className="md:flex md:justify-end">
          <a
            href={open ? closeHref : openHref}
            role="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={(e) => {
              e.preventDefault();
              setOpen((o) => !o);
            }}
            className="row-toggle"
          >
            {open ? "Hide" : "Details"}
            <span className="sr-only"> for {name}</span>
            <svg aria-hidden="true" viewBox="0 0 12 8" className={`h-2 w-3 transition-transform ${open ? "rotate-180" : ""}`}>
              <path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
      </div>
      <div id={panelId} hidden={!open} className="row-detail">
        {children}
      </div>
    </>
  );
}
