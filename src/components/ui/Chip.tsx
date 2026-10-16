import type { ReactNode } from "react";

export type ChipTone = "win" | "loss" | "warn" | "info" | "accent" | "muted";

const TONE_CLASSES: Record<ChipTone, string> = {
  win: "bg-win/10 text-win border-win/30",
  loss: "bg-loss/10 text-loss border-loss/30",
  warn: "bg-warn/10 text-warn border-warn/30",
  info: "bg-info/10 text-info border-info/30",
  accent: "bg-transparent text-accent border-accent/50",
  muted: "bg-raised text-ink-faint border-border",
};

/** Generic pill for enums that aren't `CallStatus` (payment/match/commission status). `title` is a plain tooltip (e.g. a rule label). */
export function Chip({ tone, title, children }: { tone: ChipTone; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
