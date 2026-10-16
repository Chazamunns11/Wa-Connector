import { Button } from "@/components/ui/Button";
import { rowActionsFor } from "@/lib/account-data/derive";
import type { LocationRow } from "@/lib/account-data";
import { previewRowAction } from "@/app/(app)/dashboard/actions";

const ACTIONS = [
  { key: "activate", label: "Activate", can: "activate" },
  { key: "show-qr", label: "Show QR", can: "showQr" },
  { key: "send-link", label: "Send connect link", can: "sendLink" },
  { key: "disconnect", label: "Disconnect", can: "disconnect" },
  { key: "deactivate", label: "Deactivate", can: "deactivate" },
] as const;

/**
 * Preview: each button posts to previewRowAction, which does nothing real.
 * Which buttons are enabled comes only from rowActionsFor.
 */
export function RowActions({ row, scenario, filter }: { row: LocationRow; scenario: string; filter: string }) {
  const allowed = rowActionsFor(row);
  return (
    <ul className="flex flex-wrap gap-2" aria-label={`Actions for ${row.name}`}>
      {ACTIONS.map((a) => (
        <li key={a.key}>
          <form action={previewRowAction}>
            <input type="hidden" name="scenario" value={scenario} />
            <input type="hidden" name="filter" value={filter} />
            <input type="hidden" name="location" value={row.id} />
            <input type="hidden" name="intent" value={a.key} />
            <Button
              type="submit"
              size="sm"
              variant={a.key === "deactivate" || a.key === "disconnect" ? "danger" : "secondary"}
              className="min-h-11"
              disabled={!allowed[a.can]}
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
