import type { ReactNode } from "react";

/** Legal pages read dark-on-light, like the docs: header and footer stay dark, the body flips to the light token set. */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return <div className="surface-light min-h-full bg-bg text-ink">{children}</div>;
}
