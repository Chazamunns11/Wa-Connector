import test from "node:test";
import assert from "node:assert/strict";
import {
  createWhatsappGroup,
  getWhatsappGroupDetail,
  getWhatsappGroupInvite,
  isValidGroupDetail,
  isValidInviteLink,
  leaveWhatsappGroup,
  resetWhatsappGroupInvite,
  updateWhatsappGroup,
  updateWhatsappGroupParticipants,
} from "@/lib/whatsapp-bridge";

const COACH = "33333333-3333-4333-8333-333333333333";
const JID = "120363012345678901@g.us";
const LINK = "https://chat.whatsapp.com/AbCdEfGhIjKlMn";

const member = { memberId: "447700900123@s.whatsapp.net", phone: "+447700900123", admin: null, isUs: false };
const detail = { jid: JID, name: "Run Club", description: null, announcement: false, approval: false, weAreAdmin: true, members: [member] };

type Captured = { url: string; method: string; body: unknown };

async function withBridge<T>(respond: (req: Captured) => Response, run: () => Promise<T>): Promise<{ result: T; requests: Captured[] }> {
  const saved = { url: process.env.WHATSAPP_BRIDGE_URL, secret: process.env.WHATSAPP_BRIDGE_SECRET, fetch: globalThis.fetch };
  process.env.WHATSAPP_BRIDGE_URL = "https://bridge.example.test";
  process.env.WHATSAPP_BRIDGE_SECRET = "bridge-secret";
  const requests: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(req);
    return respond(req);
  }) as typeof fetch;
  try {
    return { result: await run(), requests };
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.WHATSAPP_BRIDGE_URL;
    else process.env.WHATSAPP_BRIDGE_URL = saved.url;
    if (saved.secret === undefined) delete process.env.WHATSAPP_BRIDGE_SECRET;
    else process.env.WHATSAPP_BRIDGE_SECRET = saved.secret;
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string, message: string) => json(status, { ok: false, error: { code, message } });

test("isValidGroupDetail: accepts a good detail; rejects a member without memberId or with admin 'owner'", () => {
  assert.equal(isValidGroupDetail(detail), true);
  assert.equal(isValidGroupDetail({ ...detail, members: [{ phone: null, admin: null, isUs: false }] }), false);
  assert.equal(isValidGroupDetail({ ...detail, members: [{ ...member, admin: "owner" }] }), false);
  assert.equal(isValidGroupDetail({ ...detail, weAreAdmin: "yes" }), false);
  assert.equal(isValidGroupDetail(null), false);
});

test("isValidInviteLink: only https://chat.whatsapp.com/<code>", () => {
  assert.equal(isValidInviteLink(LINK), true);
  assert.equal(isValidInviteLink("http://chat.whatsapp.com/x"), false);
  assert.equal(isValidInviteLink("https://evil.example/abc"), false);
  assert.equal(isValidInviteLink("https://chat.whatsapp.com/AbCdEfGhIj/extra"), false);
  assert.equal(isValidInviteLink(undefined), false);
});

test("createWhatsappGroup: POSTs the input; ok body is returned flat", async () => {
  const input = { requestId: "req-1", name: "Run Club", participants: ["+447700900123"] };
  const { result, requests } = await withBridge(() => json(200, { ok: true, jid: JID, name: "Run Club", addedPhone: null, path: "empty" }), () => createWhatsappGroup(COACH, input));
  assert.deepEqual(result, { ok: true, jid: JID, name: "Run Club", addedPhone: null, path: "empty" });
  assert.equal(requests[0].url, `https://bridge.example.test/sessions/${COACH}/groups`);
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, input);
});

test("createWhatsappGroup: a refusal keeps its code and fixed message; a malformed ok body is 'internal'", async () => {
  const msg = "This number has created its 3 groups for today. Try again tomorrow.";
  const refused = await withBridge(() => refusal(422, "create_limit", msg), () => createWhatsappGroup(COACH, { requestId: "r", name: "x", participants: [] }));
  assert.deepEqual(refused.result, { ok: false, code: "create_limit", message: msg });
  const failed = await withBridge(() => refusal(502, "group_action_failed", "WhatsApp could not complete that group action — retry shortly"), () => createWhatsappGroup(COACH, { requestId: "r", name: "x", participants: [] }));
  assert.equal(failed.result.ok === false && failed.result.code, "group_action_failed");
  const bad = await withBridge(() => json(200, { ok: true, jid: "nope", name: "x", addedPhone: null, path: "empty" }), () => createWhatsappGroup(COACH, { requestId: "r", name: "x", participants: [] }));
  assert.equal(bad.result.ok === false && bad.result.code, "internal");
});

test("getWhatsappGroupDetail: encodes the JID into the path; malformed group is 'internal'", async () => {
  const ok = await withBridge(() => json(200, { ok: true, group: detail }), () => getWhatsappGroupDetail(COACH, JID));
  assert.deepEqual(ok.result, { ok: true, group: detail });
  assert.equal(ok.requests[0].url, `https://bridge.example.test/sessions/${COACH}/groups/${encodeURIComponent(JID)}`);
  assert.equal(ok.requests[0].method, "GET");
  const bad = await withBridge(() => json(200, { ok: true, group: { ...detail, members: [{ ...member, admin: "owner" }] } }), () => getWhatsappGroupDetail(COACH, JID));
  assert.equal(bad.result.ok === false && bad.result.code, "internal");
  const notAdmin = await withBridge(() => refusal(403, "not_admin", "This number isn't an admin of that group."), () => getWhatsappGroupDetail(COACH, JID));
  assert.deepEqual(notAdmin.result, { ok: false, code: "not_admin", message: "This number isn't an admin of that group." });
});

test("updateWhatsappGroup: PATCHes the patch", async () => {
  const { result, requests } = await withBridge(() => json(200, { ok: true }), () => updateWhatsappGroup(COACH, JID, { name: "New", announcement: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(requests[0].method, "PATCH");
  assert.deepEqual(requests[0].body, { name: "New", announcement: true });
});

test("updateWhatsappGroupParticipants: POSTs to /participants; validates results; 503 keeps its code", async () => {
  const results = [{ phone: "+447700900123", result: "invite_required" }, { memberId: "m@lid", result: "ok" }];
  const ok = await withBridge(() => json(200, { ok: true, results }), () => updateWhatsappGroupParticipants(COACH, JID, { action: "add", phones: ["+447700900123"] }));
  assert.deepEqual(ok.result, { ok: true, results });
  assert.equal(ok.requests[0].url, `https://bridge.example.test/sessions/${COACH}/groups/${encodeURIComponent(JID)}/participants`);
  const bad = await withBridge(() => json(200, { ok: true, results: [{ result: "bogus" }] }), () => updateWhatsappGroupParticipants(COACH, JID, { action: "remove", memberIds: ["m"] }));
  assert.equal(bad.result.ok === false && bad.result.code, "internal");
  const down = await withBridge(() => refusal(503, "limits_unavailable", "Group limits are unavailable right now. Try again shortly."), () => updateWhatsappGroupParticipants(COACH, JID, { action: "add", phones: ["+447700900123"] }));
  assert.equal(down.result.ok === false && down.result.code, "limits_unavailable");
});

test("invite get/reset: validate the link; leave: POST", async () => {
  const got = await withBridge(() => json(200, { ok: true, link: LINK }), () => getWhatsappGroupInvite(COACH, JID));
  assert.deepEqual(got.result, { ok: true, link: LINK });
  assert.equal(got.requests[0].method, "GET");
  assert.ok(got.requests[0].url.endsWith("/invite"));
  const reset = await withBridge(() => json(200, { ok: true, link: LINK }), () => resetWhatsappGroupInvite(COACH, JID));
  assert.equal(reset.requests[0].method, "POST");
  assert.ok(reset.requests[0].url.endsWith("/invite/reset"));
  const evil = await withBridge(() => json(200, { ok: true, link: "https://evil.example/abc" }), () => getWhatsappGroupInvite(COACH, JID));
  assert.equal(evil.result.ok === false && evil.result.code, "internal");
  const left = await withBridge(() => json(200, { ok: true }), () => leaveWhatsappGroup(COACH, JID));
  assert.deepEqual(left.result, { ok: true });
  assert.ok(left.requests[0].url.endsWith("/leave"));
});

test("group calls: unconfigured -> 'unconfigured' with no request", async () => {
  const saved = { url: process.env.WHATSAPP_BRIDGE_URL, secret: process.env.WHATSAPP_BRIDGE_SECRET };
  delete process.env.WHATSAPP_BRIDGE_URL;
  delete process.env.WHATSAPP_BRIDGE_SECRET;
  try {
    const r = await getWhatsappGroupDetail(COACH, JID);
    assert.equal(r.ok === false && r.code, "unconfigured");
  } finally {
    if (saved.url !== undefined) process.env.WHATSAPP_BRIDGE_URL = saved.url;
    if (saved.secret !== undefined) process.env.WHATSAPP_BRIDGE_SECRET = saved.secret;
  }
});
