import type { Metadata } from "next";
import Link from "next/link";
import { GroupForm, type NumberOption } from "@/components/groups/GroupForm";
import { GroupsOff } from "@/components/groups/GroupsOff";
import { ResultNotice } from "@/components/groups/ResultNotice";
import { Container } from "@/components/site/Container";
import { requireAccountSession } from "@/lib/account-session";
import { brandConfig } from "@/lib/brand-config";
import { repo } from "@/lib/data";
import { parseGroupResult } from "@/lib/groups/forms";
import { GROUP_ADDS_PER_DAY, GROUP_CREATES_PER_DAY, REASON_NOT_CONNECTED } from "@/lib/groups/rules";
import { SITE_ROUTES } from "@/lib/site/routes";
import { groupsEnabled } from "../deps";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return { title: `New group — ${brandConfig().name}`, robots: { index: false } };
}

export default async function NewGroupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireAccountSession();
  const params = await searchParams;
  if (!groupsEnabled()) {
    return (
      <Container className="py-8 md:py-12">
        <GroupsOff />
      </Container>
    );
  }
  const locations = await repo.listGhlAccountsForAccount(session.accountId);
  const numbers: NumberOption[] = await Promise.all(
    locations.map(async (l) => {
      if (!l.activatedAt) return { locationId: l.locationId, label: l.label, usable: false, note: "not activated" };
      const summary = await repo.getWhatsappSessionSummary(l.tenantId);
      return summary?.status === "connected"
        ? { locationId: l.locationId, label: l.label, usable: true, note: null }
        : { locationId: l.locationId, label: l.label, usable: false, note: "not connected" };
    }),
  );
  const anyUsable = numbers.some((n) => n.usable);

  return (
    <Container className="max-w-2xl py-8 md:py-12">
      <Link href={SITE_ROUTES.groups} className="inline-flex min-h-11 items-center text-sm text-accent-text underline underline-offset-2">
        All groups
      </Link>
      <h1 className="font-display text-3xl">New WhatsApp group</h1>
      <ResultNotice result={parseGroupResult(params.error)} />
      {!anyUsable ? (
        <p role="status" className="mt-4 rounded-lg border border-warn/30 bg-warn-soft p-3 text-ink">
          {REASON_NOT_CONNECTED}.
        </p>
      ) : null}
      <p className="mb-6 mt-3 text-ink-dim">
        Only add people who have agreed to be in the group. If someone&apos;s privacy settings block direct adds, they get the invite link as a normal
        message from this number instead. Each number can create {GROUP_CREATES_PER_DAY} groups and add {GROUP_ADDS_PER_DAY} people a day.
      </p>
      <GroupForm numbers={numbers} disabled={!anyUsable} />
    </Container>
  );
}
