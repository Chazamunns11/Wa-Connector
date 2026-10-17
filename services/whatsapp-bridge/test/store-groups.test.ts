/**
 * Group ledger methods on BridgeStore (shape only): a fake Supabase builder
 * records the calls so nothing touches a real database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeStore } from "../src/store.js";
import type { BridgeConfig } from "../src/config.js";

interface Call { table: string; ops: [string, unknown[]][] }

function fakeStore(rowsByTable: Record<string, unknown[]>, calls: Call[] = []): BridgeStore {
  const supabase = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      const chain = (name: string) => (...args: unknown[]) => {
        call.ops.push([name, args]);
        return builder;
      };
      for (const m of ["select", "insert", "update", "eq", "in", "gte", "lt", "order"]) builder[m] = chain(m);
      builder.maybeSingle = async () => ({ data: (rowsByTable[table] ?? [])[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: rowsByTable[table] ?? [], error: null });
      return builder;
    },
  };
  const store = Object.create(BridgeStore.prototype) as BridgeStore;
  (store as unknown as { supabase: unknown }).supabase = supabase;
  return store;
}

test("BridgeStore exposes the group job and post methods", () => {
  const store = fakeStore({});
  for (const m of [
    "createGroupJob", "markGroupJobRunning", "finishGroupJob", "getGroupJob", "sweepInterruptedGroupJobs",
    "countGroupActivityToday", "acceptGroupPost", "getGroupPost", "claimGroupPost", "markGroupPostSent", "markGroupPostFailed",
  ]) assert.equal(typeof (store as unknown as Record<string, unknown>)[m], "function", m);
});

test("getDailyActivity counts group frames that reached the wire alongside 1:1 sends", async () => {
  const today = new Date().toISOString();
  const store = fakeStore({
    whatsapp_messages: [{ status: "sent", dispatch_attempted: false, sent_at: today, created_at: today }],
    whatsapp_group_posts: [
      { status: "sent", dispatch_attempted: true, sent_at: today, created_at: today },
      { status: "failed", dispatch_attempted: true, sent_at: null, created_at: today },
      { status: "failed", dispatch_attempted: false, sent_at: null, created_at: today },
      { status: "accepted", dispatch_attempted: false, sent_at: null, created_at: today },
    ],
  });
  const a = await store.getDailyActivity("c");
  assert.equal(a.attemptCount, 3);
});

test("countGroupActivityToday: adds sum requested_count, creates count rows", async () => {
  const store = fakeStore({
    whatsapp_group_jobs: [
      { kind: "add", requested_count: 10 },
      { kind: "add", requested_count: 5 },
      { kind: "create", requested_count: 3 },
      { kind: "create", requested_count: 2 },
    ],
  });
  assert.deepEqual(await store.countGroupActivityToday("c"), { addsToday: 15, createsToday: 2 });
});

test("createGroupJob maps the row and a create row is inserted already done with results", async () => {
  const calls: Call[] = [];
  const row = { id: "j1", coach_id: "c", group_jid: "1@g.us", kind: "create", status: "done", requested_count: 1, results: [{ phone: "+447700900101", code: "200", outcome: "added" }], created_at: "t", started_at: null, finished_at: "t" };
  const store = fakeStore({ whatsapp_group_jobs: [row] }, calls);
  const job = await store.createGroupJob("c", "1@g.us", 1, "create", { status: "done", results: [{ phone: "+447700900101", code: "200", outcome: "added" }] });
  assert.equal(job.id, "j1");
  assert.equal(job.status, "done");
  assert.equal(job.results[0]?.outcome, "added");
  const insert = calls[0]!.ops.find(([n]) => n === "insert")![1][0] as Record<string, unknown>;
  assert.equal(insert.kind, "create");
  assert.equal(insert.status, "done");
  assert.ok(insert.finished_at);
});

test("sweepInterruptedGroupJobs only touches this coach's running jobs", async () => {
  const calls: Call[] = [];
  const store = fakeStore({}, calls);
  await store.sweepInterruptedGroupJobs("c");
  const ops = calls[0]!.ops;
  assert.deepEqual(ops.find(([n]) => n === "update")![1][0], { status: "interrupted", finished_at: (ops.find(([n]) => n === "update")![1][0] as { finished_at: string }).finished_at });
  assert.ok(ops.some(([n, a]) => n === "eq" && a[0] === "coach_id" && a[1] === "c"));
  assert.ok(ops.some(([n, a]) => n === "in" && a[0] === "status" && (a[1] as string[]).includes("running")));
});

test("acceptGroupPost inserts and returns fresh", async () => {
  const row = { id: "p1", coach_id: "c", group_jid: "1@g.us", idempotency_key: "k", status: "accepted", wa_message_id: null, error: null, dispatch_attempted: false, created_at: "t", sent_at: null };
  const store = fakeStore({ whatsapp_group_posts: [row] });
  const r = await store.acceptGroupPost("c", "k", "1@g.us");
  assert.equal(r.fresh, true);
  assert.equal(r.record.groupJid, "1@g.us");
});

void ({} as BridgeConfig);
