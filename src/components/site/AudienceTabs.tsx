"use client";

import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { AUDIENCES, AUDIENCE_LABELS, type Audience } from "@/lib/site/setup-steps";

/**
 * Two audience panels behind a tab list. Both panels are in the server HTML
 * (the inactive one `hidden`), so the content is there without JavaScript.
 * The tabs are links to `?audience=...`: with JavaScript off, clicking one
 * reloads the page with that audience selected; with it on, the click only
 * switches the panel and updates the address bar.
 */
export function AudienceTabs({
  panels,
  initial = "agency",
}: {
  panels: Record<Audience, ReactNode>;
  initial?: Audience;
}) {
  const [active, setActive] = useState<Audience>(initial);
  // Roving tabindex only once JS is running; without it every tab stays reachable.
  const enhanced = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const tabRefs = useRef<Record<Audience, HTMLAnchorElement | null>>({ agency: null, business: null });

  function select(next: Audience, focus: boolean) {
    setActive(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("audience", next);
      window.history.replaceState(null, "", url);
    } catch {
      /* the address bar is a nicety */
    }
    if (focus) tabRefs.current[next]?.focus();
  }

  function onClick(e: MouseEvent<HTMLAnchorElement>, a: Audience) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    select(a, false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, a: Audience) {
    const i = AUDIENCES.indexOf(a);
    let next: Audience | null = null;
    if (e.key === "ArrowRight") next = AUDIENCES[(i + 1) % AUDIENCES.length];
    else if (e.key === "ArrowLeft") next = AUDIENCES[(i - 1 + AUDIENCES.length) % AUDIENCES.length];
    else if (e.key === "Home") next = AUDIENCES[0];
    else if (e.key === "End") next = AUDIENCES[AUDIENCES.length - 1];
    else if (e.key === " ") {
      e.preventDefault();
      select(a, false);
      return;
    }
    if (next) {
      e.preventDefault();
      select(next, true);
    }
  }

  return (
    <div>
      <div role="tablist" aria-label="Who is setting this up" className="flex flex-wrap gap-2">
        {AUDIENCES.map((a) => {
          const selected = a === active;
          return (
            <a
              key={a}
              ref={(el) => {
                tabRefs.current[a] = el;
              }}
              role="tab"
              id={`tab-${a}`}
              href={`?audience=${a}#steps`}
              aria-selected={selected}
              aria-controls={`panel-${a}`}
              tabIndex={enhanced && !selected ? -1 : 0}
              onClick={(e) => onClick(e, a)}
              onKeyDown={(e) => onKeyDown(e, a)}
              className={`inline-flex min-h-11 items-center rounded border px-5 font-semibold ${
                selected
                  ? "border-ink bg-ink text-bg"
                  : "border-ink-faint text-ink-dim hover:border-ink hover:text-ink"
              }`}
            >
              {AUDIENCE_LABELS[a]}
            </a>
          );
        })}
      </div>
      <div id="steps" className="scroll-mt-4">
        {AUDIENCES.map((a) => (
          <div
            key={a}
            role="tabpanel"
            id={`panel-${a}`}
            aria-labelledby={`tab-${a}`}
            hidden={a !== active}
            tabIndex={0}
            className="mt-8"
          >
            {panels[a]}
          </div>
        ))}
      </div>
    </div>
  );
}
