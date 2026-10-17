import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { SupabaseGhlRepository } from "@/lib/data/supabase";

// The repo talks to PostgREST through supabase-js, which uses global fetch.
// A scripted fetch lets us pin the exact requests without any live database.
type Seen = { method: string; url: URL; body: unknown; prefer: string | null };
let seen: Seen[] = [];
let respond: (req: Seen) => { status?: number; body: unknown } = () => ({ body: [] });
const realFetch = globalThis.fetch;
const savedEnv = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

beforeEach(() => {
  seen = [];
  respond = () => ({ body: [] });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const text = await req.text();
    const entry: Seen = {
      method: req.method,
      url: new URL(req.url),
      body: text ? JSON.parse(text) : null,
      prefer: req.headers.get("prefer"),
    };
    seen.push(entry);
    const r = respond(entry);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [
    ["NEXT_PUBLIC_SUPABASE_URL", savedEnv.url],
    ["SUPABASE_SERVICE_ROLE_KEY", savedEnv.key],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const TENANT = "11111111-1111-4111-8111-111111111111";

test("recordOptOut upserts on (tenant_id, phone) with a normalised E.164 phone and a fresh opted_out_at", async () => {
  const repo = new SupabaseGhlRepository();
  const before = Date.now();
  await repo.recordOptOut({ tenantId: TENANT, phone: "07700 900123", keyword: "STOP", ghlContactId: "c1" });
  assert.equal(seen.length, 1);
  const [req] = seen;
  assert.equal(req.method, "POST");
  assert.equal(req.url.pathname, "/rest/v1/whatsapp_opt_outs");
  assert.equal(req.url.searchParams.get("on_conflict"), "tenant_id,phone");
  assert.match(req.prefer ?? "", /resolution=merge-duplicates/);
  const row = req.body as Record<string, unknown>;
  assert.equal(row.tenant_id, TENANT);
  assert.equal(row.phone, "+447700900123");
  assert.equal(row.keyword, "STOP");
  assert.equal(row.ghl_contact_id, "c1");
  assert.ok(Date.parse(row.opted_out_at as string) >= before, "opted_out_at refreshed on every upsert");
});

test("recordOptOut is idempotent: repeating it sends the same upsert, never an insert-only", async () => {
  const repo = new SupabaseGhlRepository();
  await repo.recordOptOut({ tenantId: TENANT, phone: "+447700900123", keyword: "STOP", ghlContactId: null });
  await repo.recordOptOut({ tenantId: TENANT, phone: "+44 7700 900123", keyword: "STOP", ghlContactId: null });
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.equal(s.url.searchParams.get("on_conflict"), "tenant_id,phone");
    assert.equal((s.body as { phone: string }).phone, "+447700900123");
    assert.equal((s.body as { ghl_contact_id: unknown }).ghl_contact_id, null);
  }
});

test("recordOptOut skips a phone it cannot normalise: logs, does not throw (so the inbound row is not retried forever), no request sent", async () => {
  const repo = new SupabaseGhlRepository();
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await repo.recordOptOut({ tenantId: TENANT, phone: "not a number", keyword: "STOP", ghlContactId: null });
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.equal(seen.length, 0);
});

test("recordOptOut surfaces a database error", async () => {
  respond = () => ({ status: 500, body: { message: "boom" } });
  const repo = new SupabaseGhlRepository();
  await assert.rejects(() => repo.recordOptOut({ tenantId: TENANT, phone: "+447700900123", keyword: "STOP", ghlContactId: null }));
});

test("clearOptOut deletes exactly (tenant, normalised phone); an unparseable phone is a no-op", async () => {
  const repo = new SupabaseGhlRepository();
  await repo.clearOptOut(TENANT, "07700 900123");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url.pathname, "/rest/v1/whatsapp_opt_outs");
  assert.equal(seen[0].url.searchParams.get("tenant_id"), `eq.${TENANT}`);
  assert.equal(seen[0].url.searchParams.get("phone"), "eq.+447700900123");
  seen = [];
  await repo.clearOptOut(TENANT, "garbage");
  assert.equal(seen.length, 0);
});

test("isOptedOut is per (tenant, phone): true iff a row exists; unparseable phone is false without a query", async () => {
  const repo = new SupabaseGhlRepository();
  respond = () => ({ body: [{ phone: "+447700900123" }] });
  assert.equal(await repo.isOptedOut(TENANT, "07700 900123"), true);
  assert.equal(seen[0].url.searchParams.get("tenant_id"), `eq.${TENANT}`);
  assert.equal(seen[0].url.searchParams.get("phone"), "eq.+447700900123");
  respond = () => ({ body: [] });
  assert.equal(await repo.isOptedOut(TENANT, "+447700900124"), false);
  seen = [];
  assert.equal(await repo.isOptedOut(TENANT, "garbage"), false);
  assert.equal(seen.length, 0);
});

test("countOptOutsByTenant counts per tenant; every requested id appears; empty input sends nothing", async () => {
  const repo = new SupabaseGhlRepository();
  const A = TENANT;
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  respond = () => ({ body: [{ tenant_id: A }, { tenant_id: A }, { tenant_id: B }] });
  const map = await repo.countOptOutsByTenant([A, B, C]);
  assert.equal(map.get(A), 2);
  assert.equal(map.get(B), 1);
  assert.equal(map.get(C), 0);
  assert.match(seen[0].url.searchParams.get("tenant_id") ?? "", /^in\./);
  seen = [];
  assert.equal((await repo.countOptOutsByTenant([])).size, 0);
  assert.equal(seen.length, 0);
});

// Merge (STOP across numbers): removing a number carries its opt-outs onto the
// number that stays default, so a STOP keeps blocking the remaining numbers.
test("removeLocationNumber copies the removed number's opt-outs onto the remaining default before deleting", async () => {
  const DEFAULT_TENANT = "11111111-1111-4111-8111-111111111111";
  const REMOVED_TENANT = "22222222-2222-4222-8222-222222222222";
  respond = (req) => {
    const path = req.url.pathname;
    if (req.method === "GET" && path.endsWith("/ghl_location_numbers")) {
      return {
        body: [
          { tenant_id: DEFAULT_TENANT, slot: 1, is_default: true, label: null },
          { tenant_id: REMOVED_TENANT, slot: 2, is_default: false, label: "Sales" },
        ],
      };
    }
    if (req.method === "GET" && path.endsWith("/whatsapp_opt_outs")) {
      return { body: [{ phone: "+447700900123", opted_out_at: "2026-10-17T09:00:00Z", keyword: "STOP", ghl_contact_id: "c-1" }] };
    }
    return { body: [] };
  };
  const repo = new SupabaseGhlRepository();
  const result = await repo.removeLocationNumber("loc-1", 2);
  assert.deepEqual(result, { ok: true, removedTenantId: REMOVED_TENANT });
  const upsertIndex = seen.findIndex((s) => s.method === "POST" && s.url.pathname.endsWith("/whatsapp_opt_outs"));
  const deleteIndex = seen.findIndex((s) => s.method === "DELETE" && s.url.pathname.endsWith("/ghl_location_numbers"));
  assert.ok(upsertIndex >= 0, "the opt-outs are upserted");
  assert.ok(upsertIndex < deleteIndex, "before the number row is deleted");
  const upsert = seen[upsertIndex];
  assert.deepEqual(upsert.body, [{ tenant_id: DEFAULT_TENANT, phone: "+447700900123", opted_out_at: "2026-10-17T09:00:00Z", keyword: "STOP", ghl_contact_id: "c-1" }]);
  assert.match(upsert.prefer ?? "", /resolution=ignore-duplicates/);
  assert.equal(seen.find((s) => s.method === "GET" && s.url.pathname.endsWith("/whatsapp_opt_outs"))!.url.searchParams.get("tenant_id"), `eq.${REMOVED_TENANT}`);
});
