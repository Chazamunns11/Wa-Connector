/**
 * T1 review follow-ups on SupabaseGhlRepository: profile emails are normalised
 * (trim + lowercase) on write and looked up with eq on the lower-cased value;
 * getLocationStats probes `everReceived` only for ids not already seen in the
 * recent-rows pass, in chunks of 10. Offline: supabase-js is replaced by a
 * recording fake.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test.supabase.example";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key-not-used-anywhere-real";

import test, { mock } from "node:test";
import assert from "node:assert/strict";

interface Call {
  table: string;
  op: string;
  args: unknown[];
}
const calls: Call[] = [];
let recentRows: { location_id: string; send_state: string; refusal_reason: string | null; reported_status: string | null }[] = [];
let probeInFlight = 0;
let probeMax = 0;
const probed: string[] = [];

function builder(table: string) {
  const state: { locId?: string; limited?: boolean } = {};
  const b: Record<string, unknown> = {};
  const rec = (op: string) => (...args: unknown[]) => {
    calls.push({ table, op, args });
    if (op === "eq" && args[0] === "location_id") state.locId = String(args[1]);
    if (op === "limit") state.limited = true;
    return b;
  };
  for (const op of ["select", "insert", "ilike", "eq", "in", "gte", "order", "range", "limit"]) b[op] = rec(op);
  b.maybeSingle = async () => ({ data: null, error: null });
  b.then = (resolve: (v: unknown) => void) => {
    if (state.limited && state.locId) {
      probed.push(state.locId);
      probeInFlight += 1;
      probeMax = Math.max(probeMax, probeInFlight);
      return Promise.resolve().then(() => new Promise((r) => setTimeout(r, 5))).then(() => {
        probeInFlight -= 1;
        resolve({ data: [], error: null });
      });
    }
    if (table === "ghl_outbound_messages") return resolve({ data: recentRows, error: null });
    return resolve({ data: null, error: null });
  };
  return b;
}

mock.module("@supabase/supabase-js", {
  namedExports: { createClient: () => ({ from: (t: string) => builder(t) }) },
});

async function repo() {
  const { SupabaseGhlRepository } = await import("@/lib/data/supabase");
  return new SupabaseGhlRepository();
}

test("createProfile stores a trimmed, lower-cased email", async () => {
  calls.length = 0;
  await (await repo()).createProfile({ id: "u1", role: "account", email: "  Jo@Example.COM ", accountId: "a1" });
  const insert = calls.find((c) => c.op === "insert");
  assert.deepEqual(insert?.args[0], { id: "u1", role: "account", email: "jo@example.com", account_id: "a1" });
});

test("getProfileByEmail matches with eq on the lower-cased value, not ilike", async () => {
  calls.length = 0;
  await (await repo()).getProfileByEmail("  Jo@Example.COM ");
  assert.ok(!calls.some((c) => c.op === "ilike"));
  const eq = calls.find((c) => c.table === "profiles" && c.op === "eq");
  assert.deepEqual(eq?.args, ["email", "jo@example.com"]);
});

test("getLocationStats: skips the probe for ids seen in the recent pass; probes the rest at most 10 at a time", async () => {
  calls.length = 0;
  probed.length = 0;
  probeMax = 0;
  const ids = Array.from({ length: 30 }, (_, i) => `loc-${i}`);
  recentRows = [
    { location_id: "loc-0", send_state: "sent", refusal_reason: null, reported_status: null },
    { location_id: "loc-1", send_state: "pending_send", refusal_reason: null, reported_status: null },
  ];
  const stats = await (await repo()).getLocationStats(ids, "2026-10-09T00:00:00.000Z");
  assert.equal(stats["loc-0"].everReceived, true);
  assert.equal(stats["loc-1"].everReceived, true);
  assert.equal(stats["loc-1"].pendingSend, 1);
  assert.equal(stats["loc-2"].everReceived, false);
  assert.deepEqual(probed.sort(), ids.slice(2).sort());
  assert.ok(probeMax <= 10, `max concurrent probes ${probeMax}`);
});
