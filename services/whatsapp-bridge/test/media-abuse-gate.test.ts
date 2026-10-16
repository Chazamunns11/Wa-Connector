/**
 * src/media-abuse-gate.ts — the per-sender/per-tenant daily download caps
 * (docs/MEDIA-PLAN.md §9). Fake `countSenderToday`/`countTenantToday` and an
 * injected clock — no Supabase, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaAbuseGate } from "../src/media-abuse-gate.js";

const TENANT = "tenant-1";

function makeDeps(seedSender = 0, seedTenant = 0) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      async countSenderToday() {
        calls.push("countSenderToday");
        return seedSender;
      },
      async countTenantToday() {
        calls.push("countTenantToday");
        return seedTenant;
      },
    },
  };
}

test("checkAndReserve: seeds from the DB once, then increments in memory (no repeat DB reads within the same day)", async () => {
  const { deps, calls } = makeDeps(0, 0);
  const gate = new MediaAbuseGate(20, 300, deps);
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900001"), true);
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900001"), true);
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900001"), true);
  // Seeded once per (key, day) — three checks for the SAME sender/tenant cost exactly one DB read each.
  assert.equal(calls.filter((c) => c === "countSenderToday").length, 1);
  assert.equal(calls.filter((c) => c === "countTenantToday").length, 1);
});

test("checkAndReserve: trips the per-sender cap at exactly the configured bound", async () => {
  const { deps } = makeDeps(0, 0);
  const gate = new MediaAbuseGate(3, 300, deps);
  const sender = "+447700900001";
  assert.equal(await gate.checkAndReserve(TENANT, sender), true); // 1
  assert.equal(await gate.checkAndReserve(TENANT, sender), true); // 2
  assert.equal(await gate.checkAndReserve(TENANT, sender), true); // 3 — at cap now
  assert.equal(await gate.checkAndReserve(TENANT, sender), false); // 4th refused
});

test("checkAndReserve: trips the per-tenant cap even when each individual sender is well under their own cap", async () => {
  const { deps } = makeDeps(0, 0);
  const gate = new MediaAbuseGate(20, 2, deps); // tenant cap is the binding one here
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900001"), true); // tenant 1
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900002"), true); // tenant 2 — at cap
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900003"), false); // tenant cap trips even for a brand-new sender
});

test("checkAndReserve: a rejected attempt does NOT consume budget from either counter", async () => {
  const { deps } = makeDeps(0, 0);
  const gate = new MediaAbuseGate(1, 300, deps);
  const sender = "+447700900001";
  assert.equal(await gate.checkAndReserve(TENANT, sender), true); // uses the sender's one slot
  assert.equal(await gate.checkAndReserve(TENANT, sender), false); // refused
  assert.equal(await gate.checkAndReserve(TENANT, sender), false); // still refused, not further incremented into negative territory or similar
  // A different sender under the same tenant is unaffected by the first sender's refusal.
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900002"), true);
});

test("checkAndReserve: seeded DB counts already AT the cap refuse immediately, with zero local increments needed", async () => {
  const { deps } = makeDeps(20, 0); // sender already has 20 today per the DB
  const gate = new MediaAbuseGate(20, 300, deps);
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900001"), false);
});

test("checkAndReserve: different senders under the SAME tenant are counted independently for the per-sender cap", async () => {
  const { deps } = makeDeps(0, 0);
  const gate = new MediaAbuseGate(1, 300, deps);
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900001"), true);
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900001"), false); // this sender is now at cap
  assert.equal(await gate.checkAndReserve(TENANT, "+447700900002"), true); // a different sender is fine
});

test("checkAndReserve: different tenants are scoped independently for both caps", async () => {
  const { deps } = makeDeps(0, 0);
  const gate = new MediaAbuseGate(1, 1, deps);
  assert.equal(await gate.checkAndReserve("tenant-a", "+447700900001"), true);
  assert.equal(await gate.checkAndReserve("tenant-a", "+447700900001"), false);
  assert.equal(await gate.checkAndReserve("tenant-b", "+447700900001"), true, "tenant-b's cap is untouched by tenant-a's usage");
});

test("checkAndReserve: UTC-day rollover re-seeds from the DB and resets the effective budget", async () => {
  let day = "2026-08-01T12:00:00.000Z";
  let dbCountSender = 0;
  const calls: string[] = [];
  const deps = {
    async countSenderToday() {
      calls.push("countSenderToday");
      return dbCountSender;
    },
    async countTenantToday() {
      return 0;
    },
  };
  const gate = new MediaAbuseGate(1, 300, deps, () => Date.parse(day));
  const sender = "+447700900001";

  assert.equal(await gate.checkAndReserve(TENANT, sender), true); // uses the only slot for day 1
  assert.equal(await gate.checkAndReserve(TENANT, sender), false); // refused, still day 1

  // Roll to the next UTC day — the DB is queried again (a fresh cap window).
  day = "2026-08-02T00:00:01.000Z";
  dbCountSender = 0; // the real DB would also read 0 for the new day.
  assert.equal(await gate.checkAndReserve(TENANT, sender), true, "a new UTC day re-seeds and allows again");
  assert.equal(calls.filter((c) => c === "countSenderToday").length, 2, "the rollover forced exactly one more DB read");
});
