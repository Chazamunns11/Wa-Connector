import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Chip } from "@/components/ui/Chip";
import { relativeTime } from "@/lib/format";
import type { GhlHealthProblem, GhlHealthSnapshot, GhlInboundLocationHealth, GhlOutboundLocationHealth } from "@/lib/types";

/**
 * Owner "GHL WhatsApp health" panel — the missing operator surface flagged
 * after the GHL provider's Phases 1-3 shipped (docs/GHL-PROVIDER-PLAN.md,
 * docs/GHL-PHASE3-PLAN.md). Three GHL API contracts in that build were
 * ASSUMED rather than confirmed against a live account, and the documented
 * mitigation for all three was "the owner panel surfaces it" — but
 * `GhlAccountsPanel.tsx` (directly above this on `/owner/setup-links`) only
 * ever showed a per-location connection status chip. Every operational
 * signal the go-live runbook (docs/GHL-PROVIDER-GO-LIVE.md) promises —
 * outbound messages GHL still thinks are pending, `report_error` values,
 * inbound rows stuck on `ghl_push_uncertain`/`ghl_push_failed`/
 * `ghl_rejected`, `push_error` values — was previously reachable only by
 * hand-querying Supabase (the runbook literally said "check `push_error` in
 * the DB"). This panel answers those exact runbook questions without SQL.
 *
 * READ-ONLY, HARD CONSTRAINT: no button here mutates anything and none ever
 * should — no retry trigger, no resend, nothing. If a stuck row needs
 * action, the fix is a human opening that GHL conversation by hand (the
 * `ghl_push_uncertain` case) or reconnecting the location from
 * `GhlAccountsPanel` above (the `needs_reauth` case) — this panel's whole
 * job is to make that "does something need attention" question answerable
 * at a glance, never to act on the answer itself.
 *
 * PRIVACY, HARD CONSTRAINT: this is a health panel, not an inbox. Every
 * field on `GhlHealthSnapshot` (src/lib/types.ts) is a count, a timestamp, a
 * fixed diagnostic string, or a location label — NEVER message content,
 * NEVER a prospect phone number, NEVER a GHL contact id. The whole privacy
 * argument for the GHL provider build is that reply text goes to the
 * client's own GHL and nowhere else in our UI; this panel does not weaken
 * that.
 *
 * `ghl_push_uncertain` PROMINENCE, HARD CONSTRAINT: per the go-live runbook,
 * this is the ONE outcome that means a human must go look at that GHL
 * conversation by hand (the push may or may not have landed — never retried
 * automatically, to keep the at-most-once guarantee). Every location with a
 * non-zero count gets its own loud callout box, distinct from the routine
 * warn/muted chips every other count uses, and such locations sort to the
 * top of the per-location list.
 *
 * `snapshot: null` (final cross-phase review, finding 7): `getGhlHealthSnapshot`
 * can throw (a transient Supabase error) — the caller (`/owner/setup-links`)
 * now catches that (`safeGetGhlHealthSnapshot`, src/lib/ghl-health.ts) and
 * passes `null` through rather than letting the whole page 500. This module's
 * own header always promised a "never-crash-the-page posture"; this is that
 * promise finally covering a QUERY failure, not just an orphaned row.
 */
export function GhlHealthPanel({ snapshot, nowMs }: { snapshot: GhlHealthSnapshot | null; nowMs: number }) {
  if (snapshot === null) {
    return (
      <Card padded={false}>
        <div className="p-5">
          <CardHeader
            title="GHL WhatsApp health"
            subtitle="Whether GHL workflow messages are actually reaching WhatsApp (and GHL knows it), and whether prospect replies are actually reaching each client's GHL — the questions the go-live runbook asks, without a database query."
          />
          <div className="mt-4 rounded-lg border border-warn/40 bg-warn/10 p-4">
            <p className="text-sm font-semibold text-warn">Health data unavailable right now</p>
            <p className="mt-1 text-xs text-warn/90">
              The health read failed — this is a transient read problem, not evidence anything is actually broken. The
              rest of this page (webhook links, GHL accounts, reconnect buttons) still works normally; try refreshing.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const rows = combineRows(snapshot.outbound, snapshot.inbound);
  const totalUncertain = rows.reduce((sum, r) => sum + r.uncertainCount, 0);
  const uncertainRows = rows.filter((r) => r.uncertainCount > 0);

  return (
    <Card padded={false}>
      <div className="p-5 pb-0">
        <CardHeader
          title="GHL WhatsApp health"
          subtitle="Whether GHL workflow messages are actually reaching WhatsApp (and GHL knows it), and whether prospect replies are actually reaching each client's GHL — the questions the go-live runbook asks, without a database query."
        />
      </div>

      {snapshot.truncated ? (
        <div className="mx-5 mt-4 rounded-lg border border-warn/40 bg-warn/10 p-3">
          <p className="text-xs font-semibold text-warn">
            Showing the newest rows only — one of the reads behind this panel hit its cap. Every count below is a lower
            bound, not a complete figure, until the backlog causing this clears.
          </p>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title="No GHL locations installed yet"
            description="Health data will appear here once at least one location is installed via the panel above."
          />
        </div>
      ) : (
        <>
          {totalUncertain > 0 ? (
            <div className="mx-5 mt-4 rounded-lg border border-loss/40 bg-loss/10 p-4">
              <p className="text-sm font-semibold text-loss">
                {totalUncertain} repl{totalUncertain === 1 ? "y" : "ies"} across {uncertainRows.length}{" "}
                location{uncertainRows.length === 1 ? "" : "s"} need manual review in GHL
              </p>
              <p className="mt-1 text-xs text-loss/90">
                A push to GHL timed out — the reply may or may not have landed in that conversation. Never retried
                automatically (a duplicate reply in a client&apos;s CRM is worse than a manual check): {uncertainRows
                  .map((r) => `${r.label} (${r.uncertainCount})`)
                  .join(", ")}
                .
              </p>
            </div>
          ) : null}

          <div className="mt-3 divide-y divide-divider">
            {rows.map((r) => (
              <LocationHealthRow key={r.locationId} row={r} />
            ))}
          </div>

          <RecentProblems problems={snapshot.recentProblems} nowMs={nowMs} />
        </>
      )}
    </Card>
  );
}

/** One location's outbound + inbound health, merged for rendering — the two arrays on `GhlHealthSnapshot` are built from the same location list (`buildGhlHealthSnapshot`, src/lib/ghl-health.ts) so a plain zip by index is always index-aligned; this still joins by `locationId` explicitly rather than assuming that, so a future change to either array's build order can never silently mismatch a row's outbound counts with a different location's inbound counts. */
type CombinedLocationHealth = GhlOutboundLocationHealth & Omit<GhlInboundLocationHealth, "locationId" | "label">;

/**
 * Worst-first ordering: any `ghl_push_uncertain` count (the one outcome that
 * needs a human) always sorts to the top, then locations with the most
 * routine trouble, then alphabetical — "something's wrong with client X" is
 * meant to be the first row, not a scroll away.
 */
function combineRows(outbound: GhlOutboundLocationHealth[], inbound: GhlInboundLocationHealth[]): CombinedLocationHealth[] {
  const inboundByLocation = new Map(inbound.map((i) => [i.locationId, i]));
  const combined = outbound.map((o): CombinedLocationHealth => {
    const i = inboundByLocation.get(o.locationId);
    return {
      ...o,
      pushedCount: i?.pushedCount ?? 0,
      uncertainCount: i?.uncertainCount ?? 0,
      failedCount: i?.failedCount ?? 0,
      rejectedCount: i?.rejectedCount ?? 0,
      latestProblemKind: i?.latestProblemKind ?? null,
      latestProblemError: i?.latestProblemError ?? null,
      waitingCount: i?.waitingCount ?? 0,
    };
  });
  return combined.sort((a, b) => {
    if (a.uncertainCount !== b.uncertainCount) return b.uncertainCount - a.uncertainCount;
    const aTrouble = a.erroredCount + a.pendingOverOneHour + a.failedCount + a.rejectedCount;
    const bTrouble = b.erroredCount + b.pendingOverOneHour + b.failedCount + b.rejectedCount;
    if (aTrouble !== bTrouble) return bTrouble - aTrouble;
    return a.label.localeCompare(b.label);
  });
}

function LocationHealthRow({ row }: { row: CombinedLocationHealth }) {
  const totalPending = row.pendingUnderOneHour + row.pendingOverOneHour;
  return (
    <div className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">{row.label}</p>
          <p className="text-xs text-ink-faint">{row.locationId}</p>
        </div>
      </div>

      {row.uncertainCount > 0 ? (
        <div className="mt-3 rounded-lg border border-loss/40 bg-loss/10 p-3">
          <p className="text-sm font-semibold text-loss">
            {row.uncertainCount} repl{row.uncertainCount === 1 ? "y" : "ies"} need manual review in GHL
          </p>
          {row.latestProblemKind === "ghl_push_uncertain" && row.latestProblemError ? (
            <p className="mt-1 text-xs text-loss/90">Latest: {row.latestProblemError}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Outbound — GHL to WhatsApp</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Chip tone={row.pendingOverOneHour > 0 ? "warn" : "muted"}>
              {totalPending === 0 ? "Nothing pending" : `${totalPending} pending`}
            </Chip>
            {row.pendingOverOneHour > 0 ? <Chip tone="warn">{row.pendingOverOneHour} over 1h</Chip> : null}
            {row.erroredCount > 0 ? <Chip tone="loss">{row.erroredCount} status-report errors</Chip> : null}
          </div>
          {row.erroredCount > 0 && row.latestReportError ? (
            <p className="mt-1 text-xs text-ink-faint">Latest: {row.latestReportError}</p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Inbound — WhatsApp to GHL (last 7 days)</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Chip tone="win">{row.pushedCount} pushed</Chip>
            {/* Finding 9 — not windowed to 7 days like the counts above: this is the CURRENT queue, so it reflects a stalled drain immediately rather than only once a push has terminally failed. */}
            {row.waitingCount > 0 ? <Chip tone="muted">{row.waitingCount} waiting to be pushed</Chip> : null}
            {row.failedCount > 0 ? <Chip tone="warn">{row.failedCount} gave up after 5 tries</Chip> : null}
            {row.rejectedCount > 0 ? <Chip tone="warn">{row.rejectedCount} rejected by GHL</Chip> : null}
          </div>
          {(row.latestProblemKind === "ghl_push_failed" || row.latestProblemKind === "ghl_rejected") && row.latestProblemError ? (
            <p className="mt-1 text-xs text-ink-faint">Latest: {row.latestProblemError}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const PROBLEM_KIND_LABEL: Record<GhlHealthProblem["kind"], string> = {
  outbound_report_error: "Outbound status report failed",
  ghl_push_uncertain: "Inbound — needs manual check",
  ghl_push_failed: "Inbound — gave up after 5 tries",
  ghl_rejected: "Inbound — rejected by GHL",
};

/**
 * "The last 10 problem rows across locations" per the build brief — already
 * merged, capped, and newest-first by `buildGhlHealthSnapshot`
 * (src/lib/ghl-health.ts); this component only renders it. `ghl_push_uncertain`
 * rows get the same loud loss styling as everywhere else in this panel —
 * never blended into the routine warn-toned rows around them.
 */
function RecentProblems({ problems, nowMs }: { problems: GhlHealthProblem[]; nowMs: number }) {
  if (problems.length === 0) {
    return (
      <div className="border-t border-divider p-5">
        <p className="text-xs text-ink-faint">No problems in the recent history captured above — nothing here needs a look.</p>
      </div>
    );
  }
  return (
    <div className="border-t border-divider p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Recent problems</p>
      <ul className="mt-2 flex flex-col gap-2">
        {problems.map((p) => {
          const isUncertain = p.kind === "ghl_push_uncertain";
          // No stable DB id on a derived problem row (it's a fold of two
          // different tables, not a fetched row) — the tuple below is unique
          // per render because `recentProblems` never contains two entries
          // for the same location/kind/timestamp.
          const key = `${p.locationId}:${p.kind}:${p.atIso}`;
          return (
            <li key={key} className={`rounded-lg border p-2.5 text-xs ${isUncertain ? "border-loss/40 bg-loss/10" : "border-divider bg-raised"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className={`font-medium ${isUncertain ? "text-loss" : "text-ink"}`}>{p.label}</span>
                <span className="text-ink-faint">{relativeTime(p.atIso, nowMs)}</span>
              </div>
              <p className={`mt-1 ${isUncertain ? "text-loss/90" : "text-ink-faint"}`}>
                {PROBLEM_KIND_LABEL[p.kind]} — {p.detail}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
