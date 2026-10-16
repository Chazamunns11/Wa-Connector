import type { ReactNode } from "react";

/** Docs read better dark-on-light: the header and footer stay dark, the page body flips to the light token set. */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return <div className="surface-light min-h-full bg-bg text-ink">{children}</div>;
}
