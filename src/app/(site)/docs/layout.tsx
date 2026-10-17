import type { ReactNode } from "react";

/** Docs read dark-on-light under the Ink header; the body stays on the default White ground. */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-full bg-bg text-ink">{children}</div>;
}
