/**
 * Public status page aggregation (`src/lib/public-status.ts`) — offline, no
 * Supabase, no fetch.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildPublicStatus, ghlSyncState, whatsappState } from "@/lib/public-status";
import type { GhlHealthSnapshot, GhlOutboundLocationHealth } from "@/lib/types";

function loc(overrides: Partial<GhlOutboundLocationHealth> = {}): GhlOutboundLocationHealth {
  return { locationId: "loc_secret_1", label: "Acme Fitness", pendingUnderOneHour: 0, pendingOverOneHour: 0, erroredCount: 0, latestReportError: null, ...overrides };
}

function snapshot(outbound: GhlOutboundLocationHealth[]): GhlHealthSnapshot {
  return { outbound, inbound: [], recentProblems: [], truncated: false };
}

test("whatsappState: healthy, unreachable, unconfigured", () => {
  assert.equal(whatsappState({ ok: true }), "operational");
  assert.equal(whatsappState({ ok: false }), "down");
  assert.equal(whatsappState(null), "unknown");
});

test("ghlSyncState: recent pending rows are normal, not a problem", () => {
  assert.equal(ghlSyncState(snapshot([loc({ pendingUnderOneHour: 12 })])), "operational");
});

test("ghlSyncState: a row stuck over an hour, or an errored report, is degraded", () => {
  assert.equal(ghlSyncState(snapshot([loc(), loc({ pendingOverOneHour: 1 })])), "degraded");
  assert.equal(ghlSyncState(snapshot([loc({ erroredCount: 1 })])), "degraded");
});

test("ghlSyncState: a failed health read is unknown", () => {
  assert.equal(ghlSyncState(null), "unknown");
});

test("buildPublicStatus: overall is the worst service state", () => {
  assert.equal(buildPublicStatus({ ok: true }, snapshot([])).overall, "operational");
  assert.equal(buildPublicStatus({ ok: true }, null).overall, "unknown");
  assert.equal(buildPublicStatus({ ok: true }, snapshot([loc({ erroredCount: 2 })])).overall, "degraded");
  assert.equal(buildPublicStatus({ ok: false }, snapshot([loc({ erroredCount: 2 })])).overall, "down");
});

test("buildPublicStatus: never leaks location names, ids, counts or error strings", () => {
  const status = buildPublicStatus(
    { ok: true },
    snapshot([loc({ pendingOverOneHour: 7, erroredCount: 3, latestReportError: "GHL rejected the status update (422)" })])
  );
  const text = JSON.stringify(status);
  for (const secret of ["loc_secret_1", "Acme Fitness", "422", "rejected", "7", "3"]) {
    assert.ok(!text.includes(secret), `public status must not contain ${secret}: ${text}`);
  }
});
