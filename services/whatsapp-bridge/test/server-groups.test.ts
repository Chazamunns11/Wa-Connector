/**
 * Group routes against a REAL createBridgeServer with a fake manager/store.
 * Pins: groups_disabled before body parsing, bearer gate, validation, the
 * path coach id is the only selector, and replay/conflict/cap mappings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { createBridgeServer } from "../src/server.js";
import type { SessionManager } from "../src/sessions.js";
import type { BridgeStore, GroupJobRecord, GroupPostRecord } from "../src/store.js";

const SECRET = "test-secret-0123456789-0123456789-0123456789";
const COACH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const JID = "120363012345678901@g.us";
const AUTH = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };

const job: GroupJobRecord = {
  id: JOB, coachId: COACH, groupJid: JID, status: "queued", requestedCount: 2, results: [{ phone: "+447700900123", code: "200", outcome: "added" }],
  createdAt: "2026-10-17T10:00:00.000Z", startedAt: null, finishedAt: null,
};
const post: GroupPostRecord = {
  id: "44444444-4444-4444-8444-444444444444", coachId: COACH, groupJid: JID, idempotencyKey: "k1", status: "accepted", waMessageId: null,
  error: null, dispatchAttempted: false, createdAt: "2026-10-17T10:00:00.000Z", sentAt: null,
};

type Outcomes = Record<string, unknown>;

async function withServer(groupsEnabled: boolean | undefined, outcomes: Outcomes, fn: (base: string, calls: { method: string; args: unknown[] }[]) => Promise<void>) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, value: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return value;
  };
  const manager = {
    createGroup: rec("createGroup", outcomes.create),
    startAddJob: rec("startAddJob", outcomes.add),
    postToGroup: rec("postToGroup", outcomes.post),
    getGroup: rec("getGroup", outcomes.get),
    revokeGroupInvite: rec("revokeGroupInvite", outcomes.revoke),
  } as unknown as SessionManager;
  const store = { tenantExists: async () => true, getGroupJob: async (_c: string, id: string) => (id === JOB ? job : null) } as unknown as BridgeStore;
  const server = createBridgeServer({ manager, store, bridgeSecret: SECRET, log: pino({ level: "silent" }), ...(groupsEnabled === undefined ? {} : { groupsEnabled }) });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const j = (body: unknown) => JSON.stringify(body);
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("groups routes are 404 groups_disabled when the flag is off (default), and all require auth", async () => {
  for (const flag of [undefined, false]) {
    await withServer(flag, {}, async (base, calls) => {
      const res = await fetch(`${base}/sessions/${COACH}/groups`, { method: "POST", headers: AUTH, body: "not json at all" });
      assert.equal(res.status, 404);
      assert.equal(await errCode(res), "groups_disabled");
      for (const [m, p] of [["GET", `/groups/${JID}`], ["POST", `/groups/${JID}/participants`], ["POST", `/groups/${JID}/messages`], ["GET", `/groups/jobs/${JOB}`], ["POST", `/groups/${JID}/invite/revoke`]] as const) {
        const r = await fetch(`${base}/sessions/${COACH}${p}`, { method: m, headers: AUTH });
        assert.equal(r.status, 404, p);
        assert.equal(await errCode(r), "groups_disabled");
      }
      assert.equal(calls.length, 0);
    });
  }
  await withServer(true, {}, async (base) => {
    const res = await fetch(`${base}/sessions/${COACH}/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: j({}) });
    assert.equal(res.status, 401);
    const bad = await fetch(`${base}/sessions/${COACH}/groups/${JID}`, { headers: { authorization: "Bearer nope" } });
    assert.equal(bad.status, 401);
  });
});

test("POST /groups validates and forwards exactly the path coach id", async () => {
  const created = { kind: "created", group: { jid: JID, subject: "S", inviteCode: "abc", participantCount: 2, weAreAdmin: true }, results: [{ phone: "+447700900123", code: "200", outcome: "added" }] };
  await withServer(true, { create: created }, async (base, calls) => {
    const post = (body: unknown) => fetch(`${base}/sessions/${COACH}/groups`, { method: "POST", headers: AUTH, body: j(body) });
    const ok = ["+447700900123"];
    for (const subject of ["", "   ", "x".repeat(101), 5]) {
      const r = await post({ subject, participants: ok });
      assert.equal(r.status, 422);
      assert.equal(await errCode(r), "invalid_subject");
    }
    const d = await post({ subject: "S", description: "d".repeat(2049), participants: ok });
    assert.equal(d.status, 422);
    assert.equal(await errCode(d), "invalid_description");
    for (const participants of [[], Array.from({ length: 6 }, (_, i) => `+44770090010${i}`), ["07700900123"], ["+447700900123", "+447700900123"], "x", undefined]) {
      const r = await post({ subject: "S", participants });
      assert.equal(r.status, 422);
      assert.equal(await errCode(r), "invalid_participants");
    }
    assert.equal(calls.length, 0);
    const res = await post({ subject: " Team ", description: "hi", participants: ok, announceOnly: true, coachId: OTHER });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { ok: boolean; group: { jid: string }; results: unknown[] };
    assert.equal(body.group.jid, JID);
    assert.equal(body.results.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args[0], COACH);
    assert.deepEqual(calls[0]!.args[1], { subject: "Team", description: "hi", participants: ok, announceOnly: true, adminAddOnly: false });
  });
});

test("POST /groups maps manager outcomes", async () => {
  const cases: [unknown, number, string][] = [
    [{ kind: "session_not_connected", status: "disconnected" }, 409, "session_not_connected"],
    [{ kind: "group_create_cap_reached", cap: 3 }, 429, "group_create_cap_reached"],
    [{ kind: "lease_unavailable" }, 503, "lease_unavailable"],
    [{ kind: "whatsapp_refused" }, 502, "whatsapp_refused"],
  ];
  for (const [outcome, status, code] of cases) {
    await withServer(true, { create: outcome }, async (base) => {
      const r = await fetch(`${base}/sessions/${COACH}/groups`, { method: "POST", headers: AUTH, body: j({ subject: "S", participants: ["+447700900123"] }) });
      assert.equal(r.status, status);
      assert.equal(await errCode(r), code);
    });
  }
});

test("POST /groups/:jid/participants", async () => {
  await withServer(true, { add: { kind: "queued", job } }, async (base, calls) => {
    const post = (jid: string, body: unknown) => fetch(`${base}/sessions/${COACH}/groups/${encodeURIComponent(jid)}/participants`, { method: "POST", headers: AUTH, body: j(body) });
    const bad = await post("nope@g.us", { add: ["+447700900123"] });
    assert.equal(bad.status, 422);
    assert.equal(await errCode(bad), "invalid_group_jid");
    for (const add of [[], Array.from({ length: 51 }, (_, i) => `+4477009${String(i).padStart(5, "0")}`), ["123"]]) {
      const r = await post(JID, { add });
      assert.equal(r.status, 422);
      assert.equal(await errCode(r), "invalid_participants");
    }
    assert.equal(calls.length, 0);
    const ok = await post(JID, { add: ["+447700900123", "+447700900124"] });
    assert.equal(ok.status, 202);
    const body = (await ok.json()) as { ok: boolean; job: Record<string, unknown> };
    assert.deepEqual(body.job, { id: JOB, status: "queued", requestedCount: 2 });
    assert.deepEqual(calls[0]!.args, [COACH, JID, ["+447700900123", "+447700900124"]]);
  });
  await withServer(true, { add: { kind: "group_add_cap_reached", remaining: 1 } }, async (base) => {
    const r = await fetch(`${base}/sessions/${COACH}/groups/${JID}/participants`, { method: "POST", headers: AUTH, body: j({ add: ["+447700900123", "+447700900124"] }) });
    assert.equal(r.status, 429);
    assert.equal(await errCode(r), "group_add_cap_reached");
  });
  await withServer(true, { add: { kind: "session_not_connected", status: "disconnected" } }, async (base) => {
    const r = await fetch(`${base}/sessions/${COACH}/groups/${JID}/participants`, { method: "POST", headers: AUTH, body: j({ add: ["+447700900123"] }) });
    assert.equal(r.status, 409);
  });
});

test("POST /groups/:jid/messages replays like /send", async () => {
  const url = (base: string) => `${base}/sessions/${COACH}/groups/${JID}/messages`;
  await withServer(true, { post: { kind: "accepted", post, fresh: true } }, async (base, calls) => {
    const send = (body: unknown) => fetch(url(base), { method: "POST", headers: AUTH, body: j(body) });
    for (const text of ["", "x".repeat(4097), 3]) {
      const r = await send({ text, idempotencyKey: "k1" });
      assert.equal(r.status, 422);
      assert.equal(await errCode(r), "invalid_text");
    }
    for (const key of ["", "bad key!", undefined]) {
      const r = await send({ text: "hi", idempotencyKey: key });
      assert.equal(r.status, 422);
      assert.equal(await errCode(r), "invalid_idempotency_key");
    }
    assert.equal(calls.length, 0);
    const fresh = await send({ text: "hi", idempotencyKey: "k1" });
    assert.equal(fresh.status, 202);
    const body = (await fresh.json()) as { replay: boolean; post: Record<string, unknown> };
    assert.equal(body.replay, false);
    assert.equal(body.post.idempotencyKey, "k1");
    assert.deepEqual(calls[0]!.args, [COACH, JID, "hi", "k1"]);
  });
  await withServer(true, { post: { kind: "accepted", post, fresh: false } }, async (base) => {
    const r = await fetch(url(base), { method: "POST", headers: AUTH, body: j({ text: "hi", idempotencyKey: "k1" }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { replay: boolean }).replay, true);
  });
  const cases: [unknown, number, string][] = [
    [{ kind: "idempotency_conflict", existing: post }, 422, "idempotency_conflict"],
    [{ kind: "session_not_connected", status: "disconnected" }, 409, "session_not_connected"],
    [{ kind: "daily_cap_reached", cap: 150 }, 429, "daily_cap_reached"],
    [{ kind: "lease_unavailable" }, 503, "lease_unavailable"],
  ];
  for (const [outcome, status, code] of cases) {
    await withServer(true, { post: outcome }, async (base) => {
      const r = await fetch(url(base), { method: "POST", headers: AUTH, body: j({ text: "hi", idempotencyKey: "k1" }) });
      assert.equal(r.status, status);
      assert.equal(await errCode(r), code);
    });
  }
});

test("GET /groups/jobs/:jobId", async () => {
  await withServer(true, {}, async (base) => {
    const get = (id: string) => fetch(`${base}/sessions/${COACH}/groups/jobs/${id}`, { headers: AUTH });
    assert.equal((await get("not-a-uuid")).status, 400);
    assert.equal((await get("55555555-5555-4555-8555-555555555555")).status, 404);
    const ok = await get(JOB);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { job: { id: string; status: string; requestedCount: number; results: unknown[]; createdAt: string; finishedAt: string | null } };
    assert.equal(body.job.id, JOB);
    assert.equal(Array.isArray(body.job.results), true);
    assert.equal(body.job.results.length, 1);
    assert.equal(body.job.finishedAt, null);
  });
});

test("GET /groups/:jid and POST /groups/:jid/invite/revoke", async () => {
  const group = { jid: JID, subject: "S", participantCount: 2, weAreAdmin: true, inviteCode: "abc" };
  await withServer(true, { get: { kind: "ok", group }, revoke: { kind: "ok", inviteCode: "new" } }, async (base, calls) => {
    const g = await fetch(`${base}/sessions/${COACH}/groups/${encodeURIComponent(JID)}`, { headers: AUTH });
    assert.equal(g.status, 200);
    const text = await g.text();
    assert.deepEqual((JSON.parse(text) as { group: unknown }).group, group);
    assert.equal(/\+\d{8}/.test(text), false);
    const bad = await fetch(`${base}/sessions/${COACH}/groups/nope`, { headers: AUTH });
    assert.equal(bad.status, 422);
    assert.equal(await errCode(bad), "invalid_group_jid");
    const r = await fetch(`${base}/sessions/${COACH}/groups/${JID}/invite/revoke`, { method: "POST", headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, inviteCode: "new" });
    assert.deepEqual(calls.map((c) => c.args), [[COACH, JID], [COACH, JID]]);
  });
  await withServer(true, { get: { kind: "group_not_found" }, revoke: { kind: "group_not_found" } }, async (base) => {
    assert.equal((await fetch(`${base}/sessions/${COACH}/groups/${JID}`, { headers: AUTH })).status, 404);
    const r = await fetch(`${base}/sessions/${COACH}/groups/${JID}/invite/revoke`, { method: "POST", headers: AUTH });
    assert.equal(r.status, 404);
    assert.equal(await errCode(r), "group_not_found");
  });
  await withServer(true, { get: { kind: "session_not_connected", status: "disconnected" } }, async (base) => {
    assert.equal((await fetch(`${base}/sessions/${COACH}/groups/${JID}`, { headers: AUTH })).status, 409);
  });
});
