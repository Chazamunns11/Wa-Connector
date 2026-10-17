import { Chip, type ChipTone } from "@/components/ui/Chip";
import { capLevel, needsAttention, primaryActionFor, type CapLevel } from "@/lib/account-data/derive";
import type { LocationRow, WhatsappState } from "@/lib/account-data";
import { dashboardHref, type DashboardFilter } from "@/lib/site/dashboard-url";
import { LocationRowDetail } from "./LocationRowDetail";
import { RowDisclosure } from "./RowDisclosure";
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

/** Five columns from 768px (the last is the details toggle); stacked cards below. One markup, CSS only. */
const COLS = "md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto]";
const GRID = `md:grid ${COLS} md:items-center md:gap-4`;

/** The cap bar warns from 90% and turns red at the cap; the words say it too, never colour alone. */
const CAP_BAR: Record<CapLevel, string> = { ok: "bg-accent", near: "bg-cap-near", full: "bg-loss" };

function Cell({ label, children, className = "", hideLabel = false }: { label: string; children: React.ReactNode; className?: string; hideLabel?: boolean }) {
  return (
    <div className={className}>
      <span className={`mb-0.5 text-xs text-ink-faint ${hideLabel ? "sr-only" : "block md:sr-only"}`}>{label}</span>
      {children}
    </div>
  );
}

export interface RowExtras {
  /** A freshly minted connect link for one row, shown in that row's detail. */
  connectLink?: { locationId: string; url: string };
  /** The QR panel to open under one row. */
  qr?: { locationId: string; panel: React.ReactNode };
}

export function LocationTable({
  rows,
  filter,
  connectLink,
  qr,
  open,
}: { rows: LocationRow[]; filter: DashboardFilter; open?: string } & RowExtras) {
  return (
    <div className="overflow-hidden rounded-[20px] border-2 border-outline bg-card">
      <div aria-hidden className={`hidden border-b-2 border-outline bg-raised px-6 py-3 text-sm font-semibold text-ink md:grid ${COLS} md:gap-4`}>
        <span>Sub-account</span>
        <span>WhatsApp</span>
        <span>Sent today</span>
        <span>Needs attention</span>
        <span className="w-[5.5rem]" />
      </div>
      <ul aria-label="Sub-accounts and WhatsApp status" className="divide-y-2 divide-rule/15">
        {rows.map((row) => {
          const chip = stateChip(row.state);
          const attention = needsAttention(row);
          const primary = primaryActionFor(row);
          const pct = row.dailyCap > 0 ? Math.min(100, Math.round((row.sentToday / row.dailyCap) * 100)) : 0;
          const cap = capLevel(row);
          const rowOpen = open === row.id || qr?.locationId === row.id || connectLink?.locationId === row.id;
          return (
            <li key={row.id} id={`row-${row.id}`} className="scroll-mt-6">
              <RowDisclosure
                id={row.id}
                name={row.name}
                initiallyOpen={rowOpen}
                openHref={dashboardHref({ filter, open: row.id })}
                closeHref={dashboardHref({ filter })}
                gridClass={`grid gap-3 px-4 py-4 md:px-6 ${GRID}`}
                cells={
                  <>
                    <Cell label="Sub-account" hideLabel>
                      <p className="font-display text-[1.05rem] font-bold text-ink">{row.name}</p>
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
                        <div>
                          <div className="flex items-center gap-2">
                            <div aria-hidden className="h-2 min-w-12 flex-1 overflow-hidden rounded-full bg-raised">
                              <div className={`h-full rounded-full ${CAP_BAR[cap]}`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className={`text-sm tabular-nums ${cap === "ok" ? "text-ink-dim" : "font-semibold text-ink"}`}>
                              {row.sentToday} / {row.dailyCap}
                            </span>
                          </div>
                          {cap === "near" ? <p className="mt-1 text-xs font-semibold text-warn">Close to today&rsquo;s cap</p> : null}
                        </div>
                      ) : (
                        <span className="text-sm text-ink-faint">
                          <span aria-hidden>—</span>
                          <span className="sr-only">Not sending</span>
                        </span>
                      )}
                    </Cell>
                    <Cell
                      label="Needs attention"
                      hideLabel={!attention && !!primary}
                      className={`md:flex md:flex-col md:items-start ${attention || primary ? "" : "hidden"}`}
                    >
                      {attention ? (
                        <p className="text-sm font-semibold text-warn">{attention}</p>
                      ) : !primary ? (
                        <p className="text-sm text-ink-faint">Nothing to do</p>
                      ) : null}
                      {primary ? (
                        <div className="mt-2">
                          <PrimaryAction row={row} action={primary} filter={filter} />
                        </div>
                      ) : null}
                    </Cell>
                  </>
                }
              >
                <LocationRowDetail
                  row={row}
                  actions={<RowActions row={row} filter={filter} />}
                  connectLink={connectLink?.locationId === row.id ? connectLink.url : undefined}
                  qrOpen={qr?.locationId === row.id}
                  qrPanel={qr?.locationId === row.id ? qr.panel : undefined}
                />
              </RowDisclosure>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
