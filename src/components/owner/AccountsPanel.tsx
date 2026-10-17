import { Card, CardHeader } from "@/components/ui/Card";
import { Chip, type ChipTone } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDate } from "@/lib/format";
import type { AccountAdminRow, BillingStatus } from "@/lib/types";

const STATUS_TONE: Record<BillingStatus, ChipTone> = {
  pending: "muted",
  trialing: "info",
  active: "win",
  comped: "win",
  past_due: "warn",
  paused: "warn",
  cancelled: "loss",
};

/** Owner-only list of every account: plan state, how many numbers are live, and who to contact. Read-only. */
export function AccountsPanel({ rows }: { rows: AccountAdminRow[] }) {
  return (
    <Card>
      <CardHeader title="Accounts" subtitle="Every signed-up account, oldest first." />
      {rows.length === 0 ? (
        <EmptyState title="No accounts yet" description="Accounts appear here once someone signs up." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-faint">
              <tr>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Kind</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Numbers active</th>
                <th className="py-2 pr-4 font-medium">Trial ends</th>
                <th className="py-2 font-medium">Owner email</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ account, locations, activeNumbers }) => (
                <tr key={account.id} className="border-t">
                  <td className="py-2 pr-4 text-ink">{account.name}</td>
                  <td className="py-2 pr-4 capitalize">{account.kind}</td>
                  <td className="py-2 pr-4">
                    <Chip tone={STATUS_TONE[account.billingStatus] ?? "muted"}>{account.billingStatus.replace("_", " ")}</Chip>
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {activeNumbers} / {locations}
                  </td>
                  <td className="py-2 pr-4">{account.trialEndsAt ? formatDate(account.trialEndsAt) : "-"}</td>
                  <td className="py-2 break-all">{account.ownerEmail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
