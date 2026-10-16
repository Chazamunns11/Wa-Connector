import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
}

/** Base dark panel: 8px radius, hairline border, no shadow, no glow. */
export function Card({
  children,
  padded = true,
  className = "",
  ...rest
}: CardProps) {
  return (
    <div
      className={`rounded-lg border bg-card ${
        padded ? "p-6" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h3 className="font-display text-lg font-bold uppercase italic tracking-[.01em] text-ink">
          {title}
        </h3>
        {subtitle ? (
          <p className="mt-1.5 text-sm text-ink-faint">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
