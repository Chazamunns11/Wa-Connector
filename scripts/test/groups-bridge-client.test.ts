import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  addWhatsappGroupParticipants,
  createWhatsappGroup,
  getWhatsappGroup,
  getWhatsappGroupJob,
  postToWhatsappGroup,
  revokeWhatsappGroupInvite,
} from "@/lib/whatsapp-bridge";

type Seen = { method: string; url: string; body: unknown; auth: string | null };
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const realFetch = globalThis.fetch;
const saved = { url: process.env.WHATSAPP_BRIDGE_URL, secret: process.env.WHATSAPP_BRIDGE_SECRET };
const COACH = "11111111-1111-4111-8111-111111111111";
const JID = "123-456@g.us";

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: {} };
  process.env.WHATSAPP_BRIDGE_URL = "https://bridge.test";
  process.env.WHATSAPP_BRIDGE_SECRET = "s3cret";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [["WHATSAPP_BRIDGE_URL", saved.url], ["WHATSAPP_BRIDGE_SECRET", saved.secret]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const group = { jid: JID, subject: "VIPs", inviteCode: "abc", participantCount: 2, weAreAdmin: true };
const results = [{ phone: "+447700900123", code: "200", outcome: "added" }];
const job = { id: "j1", status: "done", requestedCount: 1, results, createdAt: "2026-10-17T10:00:00Z", finishedAt: null };
const post = { id: "p1", idempotencyKey: "k1", status: "accepted", waMessageId: null, error: null, createdAt: "2026-10-17T10:00:00Z", sentAt: null };

test("createWhatsappGroup posts the body and maps 201", async () => {
  reply = { status: 201, body: { ok: true, group, results } };
  const out = await createWhatsappGroup(COACH, { subject: "VIPs", description: "d", participants: ["+447700900123"], announceOnly: false, adminAddOnly: true });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, `https://bridge.test/sessions/${COACH}/groups`);
  assert.equal(seen[0].auth, "Bearer s3cret");
  assert.deepEqual(seen[0].body, { subject: "VIPs", description: "d", participants: ["+447700900123"], announceOnly: false, adminAddOnly: true });
  assert.deepEqual(out, { ok: true, group, results });
});

test("addWhatsappGroupParticipants posts { add } to the encoded jid and maps 202", async () => {
  reply = { status: 202, body: { ok: true, job: { id: "j1", status: "queued", requestedCount: 1 } } };
  const out = await addWhatsappGroupParticipants(COACH, JID, ["+447700900123"]);
  assert.equal(seen[0].url, `https://bridge.test/sessions/${COACH}/groups/${encodeURIComponent(JID)}/participants`);
  assert.deepEqual(seen[0].body, { add: ["+447700900123"] });
  assert.deepEqual(out, { ok: true, job: { id: "j1", status: "queued", requestedCount: 1 } });
});

test("getWhatsappGroupJob GETs the job", async () => {
  reply = { status: 200, body: { ok: true, job } };
  const out = await getWhatsappGroupJob(COACH, "j1");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, `https://bridge.test/sessions/${COACH}/groups/jobs/j1`);
  assert.deepEqual(out, { ok: true, job });
});

test("postToWhatsappGroup maps 202 fresh and 200 replay", async () => {
  reply = { status: 202, body: { ok: true, replay: false, post } };
  const fresh = await postToWhatsappGroup(COACH, JID, "hi", "k1");
  assert.equal(seen[0].url, `https://bridge.test/sessions/${COACH}/groups/${encodeURIComponent(JID)}/messages`);
  assert.deepEqual(seen[0].body, { text: "hi", idempotencyKey: "k1" });
  assert.deepEqual(fresh, { ok: true, replay: false, post });
  reply = { status: 200, body: { ok: true, replay: true, post } };
  const again = await postToWhatsappGroup(COACH, JID, "hi", "k1");
  assert.deepEqual(again, { ok: true, replay: true, post });
});

test("getWhatsappGroup GETs the group", async () => {
  reply = { status: 200, body: { ok: true, group } };
  const out = await getWhatsappGroup(COACH, JID);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, `https://bridge.test/sessions/${COACH}/groups/${encodeURIComponent(JID)}`);
  assert.deepEqual(out, { ok: true, group });
});

test("revokeWhatsappGroupInvite POSTs and returns the new code", async () => {
  reply = { status: 200, body: { ok: true, inviteCode: "new" } };
  const out = await revokeWhatsappGroupInvite(COACH, JID);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, `https://bridge.test/sessions/${COACH}/groups/${encodeURIComponent(JID)}/invite/revoke`);
  assert.deepEqual(out, { ok: true, inviteCode: "new" });
});

test("non-2xx maps the bridge error code and message", async () => {
  reply = { status: 429, body: { ok: false, error: { code: "group_add_cap_reached", message: "cap" } } };
  assert.deepEqual(await addWhatsappGroupParticipants(COACH, JID, ["+447700900123"]), { ok: false, code: "group_add_cap_reached", message: "cap" });
  reply = { status: 404, body: { ok: false, error: { code: "groups_disabled", message: "off" } } };
  assert.deepEqual(await getWhatsappGroup(COACH, JID), { ok: false, code: "groups_disabled", message: "off" });
});

test("a 2xx with a malformed body is an internal failure for every function", async () => {
  reply = { status: 200, body: { ok: true } };
  for (const out of [
    await createWhatsappGroup(COACH, { subject: "s", participants: ["+447700900123"], announceOnly: false, adminAddOnly: true }),
    await getWhatsappGroupJob(COACH, "j1"),
    await getWhatsappGroup(COACH, JID),
    await revokeWhatsappGroupInvite(COACH, JID),
    await postToWhatsappGroup(COACH, JID, "hi", "k"),
  ]) {
    assert.equal(out.ok, false);
    assert.equal((out as { code: string }).code, "internal");
  }
  reply = { status: 202, body: { ok: true } };
  const add = await addWhatsappGroupParticipants(COACH, JID, ["+447700900123"]);
  assert.equal((add as { code: string }).code, "internal");
});

test("unconfigured env returns 'unconfigured' with no network attempt", async () => {
  delete process.env.WHATSAPP_BRIDGE_URL;
  const out = await getWhatsappGroup(COACH, JID);
  assert.equal(out.ok, false);
  assert.equal((out as { code: string }).code, "unconfigured");
  assert.equal(seen.length, 0);
});
