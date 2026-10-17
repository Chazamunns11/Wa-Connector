import { brandConfig } from "@/lib/brand-config";

/**
 * Three illustrative rows in the shape of the real dashboard, with the
 * chips and notes the app prints. A static mock: it does not import the app's
 * LocationTable, which is interactive. Rows are a grid from 768px and small
 * stacked blocks below, from the same markup.
 */
interface Row {
  name: string;
  status: { on: boolean; label: string };
  number?: string;
  sent: string;
  pct: number;
  note?: { text: string; tone: "warn" | "none" };
  action?: string;
}

const ROWS: Row[] = [
  {
    name: "Harbour Street Physio",
    status: { on: true, label: "Connected" },
    number: "+44 7700 900101",
    sent: "42 / 150",
    pct: 28,
  },
  {
    name: "Millbrook Vets",
    status: { on: false, label: "Disconnected · 4 waiting" },
    sent: "18 / 150",
    pct: 12,
    note: { text: "Disconnected — 4 messages waiting", tone: "warn" },
    action: "Reconnect",
  },
  {
    name: "Fernbank Dental",
    status: { on: true, label: "Connected" },
    number: "+44 7700 900102",
    sent: "0 / 150",
    pct: 0,
    note: { text: "No messages from GoHighLevel yet. Is the Telephony Provider set?", tone: "warn" },
  },
];

const GRID = "sm:grid sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-start sm:gap-4";
const L = "text-sm font-semibold text-ink-dim sm:hidden";

export function DashboardSample() {
  const { name } = brandConfig();
  const label = `The ${name} dashboard with three sample sub-accounts: Harbour Street Physio, connected, 42 of 150 sent today; Millbrook Vets, disconnected with 4 messages waiting and a Reconnect button; Fernbank Dental, connected, 0 of 150, with the note "No messages from GoHighLevel yet. Is the Telephony Provider set?"`;

  return (
    <div role="img" aria-label={label} className="w-full">
      <div aria-hidden="true" className="board">
        <div className="board-top">
          <span>Sub-accounts</span>
          <span className="pill-sample">Sample</span>
        </div>
        <div className={`hidden border-b border-border px-5 py-3.5 small font-semibold text-ink-dim ${GRID}`}>
          <span>Sub-account</span>
          <span>WhatsApp status</span>
          <span>Sent today</span>
          <span>Needs attention</span>
        </div>
        <ul className="m-0 list-none p-0">
          {ROWS.map((r) => (
            <li key={r.name} className={`grid gap-1.5 border-b border-border px-5 py-4 last:border-b-0 ${GRID}`}>
              <div>
                <span className={L}>Sub-account</span>
                <p className="font-medium">{r.name}</p>
              </div>
              <div>
                <span className={L}>WhatsApp status</span>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                  <i className={`dot${r.status.on ? "" : " dot-off"}`} />
                  {r.status.label}
                </p>
                {r.number ? <p className="font-mono-nums mt-0.5 text-sm text-ink-dim">{r.number}</p> : null}
              </div>
              <div>
                <span className={L}>Sent today</span>
                <p className="flex items-center gap-2.5 font-medium tabular-nums">
                  <span className="whitespace-nowrap">{r.sent}</span>
                  <span className="meter flex-1">
                    <i style={{ width: `${r.pct}%` }} />
                  </span>
                </p>
              </div>
              <div className="flex flex-col items-start gap-2">
                <span className={L}>Needs attention</span>
                {r.note ? <p className="text-sm font-semibold">{r.note.text}</p> : <p className="text-sm font-medium">Nothing to do</p>}
                {r.action ? <span className="attn">{r.action}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
