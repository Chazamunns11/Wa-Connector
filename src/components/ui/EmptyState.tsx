import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

/** Shown wherever a data-layer read returns zero rows (demo shell, empty filters, etc). */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: EmptyStateProps) {
  // Empty states are type and rules — hairlines above and below, no box, no
  // illustration; a slanted teal tick carries the brand instead of an icon
  // bubble.
  return (
    <div className="flex flex-col items-center justify-center gap-3 border-y border-divider px-6 py-16 text-center">
      {icon ? (
        <div className="text-ink-faint">{icon}</div>
      ) : (
        <span aria-hidden className="h-3.5 w-[3px] -skew-x-[11deg] bg-accent" />
      )}
      <h3 className="font-display text-base font-extrabold text-ink">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm text-ink-faint">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
