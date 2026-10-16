/**
 * GHL provider operator health surface — unit tests for
 * `src/lib/ghl-health.ts`'s `buildGhlHealthSnapshot`, the pure aggregation
 * behind `Repository.getGhlHealthSnapshot` (src/lib/data/index.ts) and
 * `GhlHealthPanel.tsx`. Entirely offline, no Supabase, no fetch — the two
 * bounded queries themselves can't be tested without a DB (see this file's
 * own scope note below); what's genuinely testable is everything the query
 * results feed into: staleness bucketing, the report_error/reported_status
 * subset relationship, "latest" tracking under out-of-order input, the
 * tenant-id-to-location join, and the recent-problems merge/cap/sort.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGhlHealthSnapshot,
  GHL_HEALTH_INBOUND_ROW_CAP,
  GHL_HEALTH_OUTBOUND_BACKLOG_CAP,
  GHL_HEALTH_RECENT_PROBLEMS_LIMIT,
  GHL_HEALTH_STALE_MS,
  safeGetGhlHealthSnapshot,
  type GhlHealthLocation,
  type GhlInboundHealthRow,
  type GhlOutboundHealthRow,
  type GhlWaitingHealthRow,
} from "@/lib/ghl-health";
import type { GhlHealthSnapshot } from "@/lib/types";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

function loc(overrides: Partial<GhlHealthLocation> = {}): GhlHealthLocation {
  return { locationId: "loc-1", tenantId: "tenant-1", label: "Anton — XYZ Coaching", ...overrides };
}

function outboundRow(overrides: Partial<GhlOutboundHealthRow> = {}): GhlOutboundHealthRow {
  return { locationId: "loc-1", createdAt: new Date(NOW).toISOString(), reportError: null, ...overrides };
}

function inboundRow(overrides: Partial<GhlInboundHealthRow> = {}): GhlInboundHealthRow {
  return { tenantId: "tenant-1", createdAt: new Date(NOW).toISOString(), resolution: "ghl_pushed", pushError: null, ...overrides };
}

function waitingRow(overrides: Partial<GhlWaitingHealthRow> = {}): GhlWaitingHealthRow {
  return { tenantId: "tenant-1", createdAt: new Date(NOW).toISOString(), ...overrides };
}

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Locations are seeded even at zero activity
// ---------------------------------------------------------------------------

test("every installed location gets an outbound + inbound entry even with zero rows", () => {
  const snapshot = buildGhlHealthSnapshot([loc({ locationId: "loc-1", tenantId: "t1" }), loc({ locationId: "loc-2", tenantId: "t2", label: "Second" })], [], [], NOW);
  assert.equal(snapshot.outbound.length, 2);
  assert.equal(snapshot.inbound.length, 2);
  for (const o of snapshot.outbound) {
    assert.equal(o.pendingUnderOneHour, 0);
    assert.equal(o.pendingOverOneHour, 0);
    assert.equal(o.erroredCount, 0);
    assert.equal(o.latestReportError, null);
  }
  for (const i of snapshot.inbound) {
    assert.equal(i.pushedCount, 0);
    assert.equal(i.uncertainCount, 0);
    assert.equal(i.failedCount, 0);
    assert.equal(i.rejectedCount, 0);
    assert.equal(i.latestProblemKind, null);
    assert.equal(i.latestProblemError, null);
  }
  assert.deepEqual(snapshot.recentProblems, []);
});

test("no installed locations -> a completely empty snapshot", () => {
  const snapshot = buildGhlHealthSnapshot([], [], [], NOW);
  assert.deepEqual(snapshot, { outbound: [], inbound: [], recentProblems: [], truncated: false });
});

// ---------------------------------------------------------------------------
// Outbound: staleness bucketing (the build brief's "under an hour vs over")
// ---------------------------------------------------------------------------

test("outbound: a row just under the stale threshold counts as under-an-hour", () => {
  const row = outboundRow({ createdAt: new Date(NOW - (GHL_HEALTH_STALE_MS - 1)).toISOString() });
  const snapshot = buildGhlHealthSnapshot([loc()], [row], [], NOW);
  assert.equal(snapshot.outbound[0].pendingUnderOneHour, 1);
  assert.equal(snapshot.outbound[0].pendingOverOneHour, 0);
});

test("outbound: a row exactly at, or past, the stale threshold counts as over-an-hour", () => {
  const exact = outboundRow({ createdAt: new Date(NOW - GHL_HEALTH_STALE_MS).toISOString() });
  const past = outboundRow({ createdAt: isoMinutesAgo(90) });
  const snapshot = buildGhlHealthSnapshot([loc()], [exact, past], [], NOW);
  assert.equal(snapshot.outbound[0].pendingUnderOneHour, 0);
  assert.equal(snapshot.outbound[0].pendingOverOneHour, 2);
});

// ---------------------------------------------------------------------------
// Outbound: errored rows are a SUBSET of pending rows, never additional
// ---------------------------------------------------------------------------

test("outbound: an errored row counts toward BOTH the staleness bucket AND erroredCount, never a third total", () => {
  const row = outboundRow({ createdAt: isoMinutesAgo(90), reportError: "no valid GHL access token available to report status" });
  const snapshot = buildGhlHealthSnapshot([loc()], [row], [], NOW);
  const o = snapshot.outbound[0];
  assert.equal(o.pendingOverOneHour, 1);
  assert.equal(o.pendingUnderOneHour, 0);
  assert.equal(o.erroredCount, 1);
  assert.equal(o.latestReportError, "no valid GHL access token available to report status");
});

test("outbound: latestReportError tracks the CHRONOLOGICALLY latest error regardless of input array order", () => {
  const older = outboundRow({ createdAt: isoMinutesAgo(120), reportError: "older error" });
  const newer = outboundRow({ createdAt: isoMinutesAgo(10), reportError: "newer error" });
  // Deliberately fed newest-first here and oldest-first in the second case —
  // the function must not assume either order (see its own JSDoc).
  const snapshotA = buildGhlHealthSnapshot([loc()], [newer, older], [], NOW);
  const snapshotB = buildGhlHealthSnapshot([loc()], [older, newer], [], NOW);
  assert.equal(snapshotA.outbound[0].latestReportError, "newer error");
  assert.equal(snapshotB.outbound[0].latestReportError, "newer error");
  assert.equal(snapshotA.outbound[0].erroredCount, 2);
});

test("outbound: a row with no reportError never increments erroredCount or touches latestReportError", () => {
  const row = outboundRow({ reportError: null });
  const snapshot = buildGhlHealthSnapshot([loc()], [row], [], NOW);
  assert.equal(snapshot.outbound[0].erroredCount, 0);
  assert.equal(snapshot.outbound[0].latestReportError, null);
});

test("outbound: a row for an unrecognised locationId is skipped, not thrown on", () => {
  const row = outboundRow({ locationId: "some-deleted-location", reportError: "x" });
  assert.doesNotThrow(() => buildGhlHealthSnapshot([loc()], [row], [], NOW));
  const snapshot = buildGhlHealthSnapshot([loc()], [row], [], NOW);
  assert.equal(snapshot.outbound[0].erroredCount, 0);
  assert.equal(snapshot.recentProblems.length, 0);
});

// ---------------------------------------------------------------------------
// Inbound: resolution -> bucket mapping
// ---------------------------------------------------------------------------

test("inbound: ghl_pushed increments pushedCount only, and never produces a problem row", () => {
  const row = inboundRow({ resolution: "ghl_pushed" });
  const snapshot = buildGhlHealthSnapshot([loc()], [], [row], NOW);
  assert.equal(snapshot.inbound[0].pushedCount, 1);
  assert.equal(snapshot.inbound[0].uncertainCount, 0);
  assert.equal(snapshot.recentProblems.length, 0);
});

test("inbound: each of the three problem resolutions increments its own counter, independently", () => {
  const rows = [
    inboundRow({ resolution: "ghl_push_uncertain", pushError: "timed out" }),
    inboundRow({ resolution: "ghl_push_failed", pushError: "gave up" }),
    inboundRow({ resolution: "ghl_rejected", pushError: "HTTP 400" }),
  ];
  const snapshot = buildGhlHealthSnapshot([loc()], [], rows, NOW);
  const i = snapshot.inbound[0];
  assert.equal(i.uncertainCount, 1);
  assert.equal(i.failedCount, 1);
  assert.equal(i.rejectedCount, 1);
  assert.equal(i.pushedCount, 0);
});

test("inbound: latestProblemKind/latestProblemError track the CHRONOLOGICALLY latest problem regardless of input order", () => {
  const older = inboundRow({ resolution: "ghl_rejected", createdAt: isoMinutesAgo(120), pushError: "older rejection" });
  const newer = inboundRow({ resolution: "ghl_push_uncertain", createdAt: isoMinutesAgo(5), pushError: "newer uncertain" });
  const snapshot = buildGhlHealthSnapshot([loc()], [], [older, newer], NOW);
  assert.equal(snapshot.inbound[0].latestProblemKind, "ghl_push_uncertain");
  assert.equal(snapshot.inbound[0].latestProblemError, "newer uncertain");

  const reversed = buildGhlHealthSnapshot([loc()], [], [newer, older], NOW);
  assert.equal(reversed.inbound[0].latestProblemKind, "ghl_push_uncertain");
  assert.equal(reversed.inbound[0].latestProblemError, "newer uncertain");
});

test("inbound: an unrecognised resolution string is ignored — no counter moves, no crash, no problem row", () => {
  const row = inboundRow({ resolution: "matched" }); // a COACH-tenant resolution value — should never reach this fence in practice, but must degrade safely if it ever did
  assert.doesNotThrow(() => buildGhlHealthSnapshot([loc()], [], [row], NOW));
  const snapshot = buildGhlHealthSnapshot([loc()], [], [row], NOW);
  const i = snapshot.inbound[0];
  assert.equal(i.pushedCount, 0);
  assert.equal(i.uncertainCount + i.failedCount + i.rejectedCount, 0);
  assert.equal(snapshot.recentProblems.length, 0);
});

test("inbound: a row for an unrecognised tenantId is skipped, not thrown on", () => {
  const row = inboundRow({ tenantId: "some-orphan-tenant", resolution: "ghl_rejected", pushError: "x" });
  assert.doesNotThrow(() => buildGhlHealthSnapshot([loc()], [], [row], NOW));
  assert.equal(buildGhlHealthSnapshot([loc()], [], [row], NOW).recentProblems.length, 0);
});

test("inbound: a problem row with no pushError falls back to a fixed placeholder rather than null/undefined", () => {
  const row = inboundRow({ resolution: "ghl_push_failed", pushError: null });
  const snapshot = buildGhlHealthSnapshot([loc()], [], [row], NOW);
  assert.equal(snapshot.inbound[0].latestProblemError, "no diagnostic recorded");
});

// ---------------------------------------------------------------------------
// Multiple locations stay independent
// ---------------------------------------------------------------------------

test("counts for one location never leak into another", () => {
  const locations = [loc({ locationId: "loc-1", tenantId: "t1", label: "One" }), loc({ locationId: "loc-2", tenantId: "t2", label: "Two" })];
  const outboundRows = [outboundRow({ locationId: "loc-1", reportError: "err-1" })];
  const inboundRows = [inboundRow({ tenantId: "t2", resolution: "ghl_push_uncertain", pushError: "uncertain-2" })];
  const snapshot = buildGhlHealthSnapshot(locations, outboundRows, inboundRows, NOW);

  const byLoc = <T extends { locationId: string }>(arr: T[]) => new Map(arr.map((r) => [r.locationId, r]));
  const outByLoc = byLoc(snapshot.outbound);
  const inByLoc = byLoc(snapshot.inbound);

  assert.equal(outByLoc.get("loc-1")!.erroredCount, 1);
  assert.equal(outByLoc.get("loc-2")!.erroredCount, 0);
  assert.equal(inByLoc.get("loc-1")!.uncertainCount, 0);
  assert.equal(inByLoc.get("loc-2")!.uncertainCount, 1);
});

// ---------------------------------------------------------------------------
// recentProblems: merge, cap, sort
// ---------------------------------------------------------------------------

test("recentProblems merges outbound errors and inbound problem rows, newest first", () => {
  const outboundRows = [outboundRow({ createdAt: isoMinutesAgo(30), reportError: "outbound err" })];
  const inboundRows = [inboundRow({ resolution: "ghl_rejected", createdAt: isoMinutesAgo(5), pushError: "inbound err" })];
  const snapshot = buildGhlHealthSnapshot([loc()], outboundRows, inboundRows, NOW);
  assert.equal(snapshot.recentProblems.length, 2);
  assert.equal(snapshot.recentProblems[0].kind, "ghl_rejected"); // 5 min ago — newer
  assert.equal(snapshot.recentProblems[1].kind, "outbound_report_error"); // 30 min ago — older
});

test("recentProblems is capped at GHL_HEALTH_RECENT_PROBLEMS_LIMIT even with many more problem rows, keeping the newest", () => {
  const total = GHL_HEALTH_RECENT_PROBLEMS_LIMIT + 5;
  const rows: GhlOutboundHealthRow[] = [];
  for (let i = 0; i < total; i++) {
    rows.push(outboundRow({ createdAt: isoMinutesAgo(total - i), reportError: `err-${i}` })); // rows[total-1] is the most recent
  }
  const snapshot = buildGhlHealthSnapshot([loc()], rows, [], NOW);
  assert.equal(snapshot.recentProblems.length, GHL_HEALTH_RECENT_PROBLEMS_LIMIT);
  assert.equal(snapshot.recentProblems[0].detail, `err-${total - 1}`); // newest kept
  assert.equal(snapshot.recentProblems[GHL_HEALTH_RECENT_PROBLEMS_LIMIT - 1].detail, `err-${total - GHL_HEALTH_RECENT_PROBLEMS_LIMIT}`);
});

test("recentProblems: a pending-but-not-errored outbound row and a pushed inbound row never appear in the list", () => {
  const outboundRows = [outboundRow({ reportError: null })];
  const inboundRows = [inboundRow({ resolution: "ghl_pushed" })];
  const snapshot = buildGhlHealthSnapshot([loc()], outboundRows, inboundRows, NOW);
  assert.deepEqual(snapshot.recentProblems, []);
});

// ---------------------------------------------------------------------------
// Privacy shape — the panel's hard constraint, pinned at the data level
// ---------------------------------------------------------------------------

test("no field anywhere in the snapshot is a phone number, message body, or GHL contact id — only counts/timestamps/labels/fixed strings", () => {
  const outboundRows = [outboundRow({ reportError: "phone number could not be read as E.164" })];
  const inboundRows = [inboundRow({ resolution: "ghl_rejected", pushError: "HTTP 400" })];
  const snapshot = buildGhlHealthSnapshot([loc()], outboundRows, inboundRows, NOW);
  const serialised = JSON.stringify(snapshot);
  // A crude but effective pin: nothing in this feature ever threads a
  // GHL contactId (this codebase's ids look like "contact-..." in fixtures
  // and are always GHL-opaque strings) or an E.164 phone number through —
  // the fixed strings above are the closest this gets to "phone" and they're
  // diagnostic text, not a number.
  assert.equal(/\+\d{7,}/.test(serialised), false, "snapshot must never contain an E.164-shaped phone number");
  assert.equal(serialised.includes("contactId"), false);
  assert.equal(serialised.includes("ghlContactId"), false);
});

// ---------------------------------------------------------------------------
// Final cross-phase review, finding 9 — waitingCount ("resolution IS NULL",
// i.e. genuinely still queued, not yet attempted or mid-retry)
// ---------------------------------------------------------------------------

test("waiting rows (resolution IS NULL) increment waitingCount, independent of the processed inbound rows", () => {
  const waiting = [waitingRow(), waitingRow(), waitingRow({ tenantId: "some-orphan-tenant" })];
  const snapshot = buildGhlHealthSnapshot([loc()], [], [inboundRow({ resolution: "ghl_pushed" })], NOW, waiting);
  assert.equal(snapshot.inbound[0].waitingCount, 2, "only rows for a RECOGNISED tenant count; the orphan-tenant row is skipped, not thrown on");
  assert.equal(snapshot.inbound[0].pushedCount, 1, "waiting rows must never be conflated with the already-processed counts");
});

test("with no waitingRows argument at all (every pre-finding-9 call site), waitingCount is zero — the parameter is genuinely optional", () => {
  const snapshot = buildGhlHealthSnapshot([loc()], [], [inboundRow({ resolution: "ghl_pushed" })], NOW);
  assert.equal(snapshot.inbound[0].waitingCount, 0);
});

// ---------------------------------------------------------------------------
// Final cross-phase review, finding 3 — snapshot.truncated
// ---------------------------------------------------------------------------

test("truncated is false when no read comes anywhere near its cap", () => {
  const snapshot = buildGhlHealthSnapshot([loc()], [outboundRow()], [inboundRow()], NOW, [waitingRow()]);
  assert.equal(snapshot.truncated, false);
});

test("truncated is true when the outbound read comes back with exactly GHL_HEALTH_OUTBOUND_BACKLOG_CAP rows — a flooding location can evict every OTHER location's rows from this same global read, so this must be visible even though every count still looks like a normal number", () => {
  const rows: GhlOutboundHealthRow[] = [];
  for (let i = 0; i < GHL_HEALTH_OUTBOUND_BACKLOG_CAP; i++) rows.push(outboundRow({ createdAt: isoMinutesAgo(i) }));
  const snapshot = buildGhlHealthSnapshot([loc()], rows, [], NOW);
  assert.equal(snapshot.truncated, true);
});

test("truncated is true when the inbound read comes back with exactly GHL_HEALTH_INBOUND_ROW_CAP rows", () => {
  const rows: GhlInboundHealthRow[] = [];
  for (let i = 0; i < GHL_HEALTH_INBOUND_ROW_CAP; i++) rows.push(inboundRow({ createdAt: isoMinutesAgo(i) }));
  const snapshot = buildGhlHealthSnapshot([loc()], [], rows, NOW);
  assert.equal(snapshot.truncated, true);
});

test("truncated is true when the waiting read comes back with exactly GHL_HEALTH_INBOUND_ROW_CAP rows", () => {
  const rows: GhlWaitingHealthRow[] = [];
  for (let i = 0; i < GHL_HEALTH_INBOUND_ROW_CAP; i++) rows.push(waitingRow({ createdAt: isoMinutesAgo(i) }));
  const snapshot = buildGhlHealthSnapshot([loc()], [], [], NOW, rows);
  assert.equal(snapshot.truncated, true);
});

test("truncated is false at exactly cap-minus-one — the flag only trips at the cap itself, never before", () => {
  const rows: GhlOutboundHealthRow[] = [];
  for (let i = 0; i < GHL_HEALTH_OUTBOUND_BACKLOG_CAP - 1; i++) rows.push(outboundRow({ createdAt: isoMinutesAgo(i) }));
  const snapshot = buildGhlHealthSnapshot([loc()], rows, [], NOW);
  assert.equal(snapshot.truncated, false);
});

// ---------------------------------------------------------------------------
// Final cross-phase review, finding 7 — safeGetGhlHealthSnapshot. The page
// (`/owner/setup-links`) used to await `repo.getGhlHealthSnapshot()`
// unguarded inside its own `Promise.all`, so a single transient failure
// 500'd the ENTIRE page. This wrapper is what the page now calls instead.
// ---------------------------------------------------------------------------

test("safeGetGhlHealthSnapshot: a successful fetch passes the snapshot straight through", async () => {
  const snapshot: GhlHealthSnapshot = { outbound: [], inbound: [], recentProblems: [], truncated: false };
  const result = await safeGetGhlHealthSnapshot(async () => snapshot);
  assert.equal(result, snapshot);
});

test("safeGetGhlHealthSnapshot: a throwing fetch resolves to null instead of rejecting — this is the whole fix for finding 7", async () => {
  await assert.doesNotReject(async () => {
    const result = await safeGetGhlHealthSnapshot(async () => {
      throw new Error("simulated transient Supabase error");
    });
    assert.equal(result, null);
  });
});
