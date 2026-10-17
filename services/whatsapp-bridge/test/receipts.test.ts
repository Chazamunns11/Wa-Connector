import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { WAMessageUpdate } from "@whiskeysockets/baileys";
import { ReceiptApplier, receiptFromUpdate, type ReceiptLevel, type ReceiptResult, type ReceiptStore } from "../src/receipts.js";
import { BridgeStore } from "../src/store.js";

const PN = "447700900123@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

function upd(status: number | undefined, over: { fromMe?: boolean; remoteJid?: string; id?: string } = {}): WAMessageUpdate {
  return {
    key: { remoteJid: over.remoteJid ?? PN, fromMe: over.fromMe ?? true, id: over.id ?? "WAID1" },
    update: status === undefined ? {} : { status },
  } as WAMessageUpdate;
}

test("receiptFromUpdate: status mapping and rejects", () => {
  assert.deepEqual(receiptFromUpdate(upd(3)), { waMessageId: "WAID1", level: "delivered" });
  assert.equal(receiptFromUpdate(upd(4))?.level, "read");
  assert.equal(receiptFromUpdate(upd(5))?.level, "read");
  assert.equal(receiptFromUpdate(upd(3, { fromMe: false })), null);
  assert.equal(receiptFromUpdate(upd(undefined)), null);
  assert.equal(receiptFromUpdate(upd(2)), null);
  assert.equal(receiptFromUpdate(upd(3, { remoteJid: GROUP })), null);
});

/** Fake store with the real coalesce semantics: set once, read implies delivered. */
function fakeStore(rowExists = true) {
  const calls: Array<{ level: ReceiptLevel; atIso: string; waMessageId: string }> = [];
  const row = { delivered_at: null as string | null, read_at: null as string | null, exists: rowExists };
  const store: ReceiptStore = {
    async markMessageReceipt(_c, waMessageId, level, atIso): Promise<ReceiptResult> {
      calls.push({ level, atIso, waMessageId });
      if (!row.exists) return "no_row";
      row.delivered_at ??= atIso;
      if (level === "read") row.read_at ??= atIso;
      return "applied";
    },
  };
  return { store, calls, row };
}

function clock(start = 1_000_000) {
  const c = { t: start };
  return { c, now: () => c.t };
}

test("read before delivered sets both", async () => {
  const { store, calls, row } = fakeStore();
  const { c, now } = clock();
  const a = new ReceiptApplier(store, now);
  await a.handle("c1", [upd(4)]);
  assert.deepEqual(calls.map((x) => x.level), ["read"]);
  assert.ok(row.delivered_at && row.read_at);
  assert.equal(row.delivered_at, row.read_at);
  c.t += 5_000;
  await a.handle("c1", [upd(3)]);
  assert.equal(row.read_at, row.delivered_at, "later delivered changes nothing");
});

test("delivered after read changes nothing", async () => {
  const { store, row } = fakeStore();
  const { c, now } = clock();
  const a = new ReceiptApplier(store, now);
  await a.handle("c1", [upd(3)]);
  const first = row.delivered_at;
  c.t += 5_000;
  await a.handle("c1", [upd(4)]);
  const readAt = row.read_at;
  c.t += 5_000;
  await a.handle("c1", [upd(3)]);
  assert.equal(row.delivered_at, first);
  assert.equal(row.read_at, readAt);
  assert.ok(readAt && readAt > first!);
});

test("group update -> ignored", async () => {
  const { store, calls } = fakeStore();
  const a = new ReceiptApplier(store);
  await a.handle("c1", [upd(3, { remoteJid: GROUP }), upd(4, { remoteJid: GROUP })]);
  assert.equal(calls.length, 0);
});

test("pending keeps the first delivered time when a read arrives later", async () => {
  const { store, calls, row } = fakeStore(false);
  const { c, now } = clock();
  const a = new ReceiptApplier(store, now);
  await a.handle("c1", [upd(3)]);
  c.t += 5_000;
  await a.handle("c1", [upd(4)]);
  c.t += 5_000;
  await a.handle("c1", [upd(3)]); // repeat must not move the time
  const deliveredAt = calls[0]!.atIso;
  const readAt = calls[1]!.atIso;
  assert.notEqual(deliveredAt, readAt);
  row.exists = true;
  const n = calls.length;
  await a.afterSent("c1", "WAID1");
  assert.deepEqual(calls.slice(n).map((x) => [x.level, x.atIso]), [["delivered", deliveredAt], ["read", readAt]]);
  assert.equal(row.delivered_at, deliveredAt);
  assert.equal(row.read_at, readAt);
});

test("pending TTL runs from the first sighting and later acks do not refresh it", async () => {
  const { store, calls, row } = fakeStore(false);
  const { c, now } = clock();
  const a = new ReceiptApplier(store, now);
  await a.handle("c1", [upd(3)]);
  c.t += 40_000;
  await a.handle("c1", [upd(4)]);
  c.t += 30_000; // 70s after first sighting, 30s after the last ack
  row.exists = true;
  const n = calls.length;
  await a.afterSent("c1", "WAID1");
  assert.equal(calls.length, n);
  assert.equal(row.delivered_at, null);
});

test("early receipt is applied after markMessageSent", async () => {
  const { store, calls, row } = fakeStore(false);
  const { c, now } = clock();
  const a = new ReceiptApplier(store, now);
  await a.handle("c1", [upd(3), upd(4)]);
  assert.equal(calls.length, 2);
  row.exists = true;
  c.t += 10_000;
  await a.afterSent("c1", "WAID1");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(2).map((x) => x.level), ["delivered", "read"]);
  assert.ok(row.read_at);
  await a.afterSent("c1", "WAID1");
  assert.equal(calls.length, 4, "applied once");
});

test("early receipt older than 60s is not applied", async () => {
  const { store, calls, row } = fakeStore(false);
  const { c, now } = clock();
  const a = new ReceiptApplier(store, now);
  await a.handle("c1", [upd(3)]);
  row.exists = true;
  c.t += 61_000;
  await a.afterSent("c1", "WAID1");
  assert.equal(calls.length, 1);
  assert.equal(row.delivered_at, null);
});

test("pending map is bounded at 1,000", async () => {
  const { store, calls, row } = fakeStore(false);
  const { now } = clock();
  const a = new ReceiptApplier(store, now);
  const updates = Array.from({ length: 1_005 }, (_, i) => upd(3, { id: `W${i}` }));
  await a.handle("c1", updates);
  row.exists = true;
  const before = calls.length;
  await a.afterSent("c1", "W0"); // oldest dropped
  assert.equal(calls.length, before);
  await a.afterSent("c1", "W1004");
  assert.equal(calls.length, before + 1);
  let applied = 0;
  for (let i = 5; i < 1_005; i++) {
    const n = calls.length;
    await a.afterSent("c1", `W${i}`);
    if (calls.length > n) applied++;
  }
  assert.equal(applied, 999, "1,000 retained, minus W1004 already applied");
});

test("a store error never throws out of handle or afterSent", async () => {
  const logged: unknown[] = [];
  const store: ReceiptStore = {
    async markMessageReceipt() {
      throw new TypeError("boom WAID1");
    },
  };
  const a = new ReceiptApplier(store, Date.now, { error: (...args: unknown[]) => void logged.push(args) } as never);
  await a.handle("c1", [upd(3), upd(4, { id: "WAID2" })]);
  await a.afterSent("c1", "WAID1");
  assert.equal(logged.length, 2);
  assert.ok(!JSON.stringify(logged).includes("WAID"), "no message ids logged");
});

// ---- BridgeStore.markMessageReceipt: shape of the guarded updates ----

function storeWith(supabase: unknown): BridgeStore {
  const store = new BridgeStore({
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    credsKey: Buffer.alloc(32),
    credsKeyPrevious: null,
  } as never);
  (store as unknown as { supabase: unknown }).supabase = supabase;
  return store;
}

function fakeSupabase(opts: { updateRows: Array<unknown[]>; existsRows: unknown[] }) {
  const log: Array<{ op: string; payload?: unknown; filters: Array<[string, ...unknown[]]> }> = [];
  let updateIdx = 0;
  const supabase = {
    from(table: string) {
      assert.equal(table, "whatsapp_messages");
      const entry: (typeof log)[number] = { op: "", filters: [] };
      log.push(entry);
      const q: Record<string, unknown> = {};
      q.update = (payload: unknown) => ((entry.op = "update"), (entry.payload = payload), q);
      q.select = (...a: unknown[]) => {
        if (entry.op === "") entry.op = "select";
        entry.filters.push(["select", ...a]);
        return q;
      };
      for (const f of ["eq", "is", "limit"]) q[f] = (...a: unknown[]) => (entry.filters.push([f, ...a]), q);
      q.then = (res: (v: unknown) => void) =>
        res({ data: entry.op === "update" ? opts.updateRows[updateIdx++] : opts.existsRows, error: null });
      return q;
    },
  };
  return { supabase, log };
}

test("store.markMessageReceipt: read issues two guarded updates", async () => {
  const { supabase, log } = fakeSupabase({ updateRows: [[{ id: "r" }], [{ id: "r" }]], existsRows: [] });
  const store = storeWith(supabase);
  const res = await store.markMessageReceipt("c1", "W1", "read", "2026-10-17T10:00:00.000Z");
  assert.equal(res, "applied");
  assert.equal(log.length, 2);
  assert.deepEqual(log[0]!.payload, { delivered_at: "2026-10-17T10:00:00.000Z" });
  assert.deepEqual(log[1]!.payload, { read_at: "2026-10-17T10:00:00.000Z" });
  for (const [i, col] of ["delivered_at", "read_at"].entries()) {
    const f = log[i]!.filters;
    assert.deepEqual(f.filter((x) => x[0] === "eq"), [["eq", "coach_id", "c1"], ["eq", "wa_message_id", "W1"], ["eq", "status", "sent"]]);
    assert.deepEqual(f.find((x) => x[0] === "is"), ["is", col, null]);
  }
});

test("store.markMessageReceipt: already set counts as applied, missing row is no_row", async () => {
  const set = fakeSupabase({ updateRows: [[]], existsRows: [{ id: "r" }] });
  assert.equal(await storeWith(set.supabase).markMessageReceipt("c1", "W1", "delivered", "t"), "applied");
  const none = fakeSupabase({ updateRows: [[]], existsRows: [] });
  assert.equal(await storeWith(none.supabase).markMessageReceipt("c1", "W1", "delivered", "t"), "no_row");
});

test("wiring: messages.update is behind readReceiptsEnabled and afterSent follows recordSent", () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/sessions.ts"), "utf8");
  const m = /if \(this\.config\.readReceiptsEnabled[^\n]*\{[\s\S]*?\n    \}\n/.exec(src);
  assert.ok(m, "readReceiptsEnabled block present");
  assert.match(m[0], /sock\.ev\.on\("messages\.update"/);
  assert.equal((src.match(/ev\.on\("messages\.update"/g) ?? []).length, 1);
  const sent = src.indexOf("await recordSent(this.store, this.outboundPoke, record.id");
  const after = src.indexOf("receipts.afterSent(", sent);
  assert.ok(sent > 0 && after > sent && after - sent < 400, "afterSent directly after recordSent");
});
