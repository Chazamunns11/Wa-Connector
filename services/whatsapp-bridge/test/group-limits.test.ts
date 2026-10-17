/**
 * src/group-limits.ts — per-number daily limits on group creates and direct
 * adds. Fake store and an injected clock — no Supabase, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GroupActionLimits } from "../src/group-limits.js";
import type { GroupActionKind } from "../src/store.js";

const TENANT = "tenant-1";
const GROUP = "120363000000000001@g.us";
const LIMITS = { createDaily: 3, addDaily: 50 };
const T0 = Date.parse("2026-10-17T10:00:00.000Z");

function fakeStore(seed = { creates: 0, adds: 0 }) {
  const rows: { tenantId: string; action: GroupActionKind; count: number; groupJid: string | null }[] = [];
  const state = { seed, seedCalls: 0, failWrites: false, failSeed: false };
  return {
    rows,
    state,
    store: {
      async countGroupActionsToday(_tenantId: string) {
        state.seedCalls++;
        if (state.failSeed) throw new Error("seed down");
        return { ...state.seed };
      },
      async recordGroupAction(tenantId: string, action: GroupActionKind, count: number, groupJid: string | null) {
        if (state.failWrites) throw new Error("write down");
        rows.push({ tenantId, action, count, groupJid });
      },
    },
  };
}

test("limits: the 4th create of the day is refused", async () => {
  const { store, rows } = fakeStore();
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  assert.equal(await limits.reserveCreate(TENANT), "ok");
  assert.equal(await limits.reserveCreate(TENANT), "ok");
  assert.equal(await limits.reserveCreate(TENANT), "ok");
  assert.equal(await limits.reserveCreate(TENANT), "limit");
  assert.deepEqual(
    rows.map((r) => [r.action, r.count, r.groupJid]),
    [
      ["create", 1, null],
      ["create", 1, null],
      ["create", 1, null],
    ]
  );
});

test("limits: adds are granted up to 50 then partially", async () => {
  const { store, rows } = fakeStore();
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  assert.deepEqual(await limits.reserveAdds(TENANT, 48, GROUP), { granted: 48 });
  assert.deepEqual(await limits.reserveAdds(TENANT, 5, GROUP), { granted: 2 });
  assert.deepEqual(await limits.reserveAdds(TENANT, 5, GROUP), { granted: 0 });
  // Nothing granted -> nothing written (a 0-count row would break the DB check anyway).
  assert.deepEqual(
    rows.map((r) => [r.action, r.count, r.groupJid]),
    [
      ["add", 48, GROUP],
      ["add", 2, GROUP],
    ]
  );
});

test("limits: survive a restart", async () => {
  const { store, rows } = fakeStore({ creates: 3, adds: 50 });
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  assert.equal(await limits.reserveCreate(TENANT), "limit");
  assert.deepEqual(await limits.reserveAdds(TENANT, 1, GROUP), { granted: 0 });
  assert.equal(rows.length, 0);
});

test("limits: seeds once per day, not on every call", async () => {
  const { store, state } = fakeStore();
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  await limits.reserveCreate(TENANT);
  await limits.reserveAdds(TENANT, 3, GROUP);
  await limits.reserveCreate(TENANT);
  assert.equal(state.seedCalls, 1);
});

test("limits: roll at UTC midnight", async () => {
  const { store, state } = fakeStore();
  let now = Date.parse("2026-10-17T23:59:00.000Z");
  const limits = new GroupActionLimits(store, LIMITS, () => now);
  for (let i = 0; i < 3; i++) assert.equal(await limits.reserveCreate(TENANT), "ok");
  assert.equal(await limits.reserveCreate(TENANT), "limit");
  assert.equal(state.seedCalls, 1);
  now = Date.parse("2026-10-18T00:00:30.000Z");
  state.seed = { creates: 0, adds: 0 };
  assert.equal(await limits.reserveCreate(TENANT), "ok");
  assert.equal(state.seedCalls, 2, "a new UTC day reseeds from the store");
});

test("limits: a failed record write refuses rather than grants", async () => {
  const { store, state } = fakeStore();
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  state.failWrites = true;
  assert.equal(await limits.reserveCreate(TENANT), "unavailable");
  assert.deepEqual(await limits.reserveAdds(TENANT, 5, GROUP), { unavailable: true });
  // Once the store is back, the next call reseeds from it (the truth) rather than trusting memory.
  state.failWrites = false;
  const seedsBefore = state.seedCalls;
  assert.equal(await limits.reserveCreate(TENANT), "ok");
  assert.equal(state.seedCalls, seedsBefore + 1);
});

test("limits: a failed seed refuses rather than grants", async () => {
  const { store, state, rows } = fakeStore();
  state.failSeed = true;
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  assert.equal(await limits.reserveCreate(TENANT), "unavailable");
  assert.deepEqual(await limits.reserveAdds(TENANT, 5, GROUP), { unavailable: true });
  assert.equal(rows.length, 0);
});

test("limits: concurrent reserves never overshoot", async () => {
  const { store } = fakeStore();
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  const creates = await Promise.all([1, 2, 3, 4, 5].map(() => limits.reserveCreate(TENANT)));
  assert.equal(creates.filter((r) => r === "ok").length, 3);
  const adds = await Promise.all([30, 30, 30].map((n) => limits.reserveAdds(TENANT, n, GROUP)));
  const granted = adds.reduce((sum, r) => sum + ("granted" in r ? r.granted : 0), 0);
  assert.equal(granted, 50);
});

test("limits: tenants are counted separately", async () => {
  const { store } = fakeStore();
  const limits = new GroupActionLimits(store, LIMITS, () => T0);
  for (let i = 0; i < 3; i++) await limits.reserveCreate(TENANT);
  assert.equal(await limits.reserveCreate(TENANT), "limit");
  assert.equal(await limits.reserveCreate("tenant-2"), "ok");
});
