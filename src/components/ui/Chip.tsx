import type { ReactNode } from "react";

export type ChipTone = "win" | "loss" | "warn" | "info" | "accent" | "muted";

const TONE_CLASSES: Record<ChipTone, string> = {
  win: "bg-win-soft text-win border-win/30",
  loss: "bg-loss-soft text-loss border-loss/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  info: "bg-info-soft text-info border-info/30",
  accent: "bg-accent-soft text-accent-text border-accent-text/40",
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
