import { Chip, type ChipTone } from "@/components/ui/Chip";
import { buttonClasses } from "@/components/ui/Button";
import { brandConfig } from "@/lib/brand-config";

/**
 * Three rows of the real dashboard (src/lib/account-data/preview.ts), with the
 * chips and notes the app prints. A static mock: it does not import the app's
 * LocationTable, which is interactive. Rows are a grid from 768px and small
 * stacked blocks below, from the same markup.
 */
interface Row {
  name: string;
  chip: { tone: ChipTone; label: string };
  number?: string;
  sent: string;
  note?: { text: string; tone: "warn" | "none" };
  action?: string;
}

const ROWS: Row[] = [
  {
    name: "Harbour Street Physio",
    chip: { tone: "win", label: "Connected" },
    number: "+44 7700 900101",
    sent: "42 / 150",
  },
  {
    name: "Millbrook Vets",
    chip: { tone: "loss", label: "Disconnected · 4 waiting" },
    sent: "18 / 150",
    note: { text: "Disconnected — 4 messages waiting", tone: "warn" },
    action: "Reconnect",
  },
  {
    name: "Fernbank Dental",
    chip: { tone: "win", label: "Connected" },
    number: "+44 7700 900102",
    sent: "0 / 150",
    note: { text: "No messages from GoHighLevel yet. Is the Telephony Provider set?", tone: "warn" },
  },
];

const GRID = "md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.6fr)_minmax(0,0.75fr)_minmax(0,1.4fr)] md:items-start md:gap-4";

export function DashboardSample() {
  const { name } = brandConfig();
  const label = `The ${name} dashboard with three sample sub-accounts: Harbour Street Physio, connected, 42 of 150 sent today; Millbrook Vets, disconnected with 4 messages waiting and a Reconnect button; Fernbank Dental, connected, 0 of 150, with the note "No messages from GoHighLevel yet. Is the Telephony Provider set?"`;

  return (
    <div role="img" aria-label={label} className="w-full">
      <div aria-hidden="true" className="sample-chrome overflow-hidden">
        <div className="hidden border-b bg-raised px-5 py-3 text-sm text-ink-faint md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.6fr)_minmax(0,0.75fr)_minmax(0,1.4fr)] md:gap-4">
          <span>Sub-account</span>
          <span>WhatsApp</span>
          <span>Sent today</span>
          <span>Needs attention</span>
        </div>
        <ul className="divide-y divide-divider">
          {ROWS.map((r) => (
            <li key={r.name} className={`grid gap-2 px-4 py-4 md:px-5 ${GRID}`}>
              <p className="font-semibold">{r.name}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Chip tone={r.chip.tone}>{r.chip.label}</Chip>
                {r.number ? <span className="font-mono-nums text-sm text-ink-dim">{r.number}</span> : null}
              </div>
              <p className="text-sm text-ink-dim tabular-nums">
                <span className="text-ink-faint md:hidden">Sent today </span>
                {r.sent}
              </p>
              <div className="flex flex-col items-start gap-2">
                {r.note ? <p className="text-sm font-medium text-warn">{r.note.text}</p> : <p className="text-sm text-ink-faint">Nothing to do</p>}
                {r.action ? <span className={buttonClasses("secondary", "sm")}>{r.action}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
