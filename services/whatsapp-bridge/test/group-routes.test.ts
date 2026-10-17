/**
 * Group management routes against a REAL createBridgeServer with a fake
 * SessionManager: JID and body validation (manager never reached on a bad
 * request), outcome-to-status mapping with the fixed messages passed through,
 * auth, and no shadowing of POST /groups/refresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { createBridgeServer } from "../src/server.js";
import type { SessionManager } from "../src/sessions.js";
import type { BridgeStore } from "../src/store.js";
import type { GroupOpOutcome } from "../src/group-management.js";
import {
  GROUP_ADD_LIMIT_REASON,
  GROUP_NEEDS_MEMBER_REASON,
  GROUP_NOT_ADMIN_REASON,
  GROUP_WARMUP_REASON,
  groupCreateLimitReason,
} from "../src/groups.js";

const SECRET = "test-secret-0123456789-0123456789-0123456789";
const COACH = "11111111-1111-4111-8111-111111111111";
const JID = "120363025246125486@g.us";
const MEMBER = "447700900123@s.whatsapp.net";
const AUTH = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };

type Calls = { method: string; args: unknown[] }[];

async function withServer(outcome: GroupOpOutcome<unknown>, fn: (base: string, calls: Calls) => Promise<void>): Promise<void> {
  const calls: Calls = [];
  const rec = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return outcome;
  };
  const manager = {
    createGroup: rec("createGroup"),
    getGroupDetail: rec("getGroupDetail"),
    updateGroup: rec("updateGroup"),
    updateGroupParticipants: rec("updateGroupParticipants"),
    getGroupInviteLink: rec("getGroupInviteLink"),
    resetGroupInviteLink: rec("resetGroupInviteLink"),
    leaveGroup: rec("leaveGroup"),
    refreshEnabledGroups: async (...args: unknown[]) => {
      calls.push({ method: "refreshEnabledGroups", args });
      return { kind: "ok" };
    },
  } as unknown as SessionManager;
  const store = { tenantExists: async () => true } as unknown as BridgeStore;
  const server = createBridgeServer({ manager, store, bridgeSecret: SECRET, log: pino({ level: "silent" }) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/sessions/${COACH}/groups`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const OK = { kind: "ok", value: null } as const;
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
const patch = (url: string, body: unknown) => fetch(url, { method: "PATCH", headers: AUTH, body: JSON.stringify(body) });
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("malformed :jid is 400 invalid_group_jid on every :jid route, manager never called", async () => {
  await withServer(OK, async (base, calls) => {
    for (const bad of ["abc", MEMBER, "../", "%E0%A4%A"]) {
      const enc = bad.startsWith("%") ? bad : encodeURIComponent(bad);
      const reqs = [
        fetch(`${base}/${enc}`, { headers: AUTH }),
        patch(`${base}/${enc}`, { name: "x" }),
        post(`${base}/${enc}/participants`, { action: "add", phones: ["+447700900123"] }),
        fetch(`${base}/${enc}/invite`, { headers: AUTH }),
        post(`${base}/${enc}/invite/reset`, {}),
        post(`${base}/${enc}/leave`, {}),
      ];
      for (const res of await Promise.all(reqs)) {
        assert.equal(res.status, 400, bad);
        assert.equal(await errCode(res), "invalid_group_jid");
      }
    }
    assert.equal(calls.length, 0);
  });
});

test("create: validation failures are 400 invalid_body and never reach the manager", async () => {
  await withServer(OK, async (base, calls) => {
    const good = { requestId: "req-1", name: "Team", participants: ["+447700900123"] };
    const bad: unknown[] = [
      { ...good, name: "   " },
      { ...good, name: "a".repeat(101) },
      { ...good, name: "😀".repeat(101) },
      { ...good, description: "d".repeat(513) },
      { ...good, participants: ["07700900123"] },
      { ...good, participants: Array.from({ length: 51 }, () => "+447700900123") },
      { ...good, requestId: "bad id" },
      { name: "Team" },
    ];
    for (const body of bad) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(await errCode(res), "invalid_body");
    }
    assert.equal(calls.length, 0);
  });
});

test("create: boundary values pass (100 code points, 512 description) and the result is returned", async () => {
  await withServer({ kind: "ok", value: { jid: JID, name: "n", addedPhone: null, path: "empty" } }, async (base, calls) => {
    const res = await post(base, { requestId: "req-1", name: "😀".repeat(100), description: "d".repeat(512), participants: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, jid: JID, name: "n", addedPhone: null, path: "empty" });
    assert.equal(calls[0].method, "createGroup");
    assert.equal(calls[0].args[0], COACH);
  });
});

test("participants: body validation", async () => {
  await withServer(OK, async (base, calls) => {
    const url = `${base}/${encodeURIComponent(JID)}/participants`;
    const bad: unknown[] = [
      { action: "add", phones: ["+447700900123"], memberIds: [MEMBER] },
      { action: "add", phones: ["nope"] },
      { action: "add", phones: [] },
      { action: "add", memberIds: [MEMBER] },
      { action: "remove", memberIds: ["not-a-member"] },
      { action: "remove", phones: ["+447700900123"] },
      { action: "remove", memberIds: Array.from({ length: 51 }, () => MEMBER) },
      { action: "ban", memberIds: [MEMBER] },
      {},
    ];
    for (const body of bad) {
      const res = await post(url, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(await errCode(res), "invalid_body");
    }
    assert.equal(calls.length, 0);
  });
});

test("participants: a valid request reaches the manager and returns results", async () => {
  const results = [{ memberId: MEMBER, result: "ok" }];
  await withServer({ kind: "ok", value: results }, async (base, calls) => {
    const res = await post(`${base}/${encodeURIComponent(JID)}/participants`, { action: "promote", memberIds: [MEMBER] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, results });
    assert.deepEqual(calls[0].args, [COACH, JID, { action: "promote", memberIds: [MEMBER] }]);
  });
});

test("patch: needs a field, checks limits, accepts the raw @ in the path", async () => {
  await withServer(OK, async (base, calls) => {
    for (const body of [{}, { name: "" }, { description: "d".repeat(513) }, { announcement: "yes" }]) {
      assert.equal((await patch(`${base}/${JID}`, body)).status, 400);
    }
    assert.equal(calls.length, 0);
    const res = await patch(`${base}/${JID}`, { announcement: true, approval: false });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].args, [COACH, JID, { announcement: true, approval: false }]);
  });
});

test("get, invite, reset and leave return their shapes", async () => {
  await withServer({ kind: "ok", value: { link: "https://chat.whatsapp.com/abc" } }, async (base) => {
    const j = encodeURIComponent(JID);
    assert.deepEqual(await (await fetch(`${base}/${j}/invite`, { headers: AUTH })).json(), { ok: true, link: "https://chat.whatsapp.com/abc" });
    assert.deepEqual(await (await post(`${base}/${j}/invite/reset`, {})).json(), { ok: true, link: "https://chat.whatsapp.com/abc" });
  });
  await withServer({ kind: "ok", value: { jid: JID } }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/${encodeURIComponent(JID)}`, { headers: AUTH })).json(), { ok: true, group: { jid: JID } });
  });
  await withServer(OK, async (base) => {
    assert.deepEqual(await (await post(`${base}/${encodeURIComponent(JID)}/leave`, {})).json(), { ok: true });
  });
});

test("outcomes map to statuses and codes with the fixed message unchanged", async () => {
  const cases: [GroupOpOutcome<never>, number, string, string?][] = [
    [{ kind: "session_not_connected" }, 409, "session_not_connected"],
    [{ kind: "group_not_enabled" }, 400, "group_not_enabled"],
    [{ kind: "too_many" }, 400, "too_many"],
    [{ kind: "failed" }, 502, "group_action_failed"],
    [{ kind: "refused", code: "not_admin", message: GROUP_NOT_ADMIN_REASON }, 403, "not_admin", GROUP_NOT_ADMIN_REASON],
    [{ kind: "refused", code: "create_limit", message: groupCreateLimitReason(3) }, 422, "create_limit", groupCreateLimitReason(3)],
    [{ kind: "refused", code: "add_limit", message: GROUP_ADD_LIMIT_REASON }, 422, "add_limit", GROUP_ADD_LIMIT_REASON],
    [{ kind: "refused", code: "warmup", message: GROUP_WARMUP_REASON }, 422, "warmup", GROUP_WARMUP_REASON],
    [{ kind: "refused", code: "needs_member", message: GROUP_NEEDS_MEMBER_REASON }, 422, "needs_member", GROUP_NEEDS_MEMBER_REASON],
    [{ kind: "refused", code: "limits_unavailable", message: "Group limits are unavailable right now. Try again shortly." }, 503, "limits_unavailable"],
  ];
  for (const [outcome, status, code, message] of cases) {
    await withServer(outcome, async (base) => {
      const res = await post(base, { requestId: "req-1", name: "Team", participants: [] });
      assert.equal(res.status, status, code);
      const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error.code, code);
      if (message) assert.equal(body.error.message, message);
      // The same mapping applies to a :jid route.
      const leave = await post(`${base}/${encodeURIComponent(JID)}/leave`, {});
      assert.equal(leave.status, status, code);
    });
  }
});

test("no bearer token is 401 on every group route", async () => {
  await withServer(OK, async (base, calls) => {
    const j = encodeURIComponent(JID);
    for (const [method, path] of [["POST", ""], ["GET", `/${j}`], ["PATCH", `/${j}`], ["POST", `/${j}/participants`], ["GET", `/${j}/invite`], ["POST", `/${j}/invite/reset`], ["POST", `/${j}/leave`]]) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 401, `${method} ${path}`);
    }
    assert.equal(calls.length, 0);
  });
});

test("POST /groups/refresh still reaches refreshEnabledGroups; unknown group sub-routes stay 404", async () => {
  await withServer(OK, async (base, calls) => {
    const res = await post(`${base}/refresh`, {});
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.method), ["refreshEnabledGroups"]);
    assert.equal((await fetch(`${base}/${encodeURIComponent(JID)}/nope`, { headers: AUTH })).status, 404);
  });
});
