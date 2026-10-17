import { Button } from "@/components/ui/Button";
import { rowActionsFor, type PrimaryAction as Primary } from "@/lib/account-data/derive";
import type { LocationRow } from "@/lib/account-data";
import { rowAction } from "@/app/(app)/dashboard/actions";

const ACTIONS = [
  { key: "activate", label: "Activate", can: "activate" },
  { key: "show-qr", label: "Show QR", can: "showQr" },
  { key: "send-link", label: "Send connect link", can: "sendLink" },
  { key: "disconnect", label: "Disconnect", can: "disconnect" },
  { key: "deactivate", label: "Deactivate", can: "deactivate" },
] as const;

/** Each button posts to rowAction. Which buttons show comes only from rowActionsFor; the rest are left out, not greyed. */
export function RowActions({ row, filter }: { row: LocationRow; filter: string }) {
  const allowed = rowActionsFor(row);
  return (
    <ul className="flex flex-wrap gap-2" aria-label={`Actions for ${row.name}`}>
      {ACTIONS.filter((a) => allowed[a.can]).map((a) => (
        <li key={a.key}>
          <form action={rowAction}>
            <input type="hidden" name="filter" value={filter} />
            <input type="hidden" name="location" value={row.id} />
            <input type="hidden" name="intent" value={a.key} />
            <Button
              type="submit"
              size="sm"
              variant={a.key === "deactivate" || a.key === "disconnect" ? "danger" : "secondary"}
              className="min-h-11"
              aria-label={`${a.label}, ${row.name}`}
            >
              {a.label}
            </Button>
          </form>
        </li>
      ))}
    </ul>
  );
}

/** The row's one inline action (Activate / Show QR / Reconnect). Same action as the rest. */
export function PrimaryAction({ row, action, filter }: { row: LocationRow; action: Primary; filter: string }) {
  return (
    <form action={rowAction}>
      <input type="hidden" name="filter" value={filter} />
      <input type="hidden" name="location" value={row.id} />
      <input type="hidden" name="intent" value={action.key} />
      <Button type="submit" size="sm" variant="secondary" className="min-h-11" aria-label={`${action.label}, ${row.name}`}>
        {action.label}
      </Button>
    </form>
  );
}
