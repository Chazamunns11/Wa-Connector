/**
 * GHL provider operator health surface — pure aggregation only, NO data-layer
 * imports (mirrors src/lib/integration-health.ts's split: `src/lib/data/
 * supabase.ts` runs the two bounded reads below, `src/lib/data/demo.ts`
 * returns an empty snapshot, and this module turns either into the shape
 * `GhlHealthSnapshot` describes (src/lib/types.ts) for both backends AND
 * `GhlHealthPanel.tsx` to share).
 *
 * ============ THE GAP THIS CLOSES ============
 * Three GHL API contracts in the Phase 1-3 build (docs/GHL-PROVIDER-PLAN.md,
 * docs/GHL-PHASE3-PLAN.md) were ASSUMED rather than confirmed against a live
 * account — the Update Message Status enum, the contacts upsert endpoint, the
 * inbound POST's `contactId` acceptance — and every one of them was mitigated
 * in the design docs with "the owner panel surfaces it" / "you'll see it".
 * `src/components/owner/GhlAccountsPanel.tsx` never grew that surface: it
 * shows a per-location connection status chip and nothing about message
 * flow. docs/GHL-PROVIDER-GO-LIVE.md's runbook and
 * docs/GHL-PROVIDER-CLIENT-MIGRATION.md's symptom table both told the
 * operator to hand-query Supabase ("check `push_error` in the DB") — this
 * file plus `Repository.getGhlHealthSnapshot` (src/lib/data/index.ts) plus
 * `GhlHealthPanel.tsx` is that surface, so the runbook can point at a page
 * instead.
 *
 * ============ WHY report_error IS NOT NULL IS ALWAYS A SUBSET OF
 * reported_status IS NULL ============
 * `src/lib/ghl-provider.ts`'s `reportGhlOutcome` is the ONLY writer of both
 * `ghl_outbound_messages.reported_status`/`report_error` (via
 * `Repository.markGhlOutboundReported`), and it sets them as a strict
 * either/or on every call: success sets `reportedStatus` and clears
 * `reportError` to `null`; failure leaves `reportedStatus` null and stamps
 * `reportError`. So a row can never carry both at once — which is what makes
 * ONE bounded read (`reported_status IS NULL`) sufficient for BOTH "still
 * pending" and "errored right now": the errored count is always a strict
 * subset of the pending count, never a separate query.
 *
 * ============ TWO WINDOWS, DELIBERATELY DIFFERENT SHAPES ============
 *   - Outbound: `ghl_outbound_messages` is never purged, but the
 *     `reported_status IS NULL` filter IS the bound — a row leaves that set
 *     the instant it's reported (success OR terminal failure), so under
 *     normal operation the whole backlog is a handful of rows (the drain
 *     itself processes up to 50 every pass, many passes an hour). The row cap
 *     below (`GHL_HEALTH_OUTBOUND_BACKLOG_CAP`) is a safety net for the one
 *     scenario where that assumption breaks — an extended outage — not the
 *     primary bound.
 *   - Inbound: `whatsapp_inbound_messages` accumulates BOTH healthy
 *     (`ghl_pushed`) and unhealthy resolutions forever, bounded only by the
 *     existing 90-day purge (`Repository.purgeOldWhatsappInboundMessages`),
 *     and cold inbound is completely ungated by design (any number that
 *     texts a connected line gets a row — docs/GHL-PROVIDER-GO-LIVE.md's
 *     "Still outstanding" section). An unbounded read here could genuinely be
 *     large under a spam wave. `GHL_HEALTH_INBOUND_WINDOW_DAYS` bounds it by
 *     TIME instead — a "current health" snapshot, not a full history — with
 *     `GHL_HEALTH_INBOUND_ROW_CAP` as the same kind of safety-net cap.
 *
 * ============ FINAL CROSS-PHASE REVIEW, FINDING 9 (LOW) — THE "WAITING TO
 * BE PUSHED" BLIND SPOT ============
 * The two reads above both filter to rows the drains have already finished
 * with (`reported_status IS NULL` counts a row still being retried, but
 * every inbound row read above has `resolution IS NOT NULL` — i.e. already
 * terminally resolved one way or another). GHL-tenant inbound rows still
 * SITTING IN THE QUEUE (`resolution IS NULL` — the exact set
 * `getUnprocessedGhlInboundMessages` reads) were invisible here: a stalled
 * drain (a broken `CRON_SECRET`, failing pokes, or every row fenced out by a
 * `needs_reauth` location) rendered an all-healthy inbound panel with
 * nothing waiting ever shown. `buildGhlHealthSnapshot`'s third rows array
 * (`waitingRows`) and `GhlInboundLocationHealth.waitingCount` close this —
 * same fence as the drain (`coach_id ∈ installed ghl_accounts.tenant_id`,
 * NOT filtered by account status, matching this whole method's "show the
 * operator what's actually happening" posture), no time window (a row sat
 * waiting for a week is exactly the thing this exists to surface), capped at
 * `GHL_HEALTH_INBOUND_ROW_CAP` like every other read here.
 *
 * ============ FINDING 3 — TRUNCATION IS NOW LABELLED, NEVER SILENT
 * ============ Every read above is capped, and until this fix a read that
 * hit its cap silently returned an ARBITRARY (newest-first) slice with no
 * signal anywhere that anything was cut off — one location flooding its
 * outbound/inbound counts past the cap could evict every OTHER location's
 * rows from the same global, uncapped-per-location query, and the evicted
 * location would render as "Nothing pending" (a reassuring number that was
 * actually a truncation artifact). `GhlHealthSnapshot.truncated` is `true`
 * whenever ANY of the three reads returned exactly its cap's worth of rows —
 * the panel renders a visible banner instead of presenting the counts below
 * it as complete. This is a coarse, whole-snapshot signal (not per-location)
 * deliberately: it is cheap (a length comparison, no extra query) and it is
 * the honest thing to say the instant ANY cap is hit — a per-location count
 * still being wrong is table stakes, not something a global flag needs to
 * localise; the fix for a location that trips this regularly is the
 * `count`/grouped-query rewrite this file's header already names as the
 * longer-term fix.
 */
import type { GhlHealthProblem, GhlHealthSnapshot, GhlInboundLocationHealth, GhlOutboundLocationHealth } from "@/lib/types";

/**
 * A row is "stale" once its unreported outbound intake has sat for this
 * long — see `GhlOutboundLocationHealth.pendingOverOneHour`'s JSDoc. Matches
 * the build brief's own "under an hour vs over" framing. Deliberately NOT
 * tied to any bridge/drain retry constant (`PENDING_SEND_MAX_ATTEMPTS`,
 * `TOKEN_EXPIRY_SKEW_MS`) — this is a human's read of staleness for triage,
 * not a retry bound.
 */
export const GHL_HEALTH_STALE_MS = 60 * 60 * 1000;

/**
 * `ghl_outbound_messages` health read: `reported_status IS NULL`, newest
 * `created_at` first, capped here. See this file's header for why the filter
 * itself is the real bound and this cap is a safety net, not the primary
 * control. Newest-first (the OPPOSITE of the drain's own oldest-first
 * ordering) so the "recent problems" list stays accurate even if a backlog
 * this large ever happens — the per-location COUNTS would already be
 * screaming "over 1h" for effectively everything in that scenario regardless
 * of which end of the backlog got truncated by the cap.
 */
export const GHL_HEALTH_OUTBOUND_BACKLOG_CAP = 500;

/**
 * `whatsapp_inbound_messages` health read window — see this file's header.
 * 7 days matches a "current health" read (a genuine problem stays visible for
 * a full week, plenty of time to notice on a normal working cadence) while
 * staying well inside the 90-day purge that already bounds this table.
 */
export const GHL_HEALTH_INBOUND_WINDOW_DAYS = 7;

/** Safety-net row cap alongside the time window above, in case ungated cold inbound spikes hard within it (a spam wave, or a misconfigured client workflow). */
export const GHL_HEALTH_INBOUND_ROW_CAP = 3000;

/** How many merged (outbound + inbound) problem rows the panel's incident list shows — "the last 10 problem rows across locations" per the build brief. */
export const GHL_HEALTH_RECENT_PROBLEMS_LIMIT = 10;

/** One installed location — the label map every count below is keyed against. Mirrors `GhlAccountSummary`'s `locationId`/`label`, plus the `tenantId` needed to key inbound rows (`whatsapp_inbound_messages.coach_id`, 0069's historical column name for a tenant id). */
export interface GhlHealthLocation {
  locationId: string;
  tenantId: string;
  /** Every number's tenant for this location (`ghl_location_numbers`), so a non-default number's inbound counts here too. `tenantId` always counts, listed or not. */
  tenantIds?: string[];
  label: string;
}

/** One `ghl_outbound_messages` row narrowed to exactly what this module needs — `src/lib/data/supabase.ts` maps the raw DB row to this shape before calling `buildGhlHealthSnapshot`. */
export interface GhlOutboundHealthRow {
  locationId: string;
  createdAt: string;
  reportError: string | null;
}

/** One `whatsapp_inbound_messages` row, GHL-tenant only (the caller fences this at query time — see `Repository.getGhlHealthSnapshot`'s JSDoc), narrowed the same way. */
export interface GhlInboundHealthRow {
  tenantId: string;
  createdAt: string;
  resolution: string;
  pushError: string | null;
}

/**
 * Finding 9 — one `whatsapp_inbound_messages` row still waiting to be pushed
 * (`resolution IS NULL`), GHL-tenant only (same fence as `GhlInboundHealthRow`
 * above). Narrower than `GhlInboundHealthRow` — a waiting row has no
 * resolution/pushError yet, that's the whole point of it being in this list.
 */
export interface GhlWaitingHealthRow {
  tenantId: string;
  createdAt: string;
}

const INBOUND_PROBLEM_KIND: Record<string, Exclude<GhlHealthProblem["kind"], "outbound_report_error">> = {
  ghl_push_uncertain: "ghl_push_uncertain",
  ghl_push_failed: "ghl_push_failed",
  ghl_rejected: "ghl_rejected",
};

function emptyOutboundHealth(loc: GhlHealthLocation): GhlOutboundLocationHealth {
  return { locationId: loc.locationId, label: loc.label, pendingUnderOneHour: 0, pendingOverOneHour: 0, erroredCount: 0, latestReportError: null };
}

function emptyInboundHealth(loc: GhlHealthLocation): GhlInboundLocationHealth {
  return {
    locationId: loc.locationId,
    label: loc.label,
    pushedCount: 0,
    uncertainCount: 0,
    failedCount: 0,
    rejectedCount: 0,
    latestProblemKind: null,
    latestProblemError: null,
    waitingCount: 0,
  };
}

/**
 * Turns the two bounded reads (`Repository.getGhlHealthSnapshot`) into the
 * panel's shape. Pure — every "latest" field is derived by comparing
 * timestamps across the ACTUAL rows passed in, never by assuming either
 * input array arrives in a particular order: `src/lib/data/supabase.ts`
 * orders its reads newest-first for the safety-net-cap reason in this file's
 * header, but this function must keep working correctly even if that ever
 * changes (or a test hands it rows in any order — see `scripts/test/
 * ghl-health.test.ts`).
 *
 * Rows for a `locationId`/`tenantId` this function doesn't recognise (e.g. an
 * account deleted between the two reads — structurally rare, both tables FK
 * to `ghl_accounts`/`whatsapp_tenants` `on delete cascade`/`restrict`) are
 * skipped rather than thrown on, matching this whole feature's read-only,
 * never-crash-the-page posture (the owner panel must render even if one row
 * is momentarily orphaned by a concurrent uninstall).
 */
export function buildGhlHealthSnapshot(
  locations: GhlHealthLocation[],
  outboundRows: GhlOutboundHealthRow[],
  inboundRows: GhlInboundHealthRow[],
  nowMs: number,
  /** Finding 9 — rows still `resolution IS NULL`, GHL-tenant only. Optional (defaults to `[]`) so every existing 4-argument call site (this module's own tests included) keeps working unchanged. */
  waitingRows: GhlWaitingHealthRow[] = []
): GhlHealthSnapshot {
  const outboundByLocation = new Map(locations.map((loc) => [loc.locationId, emptyOutboundHealth(loc)]));
  const inboundByLocation = new Map(locations.map((loc) => [loc.locationId, emptyInboundHealth(loc)]));
  const locationIdByTenantId = new Map(
    locations.flatMap((loc) => [loc.tenantId, ...(loc.tenantIds ?? [])].map((tenantId) => [tenantId, loc.locationId] as const))
  );

  // Tracks the timestamp behind each location's CURRENT "latest" string, so a
  // later (chronologically) row can overwrite an earlier one regardless of
  // input order — see this function's own JSDoc.
  const latestOutboundErrorAtMs = new Map<string, number>();
  const latestInboundProblemAtMs = new Map<string, number>();
  const problems: GhlHealthProblem[] = [];

  for (const row of outboundRows) {
    const bucket = outboundByLocation.get(row.locationId);
    if (!bucket) continue;

    const atMs = Date.parse(row.createdAt);
    if (nowMs - atMs >= GHL_HEALTH_STALE_MS) bucket.pendingOverOneHour++;
    else bucket.pendingUnderOneHour++;

    if (row.reportError) {
      bucket.erroredCount++;
      if (atMs >= (latestOutboundErrorAtMs.get(row.locationId) ?? -Infinity)) {
        latestOutboundErrorAtMs.set(row.locationId, atMs);
        bucket.latestReportError = row.reportError;
      }
      problems.push({ locationId: row.locationId, label: bucket.label, atIso: row.createdAt, kind: "outbound_report_error", detail: row.reportError });
    }
  }

  for (const row of inboundRows) {
    const locationId = locationIdByTenantId.get(row.tenantId);
    if (!locationId) continue;
    const bucket = inboundByLocation.get(locationId);
    if (!bucket) continue;

    if (row.resolution === "ghl_pushed") {
      bucket.pushedCount++;
      continue;
    }
    const kind = INBOUND_PROBLEM_KIND[row.resolution];
    // Not a problem kind: 'group_not_enabled' (a group row for a group that
    // is switched off — deliberate, never pushed), or an unrecognised string
    // (shouldn't happen — see this module's header). Ignore rather than guess.
    if (!kind) continue;

    if (kind === "ghl_push_uncertain") bucket.uncertainCount++;
    else if (kind === "ghl_push_failed") bucket.failedCount++;
    else bucket.rejectedCount++;

    // Always non-null in practice for these three terminal kinds
    // (`drainGhlInboundReplies` stamps `pushError` on every one — see
    // src/lib/ghl-inbound.ts) — the fallback is defensive only.
    const detail = row.pushError ?? "no diagnostic recorded";
    const atMs = Date.parse(row.createdAt);
    if (atMs >= (latestInboundProblemAtMs.get(locationId) ?? -Infinity)) {
      latestInboundProblemAtMs.set(locationId, atMs);
      bucket.latestProblemKind = kind;
      bucket.latestProblemError = detail;
    }
    problems.push({ locationId, label: bucket.label, atIso: row.createdAt, kind, detail });
  }

  for (const row of waitingRows) {
    const locationId = locationIdByTenantId.get(row.tenantId);
    if (!locationId) continue;
    const bucket = inboundByLocation.get(locationId);
    if (!bucket) continue;
    bucket.waitingCount++;
  }

  problems.sort((a, b) => Date.parse(b.atIso) - Date.parse(a.atIso));

  // Finding 3 — a read that came back with exactly its cap's worth of rows
  // may have had more truncated off silently; say so rather than presenting
  // the counts below as complete. See this file's header for the full
  // reasoning.
  const truncated =
    outboundRows.length >= GHL_HEALTH_OUTBOUND_BACKLOG_CAP ||
    inboundRows.length >= GHL_HEALTH_INBOUND_ROW_CAP ||
    waitingRows.length >= GHL_HEALTH_INBOUND_ROW_CAP;

  return {
    outbound: [...outboundByLocation.values()],
    inbound: [...inboundByLocation.values()],
    recentProblems: problems.slice(0, GHL_HEALTH_RECENT_PROBLEMS_LIMIT),
    truncated,
  };
}

/**
 * Finding 7 — a thin, testable wrapper around any async snapshot fetch
 * (real callers pass `() => repo.getGhlHealthSnapshot()`) that turns a throw
 * into `null` instead of crashing the caller. `src/lib/ghl-health.ts`'s own
 * "never-crash-the-page posture" (this file's header) previously only held
 * for orphaned rows INSIDE `buildGhlHealthSnapshot` — a genuine query
 * failure (a transient Supabase error) still threw straight out of
 * `Repository.getGhlHealthSnapshot`, and `/owner/setup-links` awaited that
 * call unguarded inside its own `Promise.all`, so one failing health read
 * 500'd the ENTIRE page — including the webhook links and reconnect buttons
 * an operator needs most during an incident. `src/app/owner/setup-links/
 * page.tsx` now calls this instead of the repo method directly; `null`
 * flows through to `GhlHealthPanel`, which renders its own "health
 * unavailable right now" state rather than never rendering at all.
 */
export async function safeGetGhlHealthSnapshot(fetchSnapshot: () => Promise<GhlHealthSnapshot>): Promise<GhlHealthSnapshot | null> {
  try {
    return await fetchSnapshot();
  } catch (err) {
    console.error("[ghl-health] getGhlHealthSnapshot failed (non-fatal) — health panel will render as unavailable:", err);
    return null;
  }
}
