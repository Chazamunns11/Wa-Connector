import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { GroupsOff } from "@/components/groups/GroupsOff";
import { InviteLink } from "@/components/groups/InviteLink";
import { MemberPicker } from "@/components/groups/MemberPicker";
import { MemberTable } from "@/components/groups/MemberTable";
import { PostForm } from "@/components/groups/PostForm";
import { ResultNotice } from "@/components/groups/ResultNotice";
import { Container } from "@/components/site/Container";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { repo } from "@/lib/data";
import { parseGroupResult } from "@/lib/groups/forms";
import { loadGroupView } from "@/lib/groups/service";
import { SITE_ROUTES } from "@/lib/site/routes";
import { addMembersAction, refreshGroupAction } from "../actions";
import { groupsDeps, groupsEnabled } from "../deps";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `Group — ${brandConfig().name}`, robots: { index: false } };
}

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAccountSession();
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  if (!groupsEnabled()) {
    return (
      <Container className="py-8 md:py-12">
        <GroupsOff />
      </Container>
    );
  }
  const view = await loadGroupView(repo, groupsDeps(), session, groupId);
  if (!view) notFound();
  const { group, members, posts, locationName, gateReason } = view;
  const blocked = gateReason !== null;

  return (
    <Container className="py-8 md:py-12">
      <Link href={SITE_ROUTES.groups} className="inline-flex min-h-11 items-center text-sm text-accent-text underline underline-offset-2">
        All groups
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-3xl">{group.subject}</h1>
          <p className="mt-1 text-ink-dim">
            {locationName || "Your number"} · {group.participantCount} {group.participantCount === 1 ? "person" : "people"}
            {group.weAreAdmin ? "" : " · this number is not an admin"}
          </p>
        </div>
        <form action={refreshGroupAction}>
          <input type="hidden" name="group" value={group.id} />
          <Button type="submit" variant="secondary" className="min-h-11">
            Refresh from WhatsApp
          </Button>
        </form>
      </div>
      <ResultNotice result={parseGroupResult(query.result)} />
      {blocked ? (
        <p role="status" className="mt-4 rounded-lg border border-warn/30 bg-warn-soft p-3 text-ink">
          {gateReason.replace(/[.]$/, "")}. Adding people and posting are paused until then.
        </p>
      ) : null}
      <p className="mt-4 max-w-prose text-sm text-ink-faint">Replies stay in WhatsApp on the phone; they don&apos;t appear in GoHighLevel.</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <section aria-labelledby="members">
            <h2 id="members" className="mb-3 font-display text-lg">
              People
            </h2>
            <MemberTable members={members} />
          </section>
          <Card>
            <h2 className="font-display text-lg">Add people</h2>
            <form action={addMembersAction} className="mt-3">
              <input type="hidden" name="group" value={group.id} />
              <MemberPicker locationId={group.locationId} />
              <Button type="submit" disabled={blocked} className="mt-4 min-h-11 px-5">
                Add people
              </Button>
            </form>
          </Card>
        </div>
        <div className="space-y-6">
          <InviteLink groupId={group.id} inviteCode={group.inviteCode} disabled={blocked} />
          <PostForm groupId={group.id} disabled={blocked} posts={posts} />
        </div>
      </div>
    </Container>
  );
}
