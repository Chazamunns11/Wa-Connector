/**
 * Opt-in WhatsApp groups (Task 9): the embed groups route's decision logic
 * (src/app/api/crm/embed/groups/logic.ts). The route lists one number's
 * groups — WhatsApp's LIVE list merged with the stored on/off switches — and
 * switches one group on or off, then asks the bridge to reload.
 *
 * THE TENANT ID IS NEVER RETURNED: every response body is serialised and
 * searched for the fake tenant uuid, the same check as
 * scripts/test/embed-numbers.test.ts. Group JIDs ARE returned — they are
 * WhatsApp's own group ids, and the owner has to pick one.
 *
 * Entirely offline: a fake repo and a fake bridge, no Supabase, no Next.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decideGroupsRequest, type EmbedGroupsDeps, type EmbedGroupsRepo } from "@/app/api/crm/embed/groups/logic";
import type { WhatsappGroup } from "@/lib/types";
import type { BridgeGroup, BridgeGroupsResult, BridgeOkResult } from "@/lib/whatsapp-bridge";

const TENANT = "55555555-eeee-4eee-8eee-555555555555";
const GROUP_A = "120363000000000001@g.us";
const GROUP_B = "120363000000000002@g.us";
const GROUP_LEFT = "120363000000000003@g.us";

const UNKNOWN_GROUP = { ok: false, code: "unknown_group", message: "That WhatsApp group wasn't found on this number." };

function assertNoTenantId(value: unknown, context: string) {
  const json = JSON.stringify(value);
  assert.ok(!json.includes(TENANT), `${context}: response JSON must never contain the tenant id, got ${json}`);
}

function stored(groupJid: string, overrides: Partial<WhatsappGroup> = {}): WhatsappGroup {
  return { tenantId: TENANT, groupJid, name: "stored name", enabled: false, ghlContactId: null, leftAt: null, createdByUs: false, ...overrides };
}

const LIVE: BridgeGroup[] = [
  { jid: GROUP_A, name: "Team chat", size: 12 },
  { jid: GROUP_B, name: "Clients", size: 40 },
];

function fakes(opts: { live?: BridgeGroupsResult; stored?: WhatsappGroup[]; refresh?: BridgeOkResult } = {}) {
  const calls: string[] = [];
  const rows = new Map((opts.stored ?? []).map((g) => [g.groupJid, { ...g }]));
  const repo: EmbedGroupsRepo = {
    async listWhatsappGroups(tenantId: string) {
      calls.push(`stored:${tenantId}`);
      return [...rows.values()].filter((g) => g.tenantId === tenantId);
    },
    async setWhatsappGroupEnabled(tenantId: string, groupJid: string, name: string, enabled: boolean) {
      calls.push(`set:${tenantId}:${groupJid}:${name}:${enabled}`);
      const existing = rows.get(groupJid);
      rows.set(groupJid, {
        ...(existing ?? stored(groupJid)),
        tenantId,
        name,
        enabled,
        leftAt: enabled ? null : (existing?.leftAt ?? null),
      });
    },
  };
  const deps: EmbedGroupsDeps = {
    async listLiveGroups(tenantId: string) {
      calls.push(`live:${tenantId}`);
      return opts.live ?? { ok: true, groups: LIVE };
    },
    async refreshGroups(tenantId: string) {
      calls.push(`refresh:${tenantId}`);
      return opts.refresh ?? { ok: true };
    },
  };
  return { repo, deps, calls, rows };
}

test("groups list: the live list merged with the stored switches — jid, name, size, enabled, left — and no tenant id", async () => {
  const { repo, deps } = fakes({ stored: [stored(GROUP_B, { enabled: true, name: "old name" })] });
  const result = await decideGroupsRequest(repo, deps, TENANT, { slot: 1 });
  assert.deepEqual(result, {
    status: 200,
    body: {
      ok: true,
      groups: [
        { jid: GROUP_A, name: "Team chat", size: 12, enabled: false, left: false, live: true, createdByUs: false },
        { jid: GROUP_B, name: "Clients", size: 40, enabled: true, left: false, live: true, createdByUs: false },
      ],
    },
  });
  assertNoTenantId(result, "list");
});

test("groups list: a stored group the number has left (no longer in the live list) is still shown, marked left", async () => {
  const { repo, deps } = fakes({
    stored: [
      stored(GROUP_LEFT, { enabled: true, name: "Old crew", leftAt: "2026-10-10T00:00:00.000Z" }),
      // A switched-off stored row that is not live and never marked left is noise — not listed.
      stored("120363000000000009@g.us", { enabled: false }),
    ],
  });
  const result = await decideGroupsRequest(repo, deps, TENANT, {});
  assert.equal(result.status, 200);
  const groups = result.body.ok && "groups" in result.body ? result.body.groups : [];
  assert.deepEqual(groups.map((g) => g.jid), [GROUP_A, GROUP_B, GROUP_LEFT]);
  assert.deepEqual(groups[2], { jid: GROUP_LEFT, name: "Old crew", size: 0, enabled: true, left: true, live: false, createdByUs: false });
  assertNoTenantId(result, "list with left");
});

test("groups list: `left` is exactly leftAt !== null — an enabled stored group merely missing from the live list is not-live, not left", async () => {
  const missing = "120363000000000004@g.us";
  const { repo, deps } = fakes({
    stored: [
      stored(missing, { enabled: true, name: "Gone quiet" }),
      // Live, but still carrying an old left mark (rejoined, not yet re-enabled).
      stored(GROUP_A, { enabled: false, leftAt: "2026-10-01T00:00:00.000Z" }),
    ],
  });
  const result = await decideGroupsRequest(repo, deps, TENANT, {});
  const groups = result.body.ok && "groups" in result.body ? result.body.groups : [];
  assert.deepEqual(groups.find((g) => g.jid === missing), { jid: missing, name: "Gone quiet", size: 0, enabled: true, left: false, live: false, createdByUs: false });
  assert.deepEqual(groups.find((g) => g.jid === GROUP_A), { jid: GROUP_A, name: "Team chat", size: 12, enabled: false, left: true, live: true, createdByUs: false });
});

test("groups list: the number isn't connected -> the not-connected shape, fixed message, no bridge text forwarded", async () => {
  const { repo, deps } = fakes({ live: { ok: false, code: "session_not_connected", message: `session ${TENANT} is 'disconnected'` } });
  const result = await decideGroupsRequest(repo, deps, TENANT, {});
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    ok: false,
    code: "session_not_connected",
    message: "This WhatsApp number isn't connected. Connect it to see its groups.",
  });
  assertNoTenantId(result, "not connected");
});

test("groups list: any other bridge failure -> 502 groups_unavailable with a fixed message", async () => {
  const { repo, deps } = fakes({ live: { ok: false, code: "groups_unavailable", message: `boom ${TENANT}` } });
  const result = await decideGroupsRequest(repo, deps, TENANT, {});
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { ok: false, code: "groups_unavailable", message: "Couldn't load this number's WhatsApp groups. Please try again." });
  assertNoTenantId(result, "bridge failure");
});

test("groups list: createdByUs comes from the stored row (live and not-live), false for a group with no row", async () => {
  const gone = "120363000000000009@g.us";
  const { repo, deps } = fakes({
    stored: [stored(GROUP_A, { createdByUs: true }), stored(gone, { enabled: true, createdByUs: true, name: "Made here" })],
  });
  const result = await decideGroupsRequest(repo, deps, TENANT, {});
  const groups = result.body.ok && "groups" in result.body ? result.body.groups : [];
  assert.equal(groups.find((g) => g.jid === GROUP_A)?.createdByUs, true);
  assert.equal(groups.find((g) => g.jid === GROUP_B)?.createdByUs, false);
  assert.equal(groups.find((g) => g.jid === gone)?.createdByUs, true);
  assertNoTenantId(result, "createdByUs list");
});

test("groups toggle: enabling stores the LIVE name (never the client's), then refreshes the bridge for THAT tenant, and returns the merged list", async () => {
  const { repo, deps, calls } = fakes();
  const result = await decideGroupsRequest(repo, deps, TENANT, { slot: 2, groupJid: GROUP_A, enabled: true, name: "client-supplied name" });
  assert.equal(result.status, 200);
  assert.ok(calls.includes(`set:${TENANT}:${GROUP_A}:Team chat:true`), calls.join(", "));
  const setAt = calls.findIndex((c) => c.startsWith("set:"));
  const refreshAt = calls.indexOf(`refresh:${TENANT}`);
  assert.ok(refreshAt > setAt, `refresh must follow the write: ${calls.join(", ")}`);
  const groups = result.body.ok && "groups" in result.body ? result.body.groups : [];
  assert.equal(groups.find((g) => g.jid === GROUP_A)?.enabled, true);
  assertNoTenantId(result, "toggle on");
});

test("groups toggle OFF: never needs the live list — stored name, enabled=false, then a refresh", async () => {
  const { repo, deps, calls } = fakes({ stored: [stored(GROUP_B, { enabled: true, name: "Clients (stored)" })] });
  const result = await decideGroupsRequest(repo, deps, TENANT, { groupJid: GROUP_B, enabled: false });
  assert.deepEqual(result, { status: 200, body: { ok: true, groupJid: GROUP_B, enabled: false } });
  assert.ok(!calls.some((c) => c.startsWith("live:")), `switching off must not read the live list: ${calls.join(", ")}`);
  const setAt = calls.indexOf(`set:${TENANT}:${GROUP_B}:Clients (stored):false`);
  assert.ok(setAt >= 0, calls.join(", "));
  assert.ok(calls.indexOf(`refresh:${TENANT}`) > setAt);
});

test("groups toggle OFF: a stored group the number has LEFT can be switched off (200, stored name, then refresh)", async () => {
  const { repo, deps, calls, rows } = fakes({
    stored: [stored(GROUP_LEFT, { enabled: true, name: "Old crew", leftAt: "2026-10-10T00:00:00.000Z" })],
  });
  const result = await decideGroupsRequest(repo, deps, TENANT, { slot: 1, groupJid: GROUP_LEFT, enabled: false });
  assert.equal(result.status, 200);
  assert.ok(calls.includes(`set:${TENANT}:${GROUP_LEFT}:Old crew:false`), calls.join(", "));
  assert.ok(calls.includes(`refresh:${TENANT}`));
  assert.equal(rows.get(GROUP_LEFT)?.enabled, false);
  assertNoTenantId(result, "off left");
});

test("groups toggle OFF: works while the number is not connected", async () => {
  const { repo, deps, calls } = fakes({
    live: { ok: false, code: "session_not_connected", message: "nope" },
    stored: [stored(GROUP_B, { enabled: true, name: "Clients" })],
  });
  const result = await decideGroupsRequest(repo, deps, TENANT, { groupJid: GROUP_B, enabled: false });
  assert.equal(result.status, 200);
  assert.ok(calls.includes(`set:${TENANT}:${GROUP_B}:Clients:false`));
});

test("groups toggle OFF: a JID neither stored nor live -> 404 unknown_group, nothing written", async () => {
  const { repo, deps, calls } = fakes({ stored: [stored(GROUP_B, { enabled: true })] });
  for (const jid of [GROUP_A, "120363000000000077@g.us"]) {
    const result = await decideGroupsRequest(repo, deps, TENANT, { groupJid: jid, enabled: false });
    assert.deepEqual(result, { status: 404, body: UNKNOWN_GROUP }, jid);
  }
  assert.ok(!calls.some((c) => c.startsWith("set:") || c.startsWith("refresh:") || c.startsWith("live:")), calls.join(", "));
});

test("groups toggle OFF: a failed bridge reload is the same 'Saved, but…' 502", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { repo, deps } = fakes({
    stored: [stored(GROUP_B, { enabled: true })],
    refresh: { ok: false, code: "groups_refresh_failed", message: "x" },
  });
  const result = await decideGroupsRequest(repo, deps, TENANT, { groupJid: GROUP_B, enabled: false });
  assert.equal(result.status, 502);
  assert.equal(!result.body.ok && result.body.code, "groups_refresh_failed");
});

test("groups toggle: a groupJid not in the live list -> 404 unknown_group, nothing written, no refresh", async () => {
  for (const jid of [GROUP_LEFT, "not-a-jid", "120363000000000001@s.whatsapp.net"]) {
    const { repo, deps, calls } = fakes({ stored: [stored(GROUP_LEFT, { enabled: true, leftAt: "2026-10-10T00:00:00.000Z" })] });
    const result = await decideGroupsRequest(repo, deps, TENANT, { groupJid: jid, enabled: true });
    assert.deepEqual(result, { status: 404, body: UNKNOWN_GROUP }, jid);
    assert.ok(!calls.some((c) => c.startsWith("set:") || c.startsWith("refresh:")), calls.join(", "));
  }
});

test("groups toggle: not connected -> the same not-connected shape, nothing written", async () => {
  const { repo, deps, calls } = fakes({ live: { ok: false, code: "session_not_connected", message: "nope" } });
  const result = await decideGroupsRequest(repo, deps, TENANT, { groupJid: GROUP_A, enabled: true });
  assert.equal(result.status, 409);
  assert.equal(!result.body.ok && result.body.code, "session_not_connected");
  assert.ok(!calls.some((c) => c.startsWith("set:")));
});

test("groups toggle: the bridge reload failing -> 502 with a fixed 'try again' message (the switch is saved; a retry re-sends it)", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { repo, deps, rows } = fakes({ refresh: { ok: false, code: "groups_refresh_failed", message: `reload failed for ${TENANT}` } });
  const result = await decideGroupsRequest(repo, deps, TENANT, { groupJid: GROUP_A, enabled: true });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    ok: false,
    code: "groups_refresh_failed",
    message: "Saved, but WhatsApp hasn't picked up the change yet. Please try again.",
  });
  assert.equal(rows.get(GROUP_A)?.enabled, true);
  assertNoTenantId(result, "refresh failure");
  assert.equal(warn.mock.callCount(), 1);
  assertNoTenantId(warn.mock.calls.map((c) => c.arguments), "refresh failure warning");
});

test("groups request: a malformed body, a half toggle, or a non-boolean enabled -> 400 invalid_body", async () => {
  for (const body of [null, { groupJid: GROUP_A }, { enabled: true }, { groupJid: GROUP_A, enabled: "true" }, { groupJid: 42, enabled: true }]) {
    const { repo, deps, calls } = fakes();
    const result = await decideGroupsRequest(repo, deps, TENANT, body as Record<string, unknown> | null);
    assert.deepEqual(result, { status: 400, body: { ok: false, code: "invalid_body", message: "Malformed request." } }, JSON.stringify(body));
    assert.deepEqual(calls, [], "nothing is read or written for a malformed request");
  }
});
