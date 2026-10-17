import { postToGroupAction } from "@/app/(app)/dashboard/groups/actions";
import { INPUT_CLASSES } from "@/components/auth/field";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip, type ChipTone } from "@/components/ui/Chip";
import { POST_TEXT_MAX } from "@/lib/groups/rules";
import type { WhatsappGroupPost } from "@/lib/types";

const TONE: Record<WhatsappGroupPost["status"], { tone: ChipTone; label: string }> = {
  accepted: { tone: "info", label: "Queued" },
  sending: { tone: "info", label: "Sending" },
  sent: { tone: "win", label: "Sent" },
  failed: { tone: "loss", label: "Failed" },
};

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export function PostForm({ groupId, disabled, posts }: { groupId: string; disabled: boolean; posts: WhatsappGroupPost[] }) {
  return (
    <Card>
      <h2 className="font-display text-lg">Post a message</h2>
      <form action={postToGroupAction} className="mt-3 space-y-3">
        <input type="hidden" name="group" value={groupId} />
        <input type="hidden" name="token" value={crypto.randomUUID()} />
        <label htmlFor="post-text" className="sr-only">
          Message
        </label>
        <textarea id="post-text" name="text" rows={4} required maxLength={POST_TEXT_MAX} disabled={disabled} className={`${INPUT_CLASSES} py-2`} />
        <p className="text-sm text-ink-faint">
          Posts go out at this number&apos;s normal sending pace and count towards its daily limit. Text only.
        </p>
        <Button type="submit" disabled={disabled} className="min-h-11 px-5">
          Post message
        </Button>
      </form>
      {posts.length > 0 ? (
        <div className="mt-5 border-t border-divider pt-4">
          <h3 className="text-sm font-medium text-ink">Recent posts</h3>
          <ul className="mt-2 divide-y divide-divider">
            {posts.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-ink-dim">{when(p.createdAt)}</span>
                <Chip tone={TONE[p.status].tone}>{TONE[p.status].label}</Chip>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-ink-faint">Message text isn&apos;t kept here, only whether it went out.</p>
        </div>
      ) : null}
    </Card>
  );
}
