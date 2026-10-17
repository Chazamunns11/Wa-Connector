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
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";

const groupRow = {
  id: GROUP, tenant_id: TENANT, location_id: "loc1", account_id: ACCOUNT, wa_group_jid: "123-456@g.us", subject: "VIPs",
  description: null, invite_code: "abc", announce_only: false, admin_add_only: true, participant_count: 1, we_are_admin: true,
  created_by_profile_id: null, created_at: "2026-10-17T10:00:00Z", updated_at: "2026-10-17T10:00:00Z",
};
const memberRow = {
  id: "m1", group_id: GROUP, phone: "+447700900123", ghl_contact_id: "c1", display_name: "Sam", state: "pending", job_id: JOB,
  invite_idempotency_key: null, consent_confirmed_at: "2026-10-17T10:00:00Z", added_by_profile_id: null, last_reason: null,
  created_at: "2026-10-17T10:00:00Z", updated_at: "2026-10-17T10:00:00Z",
};

test("createWhatsappGroup inserts a snake_case row and maps the returned row", async () => {
  respond = () => ({ body: groupRow }); // .single() asks PostgREST for one object
  const repo = new SupabaseGhlRepository();
  const g = await repo.createWhatsappGroup({
    tenantId: TENANT, locationId: "loc1", accountId: ACCOUNT, waGroupJid: "123-456@g.us", subject: "VIPs", description: null,
    inviteCode: "abc", announceOnly: false, adminAddOnly: true, participantCount: 1, weAreAdmin: true, createdByProfileId: null,
  });
  const [req] = seen;
  assert.equal(req.method, "POST");
  assert.equal(req.url.pathname, "/rest/v1/whatsapp_groups");
  const row = req.body as Record<string, unknown>;
  assert.equal(row.tenant_id, TENANT);
  assert.equal(row.wa_group_jid, "123-456@g.us");
  assert.equal(row.admin_add_only, true);
  assert.equal(g.id, GROUP);
  assert.equal(g.waGroupJid, "123-456@g.us");
  assert.equal(g.weAreAdmin, true);
});

test("getWhatsappGroup returns null when absent", async () => {
  const repo = new SupabaseGhlRepository();
  assert.equal(await repo.getWhatsappGroup(GROUP), null);
  assert.equal(seen[0].url.searchParams.get("id"), `eq.${GROUP}`);
  respond = () => ({ body: [groupRow] });
  assert.equal((await repo.getWhatsappGroup(GROUP))?.subject, "VIPs");
});

test("listWhatsappGroupsForAccount filters by account, newest first", async () => {
  respond = () => ({ body: [groupRow] });
  const repo = new SupabaseGhlRepository();
  const rows = await repo.listWhatsappGroupsForAccount(ACCOUNT);
  assert.equal(rows.length, 1);
  assert.equal(seen[0].url.pathname, "/rest/v1/whatsapp_groups");
  assert.equal(seen[0].url.searchParams.get("account_id"), `eq.${ACCOUNT}`);
  assert.equal(seen[0].url.searchParams.get("order"), "created_at.desc");
});

test("updateWhatsappGroup patches only the provided fields, mapped to columns", async () => {
  const repo = new SupabaseGhlRepository();
  await repo.updateWhatsappGroup(GROUP, { inviteCode: null, participantCount: 4, weAreAdmin: false });
  const [req] = seen;
  assert.equal(req.method, "PATCH");
  assert.equal(req.url.searchParams.get("id"), `eq.${GROUP}`);
  assert.deepEqual(req.body, { invite_code: null, participant_count: 4, we_are_admin: false });
});

test("updateWhatsappGroup with an empty patch sends nothing", async () => {
  await new SupabaseGhlRepository().updateWhatsappGroup(GROUP, {});
  assert.equal(seen.length, 0);
});

test("insertWhatsappGroupMembers ignores duplicates on (group_id, phone) and returns inserted rows", async () => {
  respond = () => ({ body: [memberRow] });
  const repo = new SupabaseGhlRepository();
  const out = await repo.insertWhatsappGroupMembers([
    { groupId: GROUP, phone: "+447700900123", ghlContactId: "c1", displayName: "Sam", state: "pending", jobId: JOB, consentConfirmedAt: "2026-10-17T10:00:00Z", addedByProfileId: null, lastReason: null },
  ]);
  const [req] = seen;
  assert.equal(req.method, "POST");
  assert.equal(req.url.pathname, "/rest/v1/whatsapp_group_members");
  assert.equal(req.url.searchParams.get("on_conflict"), "group_id,phone");
  assert.match(req.prefer ?? "", /resolution=ignore-duplicates/);
  assert.match(req.prefer ?? "", /return=representation/);
  const rows = req.body as Record<string, unknown>[];
  assert.equal(rows[0].group_id, GROUP);
  assert.equal(rows[0].job_id, JOB);
  assert.equal(rows[0].consent_confirmed_at, "2026-10-17T10:00:00Z");
  assert.equal(out[0].phone, "+447700900123");
  assert.equal(out[0].jobId, JOB);
});

test("insertWhatsappGroupMembers with no drafts sends nothing", async () => {
  assert.deepEqual(await new SupabaseGhlRepository().insertWhatsappGroupMembers([]), []);
  assert.equal(seen.length, 0);
});

test("listWhatsappGroupMembers filters by group", async () => {
  respond = () => ({ body: [memberRow] });
  const rows = await new SupabaseGhlRepository().listWhatsappGroupMembers(GROUP);
  assert.equal(seen[0].url.searchParams.get("group_id"), `eq.${GROUP}`);
  assert.equal(rows[0].displayName, "Sam");
});

test("updateWhatsappGroupMember sets state and reason, and the invite key only when given", async () => {
  const repo = new SupabaseGhlRepository();
  await repo.updateWhatsappGroupMember("m1", { state: "added", lastReason: null });
  await repo.updateWhatsappGroupMember("m1", { state: "invite_sent", lastReason: "x", inviteIdempotencyKey: "k1" });
  assert.equal(seen[0].method, "PATCH");
  assert.equal(seen[0].url.searchParams.get("id"), "eq.m1");
  assert.deepEqual(seen[0].body, { state: "added", last_reason: null });
  assert.deepEqual(seen[1].body, { state: "invite_sent", last_reason: "x", invite_idempotency_key: "k1" });
});

test("listPendingGroupJobIds returns distinct job/group pairs for pending members of the account's groups", async () => {
  respond = () => ({
    body: [
      { job_id: JOB, group_id: GROUP },
      { job_id: JOB, group_id: GROUP },
      { job_id: null, group_id: GROUP },
    ],
  });
  const out = await new SupabaseGhlRepository().listPendingGroupJobIds(ACCOUNT);
  const url = seen[0].url;
  assert.equal(url.pathname, "/rest/v1/whatsapp_group_members");
  assert.equal(url.searchParams.get("state"), "eq.pending");
  assert.match(url.searchParams.get("select") ?? "", /whatsapp_groups!inner/);
  assert.equal(url.searchParams.get("whatsapp_groups.account_id"), `eq.${ACCOUNT}`);
  assert.deepEqual(out, [{ jobId: JOB, groupId: GROUP }]);
});

test("listAccountsWithPendingGroupMembers covers pending and held-invite members, distinct, bounded", async () => {
  respond = () => ({ body: [{ whatsapp_groups: { account_id: ACCOUNT } }, { whatsapp_groups: { account_id: ACCOUNT } }] });
  const out = await new SupabaseGhlRepository().listAccountsWithPendingGroupMembers(10);
  assert.equal(seen[0].url.searchParams.get("state"), "in.(pending,invite_needed)");
  assert.ok(seen[0].url.searchParams.get("limit"));
  assert.deepEqual(out, [ACCOUNT]);
});

test("getWhatsappGroupJob reads the bridge-owned table and maps it", async () => {
  respond = () => ({
    body: [{ id: JOB, coach_id: TENANT, group_jid: "123-456@g.us", kind: "add", status: "done", requested_count: 1, results: [{ phone: "+447700900123", code: "200", outcome: "added" }], created_at: "2026-10-17T10:00:00Z", finished_at: "2026-10-17T10:01:00Z" }],
  });
  const job = await new SupabaseGhlRepository().getWhatsappGroupJob(JOB);
  assert.equal(seen[0].url.pathname, "/rest/v1/whatsapp_group_jobs");
  assert.equal(seen[0].url.searchParams.get("id"), `eq.${JOB}`);
  assert.equal(job?.status, "done");
  assert.equal(job?.results[0].outcome, "added");
  respond = () => ({ body: [] });
  assert.equal(await new SupabaseGhlRepository().getWhatsappGroupJob(JOB), null);
});

test("listWhatsappGroupPosts scopes by coach and group jid, newest first, with a limit", async () => {
  respond = () => ({
    body: [{ id: "p1", coach_id: TENANT, group_jid: "123-456@g.us", idempotency_key: "k", status: "sent", wa_message_id: "w", error: null, created_at: "2026-10-17T10:00:00Z", sent_at: "2026-10-17T10:00:05Z" }],
  });
  const out = await new SupabaseGhlRepository().listWhatsappGroupPosts(TENANT, "123-456@g.us", 5);
  const url = seen[0].url;
  assert.equal(url.pathname, "/rest/v1/whatsapp_group_posts");
  assert.equal(url.searchParams.get("coach_id"), `eq.${TENANT}`);
  assert.equal(url.searchParams.get("group_jid"), "eq.123-456@g.us");
  assert.equal(url.searchParams.get("order"), "created_at.desc");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(out[0].waMessageId, "w");
  assert.equal(out[0].idempotencyKey, "k");
});
