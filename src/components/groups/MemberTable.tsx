import { Chip, type ChipTone } from "@/components/ui/Chip";
import type { GroupMemberState, WhatsappGroupMember } from "@/lib/types";

const STATE: Record<GroupMemberState, { tone: ChipTone; label: string }> = {
  pending: { tone: "info", label: "Adding" },
  added: { tone: "win", label: "In the group" },
  invite_needed: { tone: "warn", label: "Invite to send" },
  invite_sent: { tone: "info", label: "Invite sent" },
  recently_left: { tone: "warn", label: "Left recently" },
  already_member: { tone: "muted", label: "Already in" },
  not_on_whatsapp: { tone: "loss", label: "No WhatsApp" },
  group_full: { tone: "loss", label: "Group full" },
  opted_out: { tone: "muted", label: "Replied STOP" },
  failed: { tone: "loss", label: "Not added" },
};

export function MemberTable({ members }: { members: WhatsappGroupMember[] }) {
  if (members.length === 0) return <p className="text-sm text-ink-faint">Nobody added yet.</p>;
  return (
    <ul aria-label="Members" className="divide-y divide-divider overflow-hidden rounded-lg border bg-card">
      {members.map((m) => (
        <li key={m.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{m.displayName || m.phone}</p>
            {m.displayName ? <p className="text-sm tabular-nums text-ink-dim">{m.phone}</p> : null}
          </div>
          <div className="flex flex-col gap-1 sm:items-end">
            <Chip tone={STATE[m.state].tone}>{STATE[m.state].label}</Chip>
            {m.lastReason && m.state !== "added" && m.state !== "pending" ? (
              <p className="text-sm text-ink-faint sm:text-right">{m.lastReason}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
