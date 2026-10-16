/**
 * The product wordmark. Copied from PortalHub `src/components/shell/Wordmark.tsx`
 * (same `size` prop and size tiers, so every call site is unchanged), with the
 * FitClosers mark and SVG lettering dropped: the product name is whatever
 * `brandConfig().name` says, rendered as text in the display face.
 *
 * Server-only in practice: `BRAND_NAME` is not a `NEXT_PUBLIC_` variable, so
 * this must be rendered from a server component (the login page, the connect
 * page) to show the configured name.
 */
import { brandConfig } from "@/lib/brand-config";

type Size = "sm" | "md" | "lg";

/** Rendered height in px per tier — same tiers as PortalHub's SVG lockup. */
const SIZE_HEIGHT_PX: Record<Size, number> = {
  sm: 20,
  md: 28,
  lg: 44,
};

export function Wordmark({ size = "md" }: { size?: Size }) {
  const height = SIZE_HEIGHT_PX[size];
  const { name } = brandConfig();

  return (
    <span
      className="block shrink-0 font-display font-bold uppercase italic leading-none text-ink"
      style={{ fontSize: Math.round(height * 0.8), lineHeight: `${height}px` }}
    >
      {name}
    </span>
  );
}
