import type { Metadata } from "next";
import Link from "next/link";
import { GroupList } from "@/components/groups/GroupList";
import { GroupsOff } from "@/components/groups/GroupsOff";
import { Container } from "@/components/site/Container";
import { buttonClasses } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { repo } from "@/lib/data";
import { SITE_ROUTES } from "@/lib/site/routes";
import { groupsEnabled } from "./deps";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `Groups — ${brandConfig().name}`, robots: { index: false } };
}

export default async function GroupsPage() {
  const session = await requireAccountSession();
  if (!groupsEnabled()) {
    return (
      <Container className="py-8 md:py-12">
        <GroupsOff />
      </Container>
    );
  }
  const [groups, locations] = await Promise.all([
    repo.listWhatsappGroupsForAccount(session.accountId),
    repo.listGhlAccountsForAccount(session.accountId),
  ]);
  const label = (id: string) => locations.find((l) => l.locationId === id)?.label ?? "Unknown number";

  return (
    <Container className="py-8 md:py-12">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl">WhatsApp groups</h1>
          <p className="mt-2 max-w-prose text-ink-dim">
            Create a group from one of your connected numbers and add people from GoHighLevel. Replies stay in WhatsApp on the phone; they
            don&apos;t appear in GoHighLevel.
          </p>
        </div>
        <Link href={SITE_ROUTES.newGroup} className={buttonClasses("primary", "md", "min-h-11 px-5")}>
          New group
        </Link>
      </div>
      <div className="mt-8">
        {groups.length === 0 ? (
          <EmptyState
            title="No groups yet"
            description="Groups you create appear here. Adding people is paced and capped each day to keep your number safe."
            action={
              <Link href={SITE_ROUTES.newGroup} className={buttonClasses("primary", "md", "min-h-11 px-5")}>
                Create your first group
              </Link>
            }
          />
        ) : (
          <GroupList groups={groups} numberLabel={label} />
        )}
      </div>
    </Container>
  );
}
