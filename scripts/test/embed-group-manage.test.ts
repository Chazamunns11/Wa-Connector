/**
 * Group management from the GHL embed (Task 8): the manage route's decision
 * logic (src/app/api/crm/embed/groups/manage/logic.ts) and the per-sub-account
 * invite template route (src/app/api/crm/embed/groups/invite-template/logic.ts).
 *
 * THE TENANT ID IS NEVER RETURNED: response bodies are serialised and searched
 * for the fake tenant uuids. Entirely offline: fake repo, fake bridge, fake GHL.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideGroupManageRequest,
  manageSlotFromBody,
  MSG_LAST_ADMIN,
  MSG_NO_RESPONSE,
  MSG_OFFLINE,
  MSG_SELF,
  type GroupManageContext,
  type GroupManageDeps,
  type GroupManageRepo,
} from "@/app/api/crm/embed/groups/manage/logic";
import { decideInviteTemplateRequest, type InviteTemplateRepo } from "@/app/api/crm/embed/groups/invite-template/logic";
import { DEFAULT_GROUP_INVITE_TEMPLATE, INVITE_TEMPLATE_MISSING_LINK, type Invitee, type SendGroupInvitesResult } from "@/lib/group-invites";
import type { GhlContactLite } from "@/lib/ghl";
import type { GhlAccount, WhatsappGroup } from "@/lib/types";
import type { BridgeFailure } from "@/lib/whatsapp-bridge";

const TENANT = "77777777-aaaa-4aaa-8aaa-777777777777";
const OTHER_TENANT = "88888888-bbbb-4bbb-8bbb-888888888888";
const GROUP = "120363000000000001@g.us";
const OTHER_GROUP = "120363000000000002@g.us";
const LINK = "https://chat.whatsapp.com/AbC123xyz0";
const PHONE_A = "+447700900001";
const PHONE_B = "+447700900002";
const PHONE_C = "+447700900003";
const MEMBER = "447700900001@s.whatsapp.net";
const OUR_MEMBER = "447700900999@s.whatsapp.net";

const ACCOUNT = {
  locationId: "loc-1",
  tenantId: OTHER_TENANT,
  label: "Acme Fitness",
  conversationProviderId: null,
  status: "active",
} as unknown as GhlAccount;

const CTX: GroupManageContext = { tenantId: TENANT, account: ACCOUNT, slotLabel: "Coach Sam" };

const LIMIT_MSG = "This number has created its 3 groups for today. Try again tomorrow.";
const WARMUP_MSG = "New numbers can't create groups during their first 14 days.";
const NEEDS_MEMBER_MSG = "Add at least one person who has messaged this number before, then invite the rest by link.";
const NOT_ADMIN_MSG = "This number isn't an admin of that group.";

function assertNoTenantId(value: unknown, context: string) {
  const json = JSON.stringify(value);
  assert.ok(!json.includes(TENANT) && !json.includes(OTHER_TENANT), `${context}: response must never contain a tenant id, got ${json}`);
}

function assertNoPhones(value: unknown, context: string) {
  const json = JSON.stringify(value);
  for (const p of [PHONE_A, PHONE_B, PHONE_C, "07700900"]) assert.ok(!json.includes(p), `${context}: response must never contain a phone, got ${json}`);
}

function row(tenantId: string, groupJid: string, over: Partial<WhatsappGroup> = {}): WhatsappGroup {
  return { tenantId, groupJid, name: "Spring Cohort", enabled: true, ghlContactId: null, leftAt: null, createdByUs: true, ...over };
}

const INVITEES: Invitee[] = [
  { contactId: "c-a", firstName: "Ann", phone: PHONE_A },
  { contactId: "c-b", firstName: "Bob", phone: PHONE_B },
  { contactId: "c-c", firstName: "Cat", phone: PHONE_C },
];

const NO_SEND: SendGroupInvitesResult = { added: [], alreadyMember: [], sent: 0, held: 0, refused: [], delivered: [] };

type Over = Partial<GroupManageDeps> & { groups?: WhatsappGroup[]; recordThrows?: boolean; inbound?: string[] };

function fakes(over: Over = {}) {
  const calls: string[] = [];
  // GROUP is stored as a synced group this app did not create, so a create returning GROUP is not a replay.
  const groups = (over.groups ?? [row(TENANT, GROUP, { createdByUs: false }), row(OTHER_TENANT, OTHER_GROUP)]).map((g) => ({ ...g }));
  const posts: { contactId: string; message: string; conversationProviderId: string }[] = [];
  const sendInputs: { invitees: Invitee[]; coachName: string; tenantId: string; directAdd: boolean }[] = [];
  const repo: GroupManageRepo = {
    async listWhatsappGroups(tenantId) {
      calls.push(`list:${tenantId}`);
      return groups.filter((g) => g.tenantId === tenantId);
    },
    async recordCreatedWhatsappGroup(tenantId, groupJid, name) {
      calls.push(`record:${tenantId}:${groupJid}:${name}`);
      if (over.recordThrows) throw new Error("db down");
      groups.push(row(tenantId, groupJid, { name }));
    },
    async renameWhatsappGroup(tenantId, groupJid, name) {
      calls.push(`rename:${tenantId}:${groupJid}:${name}`);
    },
    async markWhatsappGroupLeft(tenantId, groupJid) {
      calls.push(`markLeft:${tenantId}:${groupJid}`);
    },
    async hasInboundFromPhone(tenantId, phone) {
      calls.push(`inbound:${tenantId}`);
      return (over.inbound ?? [PHONE_A]).includes(phone);
    },
  };
  const bridgeOk = { ok: true as const };
  const deps: GroupManageDeps = {
    createGroup: async (tenantId, input) => {
      calls.push(`create:${tenantId}:${input.requestId}:${input.participants.length}`);
      return { ok: true, jid: GROUP, name: input.name, addedPhone: null, path: "empty" };
    },
    getDetail: async (tenantId, jid) => {
      calls.push(`detail:${tenantId}:${jid}`);
      return {
        ok: true,
        group: {
          jid,
          name: "Spring Cohort",
          description: null,
          announcement: false,
          approval: true,
          weAreAdmin: true,
          members: [
            { memberId: OUR_MEMBER, phone: "+447700900999", admin: "superadmin", isUs: true },
            { memberId: MEMBER, phone: null, admin: null, isUs: false },
          ],
        },
      };
    },
    updateGroup: async (tenantId, jid) => {
      calls.push(`update:${tenantId}:${jid}`);
      return bridgeOk;
    },
    updateParticipants: async (tenantId, jid, req) => {
      calls.push(`participants:${tenantId}:${jid}:${req.action}`);
      return { ok: true, results: [] };
    },
    getInvite: async (tenantId, jid) => {
      calls.push(`invite:${tenantId}:${jid}`);
      return { ok: true, link: LINK };
    },
    resetInvite: async (tenantId, jid) => {
      calls.push(`reset:${tenantId}:${jid}`);
      return { ok: true, link: LINK };
    },
    leaveGroup: async (tenantId, jid) => {
      calls.push(`leave:${tenantId}:${jid}`);
      return bridgeOk;
    },
    refreshGroups: async (tenantId) => {
      calls.push(`refresh:${tenantId}`);
      return bridgeOk;
    },
    resolveAccessToken: async () => "tok",
    resolveInvitees: async (input) => {
      calls.push(`resolve:${input.tenantId}`);
      return { ok: true, invitees: INVITEES, skipped: [{ contactId: "c-x", name: "Xena", reason: "no_phone" }], truncated: false };
    },
    sendInvites: async (input) => {
      calls.push(`send:${input.tenantId}`);
      sendInputs.push({ invitees: input.invitees, coachName: input.coachName, tenantId: input.tenantId, directAdd: input.directAdd });
      return NO_SEND;
    },
    searchContacts: async () => ({ ok: true, contacts: [], truncated: false }),
    optedOutReason: async () => null,
    postOutboundMessage: async (_token, input) => {
      posts.push(input);
      return { ok: true };
    },
    envConversationProviderId: "prov-1",
    ...over,
  };
  return { repo, deps, calls, posts, sendInputs, groups };
}

const refusal = (code: string, message: string): BridgeFailure => ({ ok: false, code, message });
const createBody = (over: Record<string, unknown> = {}) => ({ slot: 2, action: "create", requestId: "req_12345678", name: "Spring Cohort", ...over });
const bridgeTouched = (calls: string[]) =>
  calls.filter((c) => /^(detail|update|participants|invite|reset|leave|refresh|create|send):/.test(c));

// ---------------------------------------------------------------------------
// No tenant id anywhere
// ---------------------------------------------------------------------------

test("no tenant id anywhere: every action's response JSON is free of tenant ids", async () => {
  const bodies: Record<string, unknown>[] = [
    createBody({ contactIds: ["c-a"] }),
    { action: "search_contacts", text: "ann" },
    { action: "detail", groupJid: GROUP },
    { action: "update", groupJid: GROUP, name: "New" },
    { action: "participants", groupJid: GROUP, change: "remove", memberIds: [MEMBER] },
    { action: "invite_link", groupJid: GROUP },
    { action: "invite_reset", groupJid: GROUP },
    { action: "leave", groupJid: GROUP },
    { action: "invite", groupJid: GROUP, contactIds: ["c-a"] },
    { action: "detail", groupJid: OTHER_GROUP },
    { action: "nope" },
  ];
  for (const body of bodies) {
    const { repo, deps } = fakes();
    const result = await decideGroupManageRequest(repo, deps, CTX, body);
    assertNoTenantId(result, String(body.action));
  }
  for (const failure of [refusal("create_limit", LIMIT_MSG), refusal("session_not_connected", `session ${TENANT} offline`), refusal("timeout", `bridge for ${TENANT}`)]) {
    const { repo, deps } = fakes({ createGroup: async () => failure });
    assertNoTenantId(await decideGroupManageRequest(repo, deps, CTX, createBody()), `create ${failure.code}`);
  }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test("create: the group is enabled and synced — recordCreatedWhatsappGroup then refreshWhatsappGroups for the slot's tenant", async () => {
  const { repo, deps, calls } = fakes();
  const result = await decideGroupManageRequest(repo, deps, CTX, createBody({ description: "Spring intake" }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    group: { jid: GROUP, name: "Spring Cohort" },
    invites: { added: [], alreadyMember: [], sent: [], held: [], refused: [], skipped: [], truncated: false },
  });
  const recordAt = calls.indexOf(`record:${TENANT}:${GROUP}:Spring Cohort`);
  const refreshAt = calls.indexOf(`refresh:${TENANT}`);
  assert.ok(recordAt >= 0 && refreshAt > recordAt, calls.join(", "));
  assert.ok(calls.includes(`create:${TENANT}:req_12345678:0`), calls.join(", "));
  assert.ok(!calls.some((c) => c.includes(OTHER_TENANT)), calls.join(", "));
  assertNoTenantId(result, "create");
});

test("create: invitees' phones go to the bridge as fallback candidates; the first member is 'added', everyone else is invited", async () => {
  const { repo, deps, calls, sendInputs } = fakes({
    createGroup: async (tenantId, input) => {
      calls.push(`create:${tenantId}:${input.participants.join("|")}`);
      return { ok: true, jid: GROUP, name: input.name, addedPhone: PHONE_A, path: "with_member" };
    },
  });
  const result = await decideGroupManageRequest(repo, deps, CTX, createBody({ contactIds: ["c-a", "c-b", "c-c"], directAdd: true }));
  assert.equal(result.status, 200);
  assert.ok(calls.includes(`create:${TENANT}:${PHONE_A}|${PHONE_B}|${PHONE_C}`), calls.join(", "));
  assert.deepEqual(
    sendInputs[0].invitees.map((i) => i.contactId),
    ["c-b", "c-c"]
  );
  assert.equal(sendInputs[0].tenantId, TENANT);
  assert.equal(sendInputs[0].directAdd, true);
  assert.equal(sendInputs[0].coachName, "Coach Sam");
  const invites = (result.body as { invites: { added: string[]; skipped: unknown[] } }).invites;
  assert.deepEqual(invites.added, ["c-a"]);
  assert.deepEqual(invites.skipped, [{ contactId: "c-x", name: "Xena", reason: "no_phone" }]);
  assertNoPhones(result, "create with invitees");
  assertNoTenantId(result, "create with invitees");
});

test("create: coachName falls back to the sub-account label, then 'your coach'", async () => {
  for (const [ctx, expected] of [
    [{ ...CTX, slotLabel: null }, "Acme Fitness"],
    [{ ...CTX, slotLabel: "  ", account: { ...ACCOUNT, label: "" } as GhlAccount }, "your coach"],
  ] as const) {
    const { repo, deps, sendInputs } = fakes();
    await decideGroupManageRequest(repo, deps, ctx, createBody({ tag: "spring" }));
    assert.equal(sendInputs[0].coachName, expected);
  }
});

test("create: limit/warm-up/needs_member messages are passed through verbatim with status 422; not_admin 403; limits_unavailable 503", async () => {
  for (const [code, message, status] of [
    ["create_limit", LIMIT_MSG, 422],
    ["warmup", WARMUP_MSG, 422],
    ["needs_member", NEEDS_MEMBER_MSG, 422],
    ["limits_unavailable", "Group limits couldn't be checked. Try again shortly.", 503],
  ] as const) {
    const { repo, deps, calls } = fakes({ createGroup: async () => refusal(code, message) });
    const result = await decideGroupManageRequest(repo, deps, CTX, createBody());
    assert.equal(result.status, status, code);
    assert.deepEqual(result.body, { ok: false, code, message });
    assert.ok(!calls.some((c) => c.startsWith("record:") || c.startsWith("refresh:")), calls.join(", "));
  }
});

test("create: offline is 409 with the fixed string; an unknown failure is 502 with mayExist; too_many is 400", async (t) => {
  t.mock.method(console, "warn", () => {});
  {
    const { repo, deps } = fakes({ createGroup: async () => refusal("session_not_connected", "bridge text") });
    const result = await decideGroupManageRequest(repo, deps, CTX, createBody());
    assert.deepEqual(result, { status: 409, body: { ok: false, code: "session_not_connected", message: MSG_OFFLINE } });
  }
  {
    const { repo, deps } = fakes({ createGroup: async () => refusal("timeout", "bridge text") });
    const result = await decideGroupManageRequest(repo, deps, CTX, createBody());
    assert.deepEqual(result, { status: 502, body: { ok: false, code: "bridge_unavailable", message: MSG_NO_RESPONSE, mayExist: true } });
  }
  {
    const { repo, deps } = fakes({ createGroup: async () => refusal("too_many", "bridge text") });
    const result = await decideGroupManageRequest(repo, deps, CTX, createBody());
    assert.equal(result.status, 400);
    assert.equal((result.body as { code: string }).code, "too_many");
  }
});

test("create: a replayed create (same requestId, same jid from the bridge) never re-sends invites or re-posts to GHL", async () => {
  const accepted: SendGroupInvitesResult = { ...NO_SEND, sent: 1, delivered: [{ contactId: "c-b", text: "t", outcome: "accepted" }] };
  let sends = 0;
  // Only the new group is pre-seeded elsewhere; start with no stored row for it.
  const { repo, deps, calls, posts } = fakes({
    groups: [row(OTHER_TENANT, OTHER_GROUP)],
    sendInvites: async () => {
      sends += 1;
      return accepted;
    },
  });
  const body = createBody({ contactIds: ["c-a", "c-b"] });
  const first = await decideGroupManageRequest(repo, deps, CTX, body);
  const second = await decideGroupManageRequest(repo, deps, CTX, body);
  assert.equal(first.status, 200);
  assert.ok(!("replayed" in first.body));
  assert.equal(sends, 1);
  assert.equal(posts.length, 1);
  assert.equal(calls.filter((c) => c.startsWith("record:")).length, 1);
  assert.deepEqual(second, {
    status: 200,
    body: {
      ok: true,
      group: { jid: GROUP, name: "Spring Cohort" },
      invites: { added: [], alreadyMember: [], sent: [], held: [], refused: [], skipped: [], truncated: false },
      replayed: true,
    },
  });
  assertNoTenantId(second, "replayed create");
});

test("create: a group created on WhatsApp but not recorded still answers ok with the group", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const { repo, deps, calls } = fakes({ recordThrows: true });
  const result = await decideGroupManageRequest(repo, deps, CTX, createBody());
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { group: unknown }).group, { jid: GROUP, name: "Spring Cohort" });
  assert.ok(!calls.includes(`refresh:${TENANT}`));
  assert.equal(errors.mock.callCount(), 1);
  assert.ok(!JSON.stringify(errors.mock.calls[0].arguments).includes(GROUP));
});

test("create: a failed reload after create still answers ok", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { repo, deps } = fakes({ refreshGroups: async () => refusal("timeout", "x") });
  const result = await decideGroupManageRequest(repo, deps, CTX, createBody());
  assert.equal(result.status, 200);
});

test("create: validation — requestId pattern, name 1-100 code points, description 512, contactIds at most 100; nothing reaches the bridge", async () => {
  const bad: Record<string, unknown>[] = [
    createBody({ requestId: "short" }),
    createBody({ requestId: "has space in it" }),
    createBody({ requestId: "x".repeat(65) }),
    createBody({ name: "   " }),
    createBody({ name: "😀".repeat(101) }),
    createBody({ description: "😀".repeat(513) }),
    createBody({ contactIds: Array.from({ length: 101 }, (_, i) => `c${i}`) }),
    createBody({ contactIds: ["ok", 5] }),
    createBody({ directAdd: "yes" }),
  ];
  for (const body of bad) {
    const { repo, deps, calls } = fakes();
    const result = await decideGroupManageRequest(repo, deps, CTX, body);
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(bridgeTouched(calls), []);
  }
  // 100 emoji is 100 code points: allowed.
  const { repo, deps } = fakes();
  assert.equal((await decideGroupManageRequest(repo, deps, CTX, createBody({ name: "😀".repeat(100) }))).status, 200);
});

test("create: GHL not connected refuses before the group is created", async () => {
  const { repo, deps, calls } = fakes({ resolveAccessToken: async () => null });
  const result = await decideGroupManageRequest(repo, deps, CTX, createBody({ contactIds: ["c-a"] }));
  assert.equal(result.status, 409);
  assert.equal((result.body as { code: string }).code, "ghl_not_connected");
  assert.deepEqual(bridgeTouched(calls), []);
});

// ---------------------------------------------------------------------------
// Invites appear in GHL
// ---------------------------------------------------------------------------

const MIXED: SendGroupInvitesResult = {
  added: ["c-add"],
  alreadyMember: ["c-mem"],
  sent: 2,
  held: 1,
  refused: [{ contactId: "c-ref", reason: "This contact has opted out." }],
  delivered: [
    { contactId: "c-a", text: "Hi Ann, join: " + LINK, outcome: "accepted" },
    { contactId: "c-b", text: "Hi Bob, join: " + LINK, outcome: "pending_retry" },
    { contactId: "c-c", text: "Hi Cat, join: " + LINK, outcome: "held" },
  ],
};

test("invites in GHL: only accepted invites are posted, once each, with the provider id; the response lists every outcome", async () => {
  const { repo, deps, posts } = fakes({ sendInvites: async () => MIXED });
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "invite", groupJid: GROUP, contactIds: ["c-a", "c-b", "c-c"] });
  assert.equal(result.status, 200);
  assert.deepEqual(posts, [{ contactId: "c-a", message: "Hi Ann, join: " + LINK, conversationProviderId: "prov-1" }]);
  assert.deepEqual(result.body, {
    ok: true,
    groupJid: GROUP,
    invites: {
      added: ["c-add"],
      alreadyMember: ["c-mem"],
      sent: ["c-a", "c-b"],
      held: ["c-c"],
      refused: [{ contactId: "c-ref", reason: "This contact has opted out." }],
      skipped: [{ contactId: "c-x", name: "Xena", reason: "no_phone" }],
      truncated: false,
    },
  });
  assertNoTenantId(result, "invite");
  assertNoPhones(result, "invite");
});

test("invites in GHL: the account's own provider id wins over the env one", async () => {
  const { repo, deps, posts } = fakes({ sendInvites: async () => MIXED });
  const ctx = { ...CTX, account: { ...ACCOUNT, conversationProviderId: "prov-own" } as GhlAccount };
  await decideGroupManageRequest(repo, deps, ctx, { action: "invite", groupJid: GROUP, tag: "spring" });
  assert.deepEqual(posts.map((p) => p.conversationProviderId), ["prov-own"]);
});

test("invites in GHL: a failed or throwing GHL post never fails or changes the invite result, and logs a fixed string only", async (t) => {
  const warns = t.mock.method(console, "warn", () => {});
  const accepted: SendGroupInvitesResult = {
    ...NO_SEND,
    sent: 2,
    delivered: [
      { contactId: "c-a", text: "secret text", outcome: "accepted" },
      { contactId: "c-b", text: "secret text", outcome: "accepted" },
    ],
  };
  let n = 0;
  const { repo, deps } = fakes({
    sendInvites: async () => accepted,
    postOutboundMessage: async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 422 };
      throw new Error("boom");
    },
  });
  const result = await decideGroupManageRequest(repo, deps, CTX, createBody({ contactIds: ["c-a", "c-b"] }));
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { invites: { sent: string[] } }).invites.sent, ["c-a", "c-b"]);
  assert.equal(n, 2);
  const logged = JSON.stringify(warns.mock.calls.map((c) => c.arguments));
  assert.ok(logged.includes("HTTP 422"), logged);
  for (const secret of ["secret text", "c-a", "c-b", GROUP, TENANT]) assert.ok(!logged.includes(secret), logged);
});

test("invites in GHL: nothing is posted for refused, skipped, held or pending-retry invitees", async () => {
  const none: SendGroupInvitesResult = {
    added: ["c-add"],
    alreadyMember: [],
    sent: 1,
    held: 1,
    refused: [{ contactId: "c-ref", reason: "x" }],
    delivered: [
      { contactId: "c-b", text: "t", outcome: "pending_retry" },
      { contactId: "c-c", text: "t", outcome: "held" },
    ],
  };
  const { repo, deps, posts } = fakes({ sendInvites: async () => none });
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "invite", groupJid: GROUP, contactIds: ["c-a"] });
  assert.equal(result.status, 200);
  assert.deepEqual(posts, []);
});

test("invite: needs contacts or a tag; a lookup failure is a fixed 502", async () => {
  {
    const { repo, deps, calls } = fakes();
    const result = await decideGroupManageRequest(repo, deps, CTX, { action: "invite", groupJid: GROUP });
    assert.equal(result.status, 400);
    assert.ok(!calls.some((c) => c.startsWith("send:")));
  }
  {
    const { repo, deps } = fakes({ resolveInvitees: async () => ({ ok: false, message: "Couldn't read those contacts from GoHighLevel — try again" }) });
    const result = await decideGroupManageRequest(repo, deps, CTX, { action: "invite", groupJid: GROUP, tag: "x" });
    assert.equal(result.status, 502);
    assert.equal((result.body as { code: string }).code, "invitee_lookup_failed");
  }
});

// ---------------------------------------------------------------------------
// Search contacts
// ---------------------------------------------------------------------------

test("search_contacts: canAddDirectly = has a phone, has messaged this number, and not opted out; never returns phones; group contacts left out", async () => {
  const contacts: GhlContactLite[] = [
    { id: "c-a", firstName: "Ann", name: "Ann A", phone: "07700 900001", tags: [] },
    { id: "c-b", firstName: "Bob", name: "Bob B", phone: PHONE_B, tags: [] },
    { id: "c-c", firstName: "Cat", name: "Cat C", phone: PHONE_C, tags: [] },
    { id: "c-n", firstName: "Nia", name: "Nia N", phone: null, tags: [] },
    { id: "c-g", firstName: null, name: "Group", phone: null, tags: ["whatsapp-group"] },
  ];
  const queries: unknown[] = [];
  const { repo, deps, calls } = fakes({
    inbound: [PHONE_A, PHONE_C],
    searchContacts: async (_t, locationId, query, limit) => {
      queries.push({ locationId, query, limit });
      return { ok: true, contacts, truncated: false };
    },
    optedOutReason: async (_l, _t, phone) => (phone === PHONE_C ? "opted out" : null),
  });
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "search_contacts", text: " ann " });
  assert.deepEqual(queries, [{ locationId: "loc-1", query: { text: "ann" }, limit: 25 }]);
  assert.deepEqual(result, {
    status: 200,
    body: {
      ok: true,
      contacts: [
        { id: "c-a", name: "Ann A", hasPhone: true, canAddDirectly: true },
        { id: "c-b", name: "Bob B", hasPhone: true, canAddDirectly: false },
        { id: "c-c", name: "Cat C", hasPhone: true, canAddDirectly: false },
        { id: "c-n", name: "Nia N", hasPhone: false, canAddDirectly: false },
      ],
      truncated: false,
    },
  });
  assert.ok(calls.every((c) => !c.startsWith("inbound:") || c === `inbound:${TENANT}`));
  assertNoPhones(result, "search");
});

// ---------------------------------------------------------------------------
// Managing an existing group
// ---------------------------------------------------------------------------

test("manage: a group not enabled on this number is 404 unknown_group and the bridge is never called", async () => {
  const actions = ["detail", "update", "participants", "invite_link", "invite_reset", "leave", "invite"];
  for (const groups of [
    // Another number's enabled group, same location.
    [row(TENANT, GROUP), row(OTHER_TENANT, OTHER_GROUP)],
    // Stored on this number but switched off.
    [row(TENANT, OTHER_GROUP, { enabled: false })],
  ]) {
    for (const action of actions) {
      const { repo, deps, calls } = fakes({ groups });
      const result = await decideGroupManageRequest(repo, deps, CTX, {
        action,
        groupJid: OTHER_GROUP,
        name: "x",
        change: "remove",
        memberIds: [MEMBER],
        contactIds: ["c-a"],
      });
      assert.deepEqual(result, { status: 404, body: { ok: false, code: "unknown_group", message: "That WhatsApp group wasn't found on this number." } }, action);
      assert.deepEqual(bridgeTouched(calls), [], action);
    }
  }
});

test("manage: a group this number has left is 404 unknown_group and the bridge is never called", async () => {
  for (const action of ["detail", "update", "participants", "invite_link", "invite_reset", "leave", "invite"]) {
    const { repo, deps, calls } = fakes({ groups: [row(TENANT, GROUP, { leftAt: "2026-10-16T10:00:00Z" })] });
    const result = await decideGroupManageRequest(repo, deps, CTX, {
      action,
      groupJid: GROUP,
      name: "x",
      change: "remove",
      memberIds: [MEMBER],
      contactIds: ["c-a"],
    });
    assert.deepEqual(result, { status: 404, body: { ok: false, code: "unknown_group", message: "That WhatsApp group wasn't found on this number." } }, action);
    assert.deepEqual(bridgeTouched(calls), [], action);
  }
});

test("manage: a malformed or oversized body (null) is guarded as slot 1 and answered 400 invalid_body, not invalid_slot", async () => {
  assert.deepEqual(manageSlotFromBody(null), { ok: true, slot: 1 });
  assert.deepEqual(manageSlotFromBody({ slot: 2 }), { ok: true, slot: 2 });
  assert.deepEqual(manageSlotFromBody({ slot: 7 }), { ok: false });
  const { repo, deps, calls } = fakes();
  assert.deepEqual(await decideGroupManageRequest(repo, deps, CTX, null), {
    status: 400,
    body: { ok: false, code: "invalid_body", message: "Malformed request." },
  });
  assert.deepEqual(calls, []);
});

test("manage: a malformed groupJid is 400 and nothing is read", async () => {
  const { repo, deps, calls } = fakes();
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "detail", groupJid: "not-a-group@s.whatsapp.net" });
  assert.equal(result.status, 400);
  assert.deepEqual(calls, []);
});

test("manage: not_admin → 403 with \"This number isn't an admin of that group.\"", async () => {
  const { repo, deps } = fakes({ updateGroup: async () => refusal("not_admin", NOT_ADMIN_MSG) });
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "update", groupJid: GROUP, announcement: true });
  assert.deepEqual(result, { status: 403, body: { ok: false, code: "not_admin", message: NOT_ADMIN_MSG } });
});

test("detail: the bridge's view, fields listed (member phones included, tenant never)", async () => {
  const { repo, deps } = fakes();
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "detail", groupJid: GROUP });
  assert.deepEqual(result.body, {
    ok: true,
    group: {
      jid: GROUP,
      name: "Spring Cohort",
      description: null,
      announcement: false,
      approval: true,
      weAreAdmin: true,
      members: [
        { memberId: OUR_MEMBER, phone: "+447700900999", admin: "superadmin", isUs: true },
        { memberId: MEMBER, phone: null, admin: null, isUs: false },
      ],
    },
  });
});

test("update: a successful rename also renames the stored row; settings-only updates don't", async () => {
  {
    const { repo, deps, calls } = fakes();
    const result = await decideGroupManageRequest(repo, deps, CTX, { action: "update", groupJid: GROUP, name: "  Summer  " });
    assert.deepEqual(result, { status: 200, body: { ok: true, groupJid: GROUP } });
    assert.ok(calls.includes(`rename:${TENANT}:${GROUP}:Summer`), calls.join(", "));
  }
  {
    const { repo, deps, calls } = fakes();
    await decideGroupManageRequest(repo, deps, CTX, { action: "update", groupJid: GROUP, approval: false });
    assert.ok(!calls.some((c) => c.startsWith("rename:")));
  }
  {
    const { repo, deps, calls } = fakes({ updateGroup: async () => refusal("timeout", "x") });
    const prev = console.warn;
    console.warn = () => {};
    try {
      const result = await decideGroupManageRequest(repo, deps, CTX, { action: "update", groupJid: GROUP, name: "Summer" });
      assert.equal(result.status, 502);
      assert.ok(!("mayExist" in result.body));
    } finally {
      console.warn = prev;
    }
    assert.ok(!calls.some((c) => c.startsWith("rename:")));
  }
  {
    const { repo, deps, calls } = fakes();
    const result = await decideGroupManageRequest(repo, deps, CTX, { action: "update", groupJid: GROUP });
    assert.equal(result.status, 400);
    assert.ok(!calls.some((c) => c.startsWith("update:")));
  }
});

test("participants: self and last-admin results surface as the fixed strings", async () => {
  const OTHER_MEMBER = "447700900002@lid";
  const { repo, deps, calls } = fakes({
    updateParticipants: async (tenantId, jid, req) => {
      calls.push(`participants:${tenantId}:${jid}:${req.action}`);
      return {
        ok: true,
        results: [
          { memberId: OUR_MEMBER, result: "self" },
          { memberId: MEMBER, result: "last_admin" },
          { memberId: OTHER_MEMBER, result: "ok" },
        ],
      };
    },
  });
  const result = await decideGroupManageRequest(repo, deps, CTX, {
    action: "participants",
    groupJid: GROUP,
    change: "demote",
    memberIds: [OUR_MEMBER, MEMBER, OTHER_MEMBER],
  });
  assert.ok(calls.includes(`participants:${TENANT}:${GROUP}:demote`));
  assert.deepEqual(result.body, {
    ok: true,
    groupJid: GROUP,
    results: [
      { memberId: OUR_MEMBER, result: "self", message: MSG_SELF },
      { memberId: MEMBER, result: "last_admin", message: MSG_LAST_ADMIN },
      { memberId: OTHER_MEMBER, result: "ok", message: null },
    ],
  });
  assert.equal(MSG_SELF, "You can't remove this WhatsApp number from the group. Use Leave instead.");
  assert.equal(MSG_LAST_ADMIN, "You can't remove the group's last admin.");
});

test("participants: only remove/promote/demote by member id; adds and phones are refused", async () => {
  for (const body of [
    { change: "add", memberIds: [MEMBER] },
    { change: "remove", memberIds: [PHONE_A] },
    { change: "remove", memberIds: [] },
    { change: "remove" },
  ]) {
    const { repo, deps, calls } = fakes();
    const result = await decideGroupManageRequest(repo, deps, CTX, { action: "participants", groupJid: GROUP, ...body });
    assert.equal(result.status, 400);
    assert.deepEqual(bridgeTouched(calls), []);
  }
});

test("invite_link and invite_reset: the link for this tenant's group", async () => {
  for (const action of ["invite_link", "invite_reset"]) {
    const { repo, deps, calls } = fakes();
    const result = await decideGroupManageRequest(repo, deps, CTX, { action, groupJid: GROUP });
    assert.deepEqual(result, { status: 200, body: { ok: true, groupJid: GROUP, link: LINK } });
    assert.ok(calls.includes(`${action === "invite_link" ? "invite" : "reset"}:${TENANT}:${GROUP}`));
  }
});

test("leave: marks left and refreshes", async () => {
  const { repo, deps, calls } = fakes();
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "leave", groupJid: GROUP });
  assert.deepEqual(result, { status: 200, body: { ok: true, groupJid: GROUP, left: true } });
  const leaveAt = calls.indexOf(`leave:${TENANT}:${GROUP}`);
  const markAt = calls.indexOf(`markLeft:${TENANT}:${GROUP}`);
  const refreshAt = calls.indexOf(`refresh:${TENANT}`);
  assert.ok(leaveAt >= 0 && markAt > leaveAt && refreshAt > markAt, calls.join(", "));
});

test("leave: a bridge failure doesn't mark the group left", async () => {
  const { repo, deps, calls } = fakes({ leaveGroup: async () => refusal("session_not_connected", "x") });
  const result = await decideGroupManageRequest(repo, deps, CTX, { action: "leave", groupJid: GROUP });
  assert.equal(result.status, 409);
  assert.ok(!calls.some((c) => c.startsWith("markLeft:")));
});

test("manage: an unknown action or a malformed body is 400", async () => {
  const { repo, deps } = fakes();
  assert.equal((await decideGroupManageRequest(repo, deps, CTX, null)).status, 400);
  assert.equal((await decideGroupManageRequest(repo, deps, CTX, {})).status, 400);
  assert.equal((await decideGroupManageRequest(repo, deps, CTX, { action: "delete_group" })).status, 400);
});

// ---------------------------------------------------------------------------
// Invite template (per sub-account)
// ---------------------------------------------------------------------------

function templateRepo(initial: Record<string, string | null> = {}) {
  const store = new Map<string, string | null>(Object.entries(initial));
  const repo: InviteTemplateRepo = {
    async getGhlAccountByLocationId(locationId) {
      return store.has(locationId) ? ({ locationId } as GhlAccount) : null;
    },
    async getGroupInviteTemplate(locationId) {
      return store.get(locationId) ?? null;
    },
    async setGroupInviteTemplate(locationId, template) {
      if (store.has(locationId)) store.set(locationId, template);
    },
  };
  return { repo, store };
}

test("invite-template: an empty body reads it (the default when none is saved)", async () => {
  const { repo } = templateRepo({ "loc-1": null, "loc-2": "Join {link}" });
  assert.deepEqual(await decideInviteTemplateRequest(repo, "loc-1", {}), {
    status: 200,
    body: { ok: true, template: DEFAULT_GROUP_INVITE_TEMPLATE, isDefault: true },
  });
  assert.deepEqual(await decideInviteTemplateRequest(repo, "loc-2", {}), { status: 200, body: { ok: true, template: "Join {link}", isDefault: false } });
});

test("invite-template: missing {link} refused verbatim; null resets; one sub-account's template never changes another's", async () => {
  const { repo, store } = templateRepo({ "loc-1": null, "loc-2": "Other {link}" });
  assert.deepEqual(await decideInviteTemplateRequest(repo, "loc-1", { template: "Hi {first_name}, join us" }), {
    status: 400,
    body: { ok: false, code: "invalid_template", message: INVITE_TEMPLATE_MISSING_LINK },
  });
  assert.equal(INVITE_TEMPLATE_MISSING_LINK, "The invite message must include {link}.");
  assert.equal(store.get("loc-1"), null);

  assert.deepEqual(await decideInviteTemplateRequest(repo, "loc-1", { template: "  Hey {first_name}: {link}  " }), {
    status: 200,
    body: { ok: true, template: "Hey {first_name}: {link}", isDefault: false },
  });
  assert.equal(store.get("loc-1"), "Hey {first_name}: {link}");
  assert.equal(store.get("loc-2"), "Other {link}");

  assert.deepEqual(await decideInviteTemplateRequest(repo, "loc-1", { template: null }), {
    status: 200,
    body: { ok: true, template: DEFAULT_GROUP_INVITE_TEMPLATE, isDefault: true },
  });
  assert.equal(store.get("loc-1"), null);
  assert.equal(store.get("loc-2"), "Other {link}");
});

test("invite-template: too long is refused; a malformed body is 400; a missing account row is 404 and nothing is written", async () => {
  const { repo, store } = templateRepo({ "loc-1": null });
  const tooLong = await decideInviteTemplateRequest(repo, "loc-1", { template: "{link}" + "😀".repeat(495) });
  assert.equal(tooLong.status, 400);
  assert.equal((await decideInviteTemplateRequest(repo, "loc-1", { template: "{link}" + "😀".repeat(494) })).status, 200);
  assert.equal((await decideInviteTemplateRequest(repo, "loc-1", null)).status, 400);
  assert.equal((await decideInviteTemplateRequest(repo, "loc-1", { template: 5 })).status, 400);
  const missing = await decideInviteTemplateRequest(repo, "loc-9", { template: "x {link}" });
  assert.equal(missing.status, 404);
  assert.ok(!store.has("loc-9"));
});

// ---------------------------------------------------------------------------
// addGhlOutboundMessage (src/lib/ghl.ts)
// ---------------------------------------------------------------------------

test("addGhlOutboundMessage: POSTs an SMS-type outbound message; a rejection or a network error resolves, never throws, and logs no text", async (t) => {
  const { addGhlOutboundMessage } = await import("@/lib/ghl");
  const errors = t.mock.method(console, "error", () => {});
  const seen: { url: string; init: RequestInit }[] = [];
  let reply: () => Promise<Response> = async () => new Response("{}", { status: 201 });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return reply();
  });
  const input = { contactId: "c-a", message: "secret invite text", conversationProviderId: "prov-1" };
  assert.deepEqual(await addGhlOutboundMessage("tok", input), { ok: true });
  assert.equal(seen[0].url, "https://services.leadconnectorhq.com/conversations/messages/outbound");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { type: "SMS", contactId: "c-a", conversationProviderId: "prov-1", message: "secret invite text" });
  assert.equal((seen[0].init.headers as Record<string, string>).Version, "2021-04-15");

  reply = async () => new Response("echo: secret invite text", { status: 422 });
  assert.deepEqual(await addGhlOutboundMessage("tok", input), { ok: false, status: 422 });
  reply = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await addGhlOutboundMessage("tok", input), { ok: false, status: null });
  const logged = JSON.stringify(errors.mock.calls.map((c) => c.arguments));
  assert.ok(!logged.includes("secret invite text") && !logged.includes("c-a"), logged);
});
