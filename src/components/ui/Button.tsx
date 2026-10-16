import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink hover:brightness-105 active:brightness-95",
  secondary:
    "border border-border-strong bg-transparent text-ink hover:bg-raised",
  ghost: "bg-transparent text-ink-dim hover:text-ink hover:bg-raised",
  danger: "bg-loss-soft text-loss border border-loss/30 hover:bg-loss/20",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-[34px] px-3.5 text-[13px]",
  md: "h-[38px] px-4 text-sm",
};

/**
 * The button's own class string, exported (W9, Charlie 30 Jul 2026) for the
 * handful of places that must render an ANCHOR rather than a `<button>` — a
 * link that leaves our origin, like the Google OAuth start URL, cannot be a
 * `<button>` without a pointless client-side hop.
 *
 * Deliberately a class helper rather than an `as="a"` polymorphic prop on
 * `Button` itself: this primitive is used in ~80 places, and widening its
 * prop types to be element-generic is a large blast radius for a two-link
 * problem. A shared class builder keeps the styling in exactly one place,
 * which is the part that would otherwise drift.
 */
export function buttonClasses(variant: Variant = "primary", size: Size = "md", className = ""): string {
  return `inline-flex items-center justify-center gap-2 rounded font-semibold transition duration-[120ms] active:scale-[.975] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button className={buttonClasses(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
