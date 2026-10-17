import type { ReactNode } from "react";

/** Page width: 72rem max, 16px gutters (32px from 768px). */
export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-6xl px-4 md:px-8 ${className}`}>
      {children}
    </div>
  );
}
