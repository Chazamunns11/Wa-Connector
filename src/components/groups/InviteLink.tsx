import { rotateInviteAction } from "@/app/(app)/dashboard/groups/actions";
import { CopyButton } from "@/components/owner/CopyButton";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export function InviteLink({ groupId, inviteCode, disabled }: { groupId: string; inviteCode: string | null; disabled: boolean }) {
  const url = inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null;
  return (
    <Card>
      <h2 className="font-display text-lg">Invite link</h2>
      {url ? (
        <>
          <p className="mt-2 break-all rounded-lg border bg-well px-3 py-2 text-sm text-ink">{url}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CopyButton value={url} label="Copy link" size="md" />
            <form action={rotateInviteAction}>
              <input type="hidden" name="group" value={groupId} />
              <Button type="submit" variant="ghost" disabled={disabled} className="min-h-11">
                Make a new link
              </Button>
            </form>
          </div>
          <p className="mt-3 text-sm text-ink-faint">A new link stops the old one working for anyone who hasn&apos;t joined yet.</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-faint">No invite link yet. Refresh from WhatsApp, or make a new link.</p>
      )}
    </Card>
  );
}
