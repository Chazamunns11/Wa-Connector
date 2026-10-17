/** Disconnected / reconnected triggers — offline, fake repo. */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { drainSessionTriggers, type SessionTriggerDeps, type SessionTriggerRepo } from "@/lib/session-triggers";
import type { TriggerSessionRow } from "@/lib/types";
import type { GhlAccount } from "@/lib/types";

let restore: (() => void) | null = null;
beforeEach(() => {
  const original = console.error;
  console.error = () => {};
  process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = "true"; // startTrigger reads the real flag
  restore = () => {
    console.error = original;
    delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
  };
});
afterEach(() => restore?.());

const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const URL_ = "https://services.leadconnectorhq.com/workflows-trigger/x";

function row(over: Partial<TriggerSessionRow> = {}): TriggerSessionRow {
  return {
    tenantId: "t-1",
    locationId: "loc-1",
    slot: 1,
    label: "Main",
    phone: "+447700900000",
    status: "disconnected",
    downSince: null,
    lastFired: null,
    lastConnectedAt: iso(NOW - 60 * MIN),
    ...over,
  };
}

function setup(rows: TriggerSessionRow[], opts: { enabled?: boolean; held?: number } = {}) {
  const state = new Map(rows.map((r) => [r.tenantId, { ...r }]));
  const log: string[] = [];
  const reads: string[][] = [];
  const posts: { key: string; payload: Record<string, unknown> }[] = [];
  const repo = {
    async listLocationsWithTriggerKeys(keys: string[]) {
      reads.push(keys);
      return ["loc-1"];
    },
    async listSessionsForTriggers(ids: string[]) {
      log.push(`list:${ids.join(",")}`);
      return [...state.values()].map((r) => ({ ...r }));
    },
    async setSessionTriggerState(tenantId: string, s: { downSince: string | null; lastFired: "down" | "up" | null }) {
      log.push(`set:${s.lastFired}`);
      Object.assign(state.get(tenantId)!, s);
    },
    async countHeldByTenant() {
      return new Map([["t-1", opts.held ?? 0]]);
    },
    async listTriggerSubscriptions() {
      return [{ id: "s", targetUrl: URL_ }];
    },
    async getGhlAccountByLocationId() {
      return { locationId: "loc-1", tenantId: "t-1", accessToken: "tok", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "r", connectLinkVersion: 3 } as unknown as GhlAccount;
    },
    async claimGhlTokenRefresh() {
      return true;
    },
    async saveGhlTokens() {},
    async markGhlNeedsReauth() {},
  } as unknown as SessionTriggerRepo;
  const urls: number[] = [];
  const deps = {
    refreshToken: async () => ({ ok: false, kind: "transient" }),
    refreshWaitMs: 0,
    notify: () => {},
    enabled: () => opts.enabled ?? true,
    postTriggerEvent: async (_u: string, _t: string, payload: object) => {
      log.push("post");
      posts.push({ key: "", payload: payload as Record<string, unknown> });
      return { ok: true, status: 200 };
    },
    reconnectUrl: (_l: string, _v: number | null, slot: number) => {
      urls.push(slot);
      return `https://app.example/connect/tok-slot-${slot}`;
    },
  } as unknown as SessionTriggerDeps;
  return { repo, deps, state, log, posts, reads, urls };
}

test("blip under 5 minutes fires nothing", async () => {
  const s = setup([row()]);
  await drainSessionTriggers(s.repo, s.deps, NOW); // first sees it down
  assert.equal(s.state.get("t-1")!.downSince, iso(NOW));
  await drainSessionTriggers(s.repo, s.deps, NOW + 2 * MIN);
  s.state.get("t-1")!.status = "connected";
  const r = await drainSessionTriggers(s.repo, s.deps, NOW + 3 * MIN);
  assert.equal(r.fired, 0);
  assert.equal(s.posts.length, 0);
  assert.equal(s.state.get("t-1")!.downSince, null);
  assert.equal(s.state.get("t-1")!.lastFired, null);
});

test("down 5+ minutes fires disconnected once", async () => {
  const s = setup([row()], { held: 4 });
  await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.equal(s.posts.length, 0);
  const r = await drainSessionTriggers(s.repo, s.deps, NOW + 5 * MIN);
  assert.equal(r.fired, 1);
  assert.deepEqual(s.posts[0].payload, {
    number: "+447700900000",
    numberLabel: "Main",
    reason: "connection_lost",
    heldMessages: 4,
    reconnectUrl: "https://app.example/connect/tok-slot-1",
  });
  assert.equal(s.state.get("t-1")!.lastFired, "down");
  const again = await drainSessionTriggers(s.repo, s.deps, NOW + 20 * MIN);
  assert.equal(again.fired, 0);
  assert.equal(s.posts.length, 1);
});

test("the state is marked before the fire", async () => {
  const s = setup([row({ downSince: iso(NOW - 6 * MIN) })]);
  await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.ok(s.log.indexOf("set:down") < s.log.indexOf("post"));
});

test("banned fires at once with reason banned; logged_out with logged_out", async () => {
  const s = setup([row({ status: "banned" })]);
  const r = await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.equal(r.fired, 1);
  assert.equal(s.posts[0].payload.reason, "banned");
  const t = setup([row({ status: "logged_out" })]);
  await drainSessionTriggers(t.repo, t.deps, NOW);
  assert.equal(t.posts[0].payload.reason, "logged_out");
});

test("recovery fires reconnected once with downMinutes", async () => {
  const s = setup([row({ status: "connected", downSince: iso(NOW - 12 * MIN), lastFired: "down" })]);
  const r = await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.equal(r.fired, 1);
  assert.deepEqual(s.posts[0].payload, { number: "+447700900000", numberLabel: "Main", downMinutes: 12 });
  assert.equal(s.state.get("t-1")!.downSince, null);
  assert.equal(s.state.get("t-1")!.lastFired, "up");
  assert.ok(s.log.indexOf("set:up") < s.log.indexOf("post"));
  await drainSessionTriggers(s.repo, s.deps, NOW + MIN);
  assert.equal(s.posts.length, 1);
});

test("reconnectUrl uses the session's slot", async () => {
  const s = setup([row({ slot: 2, status: "banned" })]);
  await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.deepEqual(s.urls, [2]);
  assert.equal(s.posts[0].payload.reconnectUrl, "https://app.example/connect/tok-slot-2");
});

test("only locations with subscriptions are read", async () => {
  const s = setup([row()]);
  await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.deepEqual(s.reads, [["whatsapp_disconnected", "whatsapp_reconnected"]]);
  assert.ok(s.log.includes("list:loc-1"));
});

test("flag off: the drain isn't run", async () => {
  const s = setup([row({ status: "banned" })], { enabled: false });
  const r = await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.equal(r.fired, 0);
  assert.equal(s.reads.length, 0);
  assert.equal(s.log.length, 0);
  assert.equal(s.posts.length, 0);
});

test("a number that never connected fires nothing", async () => {
  const s = setup([row({ status: "waiting_qr", lastConnectedAt: null })]);
  await drainSessionTriggers(s.repo, s.deps, NOW + 30 * MIN);
  assert.equal(s.posts.length, 0);
  assert.equal(s.state.get("t-1")!.downSince, null);
});

test("a hanging trigger endpoint never holds the drain past the cap", async () => {
  const s = setup([row({ status: "banned" })]);
  (s.deps as { postTriggerEvent: unknown }).postTriggerEvent = () => new Promise(() => {});
  const started = Date.now();
  await drainSessionTriggers(s.repo, s.deps, NOW);
  assert.ok(Date.now() - started < 10_000);
});
