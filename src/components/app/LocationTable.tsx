import { Chip, type ChipTone } from "@/components/ui/Chip";
import { needsAttention, primaryActionFor } from "@/lib/account-data/derive";
import type { LocationRow, WhatsappState } from "@/lib/account-data";
import { LocationRowDetail } from "./LocationRowDetail";
import { PrimaryAction, RowActions } from "./RowActions";

function stateChip(state: WhatsappState): { tone: ChipTone; label: string } {
  switch (state.kind) {
    case "not_active":
      return { tone: "muted", label: "Not active" };
    case "waiting_qr":
      return { tone: "warn", label: "Waiting for scan" };
    case "connected":
      return { tone: "win", label: "Connected" };
    case "disconnected":
      return { tone: "loss", label: `Disconnected · ${state.waiting} waiting` };
  }
}

/** 12-column-ish grid from 768px; stacked cards below. One markup, CSS only. */
const GRID = "md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.6fr)] md:items-center md:gap-4";

function Cell({ label, children, className = "", hideLabel = false }: { label: string; children: React.ReactNode; className?: string; hideLabel?: boolean }) {
  return (
    <div className={className}>
      <span className={`mb-0.5 text-xs text-ink-faint ${hideLabel ? "sr-only" : "block md:sr-only"}`}>{label}</span>
      {children}
    </div>
  );
}

export function LocationTable({ rows, scenario, filter }: { rows: LocationRow[]; scenario: string; filter: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div
        aria-hidden
        className={`hidden border-b bg-raised px-6 py-3 text-sm text-ink-faint md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.6fr)] md:gap-4`}
      >
        <span>Sub-account</span>
        <span>WhatsApp</span>
        <span>Sent today</span>
        <span>Needs attention</span>
      </div>
      <ul aria-label="Sub-accounts and WhatsApp status" className="divide-y divide-divider">
        {rows.map((row) => {
          const chip = stateChip(row.state);
          const attention = needsAttention(row);
          const primary = primaryActionFor(row);
          const pct = row.dailyCap > 0 ? Math.min(100, Math.round((row.sentToday / row.dailyCap) * 100)) : 0;
          return (
            <li key={row.id}>
              <div className={`grid gap-3 px-4 py-4 md:px-6 ${GRID}`}>
                <Cell label="Sub-account" hideLabel>
                  <p className="font-semibold text-ink">{row.name}</p>
                </Cell>
                <Cell label="WhatsApp">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Chip tone={chip.tone}>{chip.label}</Chip>
                    {row.state.kind === "connected" ? (
                      <span className="text-sm text-ink-dim tabular-nums">{row.state.number}</span>
                    ) : null}
                  </div>
                </Cell>
                <Cell label="Sent today">
                  {row.activated ? (
                    <div className="flex items-center gap-2">
                      <div aria-hidden className="h-1.5 min-w-12 flex-1 rounded-full bg-raised">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-sm text-ink-dim tabular-nums">
                        {row.sentToday} / {row.dailyCap}
                      </span>
                    </div>
                  ) : (
                    <span className="text-sm text-ink-faint">
                      <span aria-hidden>—</span>
                      <span className="sr-only">Not sending</span>
                    </span>
                  )}
                </Cell>
                <Cell label="Needs attention" className={attention ? "" : "hidden md:block"}>
                  {attention ? (
                    <p className="text-sm font-medium text-warn">{attention}</p>
                  ) : (
                    <p className="text-sm text-ink-faint">Nothing to do</p>
                  )}
                </Cell>
                {primary ? (
                  <div className="md:col-span-4 md:flex md:justify-end">
                    <PrimaryAction row={row} action={primary} scenario={scenario} filter={filter} />
                  </div>
                ) : null}
              </div>
              <LocationRowDetail row={row} actions={<RowActions row={row} scenario={scenario} filter={filter} />} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
