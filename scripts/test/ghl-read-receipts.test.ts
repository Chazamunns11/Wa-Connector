/**
 * Read receipts to GHL (migration 0010) — offline: an in-memory repo and a
 * fake status PUT. Nothing here touches GHL or the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APP_MESSAGE_ID_PREFIX, drainGhlReadReceipts, type GhlProviderDeps, type GhlReadReceiptsRepo } from "@/lib/ghl-provider";
import { SupabaseGhlRepository } from "@/lib/data/supabase";
import type { GhlAccount, GhlOutboundMessage } from "@/lib/types";

const TENANT = "11111111-1111-4111-8111-111111111111";

function account(): GhlAccount {
  return {
    locationId: "loc-1", tenantId: TENANT, label: "T", companyId: null, conversationProviderId: null,
    accessToken: "tok", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "r",
    status: "active", lastError: null, createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    accountId: "acc", activatedAt: "2026-10-01T00:00:00Z",
  };
}

function row(n: number, over: Partial<GhlOutboundMessage> = {}): GhlOutboundMessage {
  return {
    id: `row-${n}`, locationId: "loc-1", tenantId: TENANT, ghlMessageId: `m${n}`, ghlContactId: "c",
    idempotencyKey: `key-${n}`, toPhone: "+447700900123", hadAttachments: false, sendState: "accepted", sendAttempts: 0,
    pendingText: null, refusalReason: null, reportedStatus: "delivered", reportedAt: "2026-10-16T10:00:00Z", reportError: null,
    readReportedAt: null, readReportError: null, createdAt: new Date().toISOString(), ...over,
  };
}

function setup(rows: GhlOutboundMessage[], readKeys: string[], putResult: { ok: true } | { ok: false; error: string; status?: number } = { ok: true }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const puts: { messageId: string; status: string }[] = [];
  const listed: { limit: number; sinceIso: string }[] = [];
  const repo: GhlReadReceiptsRepo = {
    async getGhlAccountByLocationId() { return account(); },
    async claimGhlTokenRefresh() { return true; },
    async saveGhlTokens() {},
    async markGhlNeedsReauth() {},
    async listGhlOutboundAwaitingRead(limit, sinceIso) {
      listed.push({ limit, sinceIso });
      // Mirrors the SQL function: delivered, unreported, in window, AND read.
      return [...byId.values()]
        .filter((r) => r.reportedStatus === "delivered" && r.readReportedAt === null && r.createdAt >= sinceIso && readKeys.includes(r.idempotencyKey))
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
        .slice(0, limit)
        .map((message) => ({ message, readAt: "2026-10-17T09:00:00Z" }));
    },
    async markGhlOutboundReadReported(id, result) {
      const r = byId.get(id)!;
      r.readReportedAt = new Date().toISOString();
      r.readReportError = result.readReportError;
    },
  };
  const deps = {
    updateStatus: async (_t: string, messageId: string, status: string) => {
      puts.push({ messageId, status });
      return putResult;
    },
    refreshToken: async () => { throw new Error("unexpected refresh"); },
    refreshWaitMs: 0,
    notify: () => {},
  } as unknown as GhlProviderDeps;
  return { repo, deps, byId, puts, listed };
}

test("read row: PUT read once and marked", async () => {
  const s = setup([row(1)], ["key-1"]);
  const r = await drainGhlReadReceipts(s.repo, s.deps);
  assert.deepEqual(s.puts, [{ messageId: "m1", status: "read" }]);
  assert.deepEqual(r, { examined: 1, reported: 1, failed: 0 });
  assert.notEqual(s.byId.get("row-1")!.readReportedAt, null);
  assert.equal(s.byId.get("row-1")!.readReportError, null);
  await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.puts.length, 1, "a reported row is never listed again");
});

test("no read_at: no PUT and not marked", async () => {
  const s = setup([row(1)], []);
  const r = await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.puts.length, 0);
  assert.equal(s.byId.get("row-1")!.readReportedAt, null);
  assert.equal(r.reported, 0);
});

test("starvation: 60 unread rows ahead of one read row, the read row is reported", async () => {
  const base = Date.now() - 3_600_000;
  const unread = Array.from({ length: 60 }, (_, i) => row(i + 1, { createdAt: new Date(base + i * 1000).toISOString() }));
  const readRow = row(100, { createdAt: new Date(base + 100_000).toISOString() });
  const s = setup([...unread, readRow], ["key-100"]);
  const r = await drainGhlReadReceipts(s.repo, s.deps);
  assert.deepEqual(s.puts, [{ messageId: "m100", status: "read" }]);
  assert.equal(r.reported, 1);
});

test("401 on read is not final: left for the next pass", async () => {
  const s = setup([row(1)], ["key-1"], { ok: false, error: "GHL status update rejected (HTTP 401)", status: 401 });
  const r = await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.byId.get("row-1")!.readReportedAt, null);
  assert.equal(s.byId.get("row-1")!.readReportError, null);
  assert.equal(r.failed, 1);
  await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.puts.length, 2);
});

test("app-originated row: marked locally, no PUT", async () => {
  const id = `${APP_MESSAGE_ID_PREFIX}${"a".repeat(32)}`;
  const s = setup([row(1, { ghlMessageId: id })], ["key-1"]);
  await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.puts.length, 0);
  assert.notEqual(s.byId.get("row-1")!.readReportedAt, null);
  assert.equal(s.byId.get("row-1")!.readReportError, null);
});

test("4xx on read is final", async () => {
  const s = setup([row(1)], ["key-1"], { ok: false, error: "GHL status update rejected (HTTP 422)", status: 422 });
  const r = await drainGhlReadReceipts(s.repo, s.deps);
  const stored = s.byId.get("row-1")!;
  assert.equal(stored.readReportError, "GHL refused read status");
  assert.notEqual(stored.readReportedAt, null);
  assert.equal(stored.reportedStatus, "delivered");
  assert.equal(stored.reportedAt, "2026-10-16T10:00:00Z");
  assert.equal(r.failed, 1);
  await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.puts.length, 1, "not retried");
});

test("5xx is retried next pass", async () => {
  const s = setup([row(1)], ["key-1"], { ok: false, error: "GHL status update rejected (HTTP 503)", status: 503 });
  const r = await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.byId.get("row-1")!.readReportedAt, null);
  assert.equal(r.failed, 1);
  await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.puts.length, 2);
});

test("network error (no status) is retried next pass", async () => {
  const s = setup([row(1)], ["key-1"], { ok: false, error: "GHL status update request failed" });
  await drainGhlReadReceipts(s.repo, s.deps);
  assert.equal(s.byId.get("row-1")!.readReportedAt, null);
});

test("rows older than 7 days aren't listed", async () => {
  const old = row(1, { createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  const s = setup([old, row(2)], ["key-1", "key-2"]);
  await drainGhlReadReceipts(s.repo, s.deps);
  assert.deepEqual(s.puts.map((p) => p.messageId), ["m2"]);
  const window = Date.now() - Date.parse(s.listed[0].sinceIso);
  assert.ok(Math.abs(window - 7 * 86_400_000) < 5_000);
  assert.equal(s.listed[0].limit, 50);
  // The real query encodes the same filters.
  const src = readFileSync(new URL("../../src/lib/data/supabase.ts", import.meta.url), "utf8");
  const start = src.indexOf("async listGhlOutboundAwaitingRead(");
  assert.match(src.slice(start, start + 600), /rpc\("ghl_outbound_awaiting_read"/);
  const sql = readFileSync(new URL("../../supabase/migrations/0010_missed_calls_and_receipts.sql", import.meta.url), "utf8");
  assert.match(sql, /g\.reported_status = 'delivered'/);
  assert.match(sql, /g\.read_reported_at is null/);
  assert.match(sql, /g\.created_at >= p_since/);
  assert.match(sql, /w\.read_at is not null/);
  assert.match(sql, /order by g\.created_at/);
  assert.match(sql, /grant execute on function public\.ghl_outbound_awaiting_read\(timestamptz, int\) to service_role/);
});

test("the drain never writes reported_status (repo has no such write)", () => {
  assert.equal(typeof SupabaseGhlRepository.prototype.markGhlOutboundReadReported, "function");
  const src = readFileSync(new URL("../../src/lib/data/supabase.ts", import.meta.url), "utf8");
  const start = src.indexOf("async markGhlOutboundReadReported(");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  assert.doesNotMatch(body, /\breported_status\b|\breported_at\b/);
});

test("flag off: the cron route doesn't call the drain", () => {
  const src = readFileSync(new URL("../../src/app/api/cron/drain/route.ts", import.meta.url), "utf8");
  assert.match(src, /if \(process\.env\.GHL_READ_RECEIPTS_ENABLED === "true"\) \{\s*try \{\s*ghlReadReceipts = await drainGhlReadReceipts\(repo\)/);
  assert.equal(src.match(/drainGhlReadReceipts\(repo\)/g)?.length, 1);
});
