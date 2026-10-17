/**
 * Group management (src/group-management.ts, through the SessionManager
 * methods in src/sessions.ts). The same harness pattern as
 * test/groups.test.ts: a fake session dropped into the REAL manager's private
 * session map, a fake socket that records every Baileys call, and a fake
 * store. The daily limits are the real `GroupActionLimits` over that store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import {
  GROUP_LAST_ADMIN_REASON,
  GROUP_NOT_ADMIN_REASON,
  GROUP_SELF_REMOVAL_REASON,
  MEMBER_ID_RE,
  groupCreateLimitReason,
  toMemberView,
  type ParticipantLike,
} from "../src/groups.js";
import { SessionManager } from "../src/sessions.js";
import { SessionPacer } from "../src/pacing.js";
import { PendingWrites } from "../src/pending-writes.js";
import { GroupActionLimits } from "../src/group-limits.js";
import { CreateRequestCache } from "../src/group-management.js";
import { BridgeStore, type GroupActionKind } from "../src/store.js";
import type { BridgeConfig } from "../src/config.js";

const silentLog = pino({ level: "silent" });
const TENANT = "11111111-1111-4111-8111-111111111111";
const GROUP_JID = "120363418570879210@g.us";
const NEW_GROUP_JID = "120363999999999999@g.us";
const ME = { id: "447700900001:12@s.whatsapp.net", lid: "200000000000001:12@lid" };
const OUR_MEMBER = { id: "200000000000001@lid", phoneNumber: "447700900001@s.whatsapp.net", admin: "superadmin" as const };
const LID_MEMBER = { id: "123456789012345@lid", admin: null };
const PN_MEMBER = { id: "447700900222@s.whatsapp.net", admin: null };
const PHONE_A = "+447700900311";
const PHONE_B = "+447700900322";
const GROUP_NAME = "Secret bootcamp Zebra";
const GROUP_DESC = "Private description Quokka";
const INVITE_CODE = "AbCdEfGhIjKlMnOp123";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    credsKey: Buffer.alloc(32),
    credsKeyPrevious: null,
    bridgeSecret: "bridge-secret-0123456789-0123456789-0123456789",
    port: 8080,
    sendMinGapMs: 0,
    sendJitterMs: 0,
    dailyCap: 10,
    warmupEnabled: false,
    groupCreateDaily: 3,
    groupAddDaily: 50,
    typingIndicatorEnabled: false,
    typingMaxMs: 0,
    lockHeartbeatMs: 60_000,
    lockTtlMs: 180_000,
    shutdownFlushTimeoutMs: 500,
    maxQrReconnectAttempts: 5,
    logLevel: "silent",
    portalInboundUrl: null,
    waInboundPokeSecret: null,
    portalOutboundUrl: null,
    mediaOutboundEnabled: false,
    mediaInboundEnabled: false,
    mediaFetchTimeoutMs: 30_000,
    mediaMaxImageBytes: 1,
    mediaMaxAudioBytes: 1,
    mediaMaxVideoBytes: 1,
    mediaMaxDocumentBytes: 1,
    inboundMediaMaxBytes: 1,
    inboundMediaPerSenderDaily: 20,
    inboundMediaPerTenantDaily: 300,
    mediaBucket: "wa-media",
    ...overrides,
  };
}

interface Call {
  method: string;
  args: unknown[];
}

function makeHarness(opts: {
  participants?: ParticipantLike[];
  inbound?: string[];
  seed?: { creates: number; adds: number };
  /** How many leading groupCreate calls throw. */
  createThrows?: number;
  participantsUpdate?: (jid: string, jids: string[], action: string) => { status: string; jid?: string }[];
  enabledGroups?: string[];
  log?: ReturnType<typeof pino>;
} = {}) {
  const calls: Call[] = [];
  const actions: { action: GroupActionKind; count: number; groupJid: string | null }[] = [];
  let createThrowsLeft = opts.createThrows ?? 0;
  const store = {
    countGroupActionsToday: async () => ({ ...(opts.seed ?? { creates: 0, adds: 0 }) }),
    recordGroupAction: async (_tenantId: string, action: GroupActionKind, count: number, groupJid: string | null) => {
      actions.push({ action, count, groupJid });
    },
    hasInboundFromPhone: async (_tenantId: string, phone: string) => {
      calls.push({ method: "hasInboundFromPhone", args: [phone] });
      return (opts.inbound ?? []).includes(phone);
    },
    listEnabledGroupJids: async () => [],
  };
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
  };
  const sock = {
    user: ME,
    groupMetadata: async (jid: string) => {
      calls.push({ method: "groupMetadata", args: [jid] });
      return {
        id: jid,
        subject: GROUP_NAME,
        desc: GROUP_DESC,
        announce: true,
        joinApprovalMode: false,
        participants: opts.participants ?? [OUR_MEMBER, LID_MEMBER, PN_MEMBER],
      };
    },
    groupCreate: async (subject: string, participants: string[]) => {
      calls.push({ method: "groupCreate", args: [subject, participants] });
      if (createThrowsLeft > 0) {
        createThrowsLeft -= 1;
        throw new Error(`refused create of ${subject}`);
      }
      return { id: NEW_GROUP_JID, subject, participants: [] };
    },
    groupParticipantsUpdate: async (jid: string, jids: string[], action: string) => {
      calls.push({ method: "groupParticipantsUpdate", args: [jid, jids, action] });
      return opts.participantsUpdate ? opts.participantsUpdate(jid, jids, action) : jids.map((j) => ({ status: "200", jid: j }));
    },
    groupUpdateSubject: record("groupUpdateSubject"),
    groupUpdateDescription: record("groupUpdateDescription"),
    groupSettingUpdate: record("groupSettingUpdate"),
    groupJoinApprovalMode: record("groupJoinApprovalMode"),
    groupLeave: record("groupLeave"),
    groupInviteCode: async (jid: string) => {
      calls.push({ method: "groupInviteCode", args: [jid] });
      return INVITE_CODE;
    },
    groupRevokeInvite: async (jid: string) => {
      calls.push({ method: "groupRevokeInvite", args: [jid] });
      return "NewCode987654321Xyz";
    },
    onWhatsApp: async (...phones: string[]) => {
      calls.push({ method: "onWhatsApp", args: phones });
      return phones.map((p) => ({ exists: true, jid: `${p.slice(1)}@s.whatsapp.net` }));
    },
  };
  const config = makeConfig();
  const manager = new SessionManager(store as unknown as BridgeStore, config, opts.log ?? silentLog);
  const pacer = new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 10 }, 0, Date.now, () => 0);
  const session = {
    coachId: TENANT,
    sock,
    lock: { isHeld: () => true, confirmHeld: async () => true, release: async () => {} },
    pacer,
    status: "connected",
    phoneNumber: "+447700900001",
    qr: null,
    qrAt: 0,
    queue: [] as unknown[],
    draining: false,
    reconnectAttempts: 0,
    stopping: false,
    pendingWrites: new PendingWrites(),
    mediaAbuseGate: null,
    groupLimits: new GroupActionLimits(store, { createDaily: config.groupCreateDaily, addDaily: config.groupAddDaily }),
    groupCreateRequests: new CreateRequestCache(),
    enabledGroups: new Set(opts.enabledGroups ?? [GROUP_JID]),
    enabledGroupsLoad: 0,
    inFlightUnits: 0,
  };
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(TENANT, session);
  const called = (method: string) => calls.filter((c) => c.method === method);
  const mutations = () => calls.filter((c) => c.method !== "groupMetadata" && c.method !== "hasInboundFromPhone" && c.method !== "onWhatsApp" && c.method !== "groupInviteCode");
  return { manager, session, calls, called, mutations, actions, pacer };
}

// ---------------------------------------------------------------------------
// Fixed strings and member view.
// ---------------------------------------------------------------------------

test("fixed strings: verbatim", () => {
  assert.equal(groupCreateLimitReason(3), "This number has created its 3 groups for today. Try again tomorrow.");
  assert.equal(GROUP_NOT_ADMIN_REASON, "This number isn't an admin of that group.");
  assert.equal(GROUP_LAST_ADMIN_REASON, "You can't remove the group's last admin.");
  assert.equal(GROUP_SELF_REMOVAL_REASON, "You can't remove this WhatsApp number from the group. Use Leave instead.");
});

test("MEMBER_ID_RE: PN and LID member ids only", () => {
  for (const ok of ["447700900222@s.whatsapp.net", "123456789012345@lid"]) assert.ok(MEMBER_ID_RE.test(ok), ok);
  for (const bad of ["447700900222:3@s.whatsapp.net", "120363418570879210@g.us", "abc@lid", "1234@lid", "+447700900222", ""]) assert.ok(!MEMBER_ID_RE.test(bad), bad);
});

test("toMemberView: phone from the PN id or phoneNumber; null for a LID-only member; isUs and admin", () => {
  assert.deepEqual(toMemberView(PN_MEMBER, ME), { memberId: PN_MEMBER.id, phone: "+447700900222", admin: null, isUs: false });
  assert.deepEqual(toMemberView(LID_MEMBER, ME), { memberId: LID_MEMBER.id, phone: null, admin: null, isUs: false });
  assert.deepEqual(toMemberView(OUR_MEMBER, ME), { memberId: OUR_MEMBER.id, phone: "+447700900001", admin: "superadmin", isUs: true });
});

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

test("create: an empty create succeeds and uses no add", async () => {
  const h = makeHarness({ inbound: [PHONE_A] });
  const outcome = await h.manager.createGroup(TENANT, { requestId: "req-00001", name: GROUP_NAME, participants: [PHONE_A] });
  assert.deepEqual(outcome, { kind: "ok", value: { jid: NEW_GROUP_JID, name: GROUP_NAME, addedPhone: null, path: "empty" } });
  assert.deepEqual(h.called("groupCreate").map((c) => c.args), [[GROUP_NAME, []]]);
  assert.equal(h.actions.filter((a) => a.action === "add").reduce((n, a) => n + a.count, 0), 0);
  assert.deepEqual(h.actions, [{ action: "create", count: 1, groupJid: null }]);
  assert.ok(h.session.enabledGroups.has(NEW_GROUP_JID), "the new group joins the enabled set at once");
  assert.equal(h.called("groupUpdateDescription").length, 0, "no description, no description call");
});

test("create: a description is set after the create", async () => {
  const h = makeHarness();
  const outcome = await h.manager.createGroup(TENANT, { requestId: "req-00002", name: GROUP_NAME, description: GROUP_DESC, participants: [] });
  assert.equal(outcome.kind, "ok");
  assert.deepEqual(h.called("groupUpdateDescription").map((c) => c.args), [[NEW_GROUP_JID, GROUP_DESC]]);
});

test("create: empty refused, falls back to the first eligible contact", async () => {
  const h = makeHarness({ createThrows: 1, inbound: [PHONE_B] });
  const outcome = await h.manager.createGroup(TENANT, { requestId: "req-00003", name: GROUP_NAME, participants: [PHONE_A, PHONE_B] });
  assert.deepEqual(outcome, { kind: "ok", value: { jid: NEW_GROUP_JID, name: GROUP_NAME, addedPhone: PHONE_B, path: "with_member" } });
  assert.deepEqual(h.called("groupCreate").map((c) => c.args), [[GROUP_NAME, []], [GROUP_NAME, ["447700900322@s.whatsapp.net"]]]);
  assert.deepEqual(h.called("onWhatsApp").map((c) => c.args), [[PHONE_B]], "A had no inbound, so it never reaches onWhatsApp");
  assert.deepEqual(h.actions, [{ action: "create", count: 1, groupJid: null }, { action: "add", count: 1, groupJid: null }]);
});

test("create: empty refused, nobody eligible", async () => {
  const h = makeHarness({ createThrows: 1, inbound: [] });
  const outcome = await h.manager.createGroup(TENANT, { requestId: "req-00004", name: GROUP_NAME, participants: [PHONE_A, PHONE_B] });
  assert.deepEqual(outcome, {
    kind: "refused",
    code: "needs_member",
    message: "Add at least one person who has messaged this number before, then invite the rest by link.",
  });
  assert.equal(h.called("groupCreate").length, 1);
  assert.equal(h.session.enabledGroups.has(NEW_GROUP_JID), false);
  assert.deepEqual(h.actions, [{ action: "create", count: 1, groupJid: null }], "the refused attempt still counts as a create");
});

test("create: the 4th of the day", async () => {
  const h = makeHarness({ seed: { creates: 3, adds: 0 } });
  const outcome = await h.manager.createGroup(TENANT, { requestId: "req-00005", name: GROUP_NAME, participants: [] });
  assert.deepEqual(outcome, { kind: "refused", code: "create_limit", message: "This number has created its 3 groups for today. Try again tomorrow." });
  assert.equal(h.called("groupCreate").length, 0);
});

test("create: warm-up refuses before anything is counted", async () => {
  const h = makeHarness();
  h.pacer.setLinkedAt(Date.now());
  const outcome = await h.manager.createGroup(TENANT, { requestId: "req-00006", name: GROUP_NAME, participants: [] });
  assert.deepEqual(outcome, { kind: "refused", code: "warmup", message: "New numbers can't create groups during their first 14 days." });
  assert.equal(h.actions.length, 0, "no whatsapp_group_actions write");
  assert.equal(h.called("groupCreate").length, 0);
});

test("create: the same requestId twice makes one group", async () => {
  const h = makeHarness();
  const input = { requestId: "req-00007", name: GROUP_NAME, participants: [] };
  const [first, second] = await Promise.all([h.manager.createGroup(TENANT, input), h.manager.createGroup(TENANT, input)]);
  const third = await h.manager.createGroup(TENANT, input);
  assert.equal(h.called("groupCreate").length, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
  assert.equal(h.actions.filter((a) => a.action === "create").length, 1, "one of the day's creates, not two");
});

test("create: a refusal is not replayed — the same requestId may try again", async () => {
  const h = makeHarness({ createThrows: 1, inbound: [] });
  const input = { requestId: "req-00008", name: GROUP_NAME, participants: [PHONE_A] };
  assert.equal((await h.manager.createGroup(TENANT, input)).kind, "refused");
  assert.equal((await h.manager.createGroup(TENANT, input)).kind, "ok");
});

test("create: a create that throws on the fallback too is failed and replayed", async () => {
  const h = makeHarness({ createThrows: 2, inbound: [PHONE_A] });
  const input = { requestId: "req-00009", name: GROUP_NAME, participants: [PHONE_A] };
  assert.deepEqual(await h.manager.createGroup(TENANT, input), { kind: "failed" });
  assert.deepEqual(await h.manager.createGroup(TENANT, input), { kind: "failed" });
  assert.equal(h.called("groupCreate").length, 2, "the replay never reaches WhatsApp: the group may exist");
});

test("CreateRequestCache: entries expire after 10 minutes", async () => {
  let now = 0;
  const cache = new CreateRequestCache(() => now);
  let runs = 0;
  const run = async (markReachedWhatsApp: () => void) => {
    runs += 1;
    markReachedWhatsApp();
    return { kind: "failed" as const };
  };
  await cache.run("r", run);
  now += 9 * 60_000;
  await cache.run("r", run);
  assert.equal(runs, 1);
  now += 2 * 60_000;
  await cache.run("r", run);
  assert.equal(runs, 2);
});

test("create / every op: no connected session -> session_not_connected", async () => {
  const h = makeHarness();
  h.session.status = "waiting_qr";
  assert.deepEqual(await h.manager.createGroup(TENANT, { requestId: "req-00010", name: GROUP_NAME, participants: [] }), { kind: "session_not_connected" });
  assert.deepEqual(await h.manager.getGroupDetail(TENANT, GROUP_JID), { kind: "session_not_connected" });
  const manager = new SessionManager({} as BridgeStore, makeConfig(), silentLog);
  assert.deepEqual(await manager.leaveGroup(TENANT, GROUP_JID), { kind: "session_not_connected" });
});

// ---------------------------------------------------------------------------
// Detail.
// ---------------------------------------------------------------------------

test("detail: maps the metadata, with weAreAdmin from our own participant", async () => {
  const h = makeHarness();
  const outcome = await h.manager.getGroupDetail(TENANT, GROUP_JID);
  assert.deepEqual(outcome, {
    kind: "ok",
    value: {
      jid: GROUP_JID,
      name: GROUP_NAME,
      description: GROUP_DESC,
      announcement: true,
      approval: false,
      weAreAdmin: true,
      members: [
        { memberId: OUR_MEMBER.id, phone: "+447700900001", admin: "superadmin", isUs: true },
        { memberId: LID_MEMBER.id, phone: null, admin: null, isUs: false },
        { memberId: PN_MEMBER.id, phone: "+447700900222", admin: null, isUs: false },
      ],
    },
  });
});

// ---------------------------------------------------------------------------
// Participants.
// ---------------------------------------------------------------------------

test("add: a privacy refusal comes back as invite_required", async () => {
  const h = makeHarness({
    inbound: [PHONE_A, PHONE_B],
    participantsUpdate: (_jid, jids) => jids.map((j) => ({ status: j.startsWith("447700900311") ? "403" : "409", jid: j })),
  });
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "add", phones: [PHONE_A, PHONE_B] });
  assert.deepEqual(outcome, {
    kind: "ok",
    value: [
      { phone: PHONE_A, result: "invite_required" },
      { phone: PHONE_B, result: "already_member" },
    ],
  });
  assert.deepEqual(h.called("groupParticipantsUpdate").map((c) => c.args), [[GROUP_JID, ["447700900311@s.whatsapp.net", "447700900322@s.whatsapp.net"], "add"]]);
  assert.deepEqual(h.actions, [{ action: "add", count: 2, groupJid: GROUP_JID }]);
});

test("add: a phone with no inbound row is not_eligible and never reaches onWhatsApp", async () => {
  const h = makeHarness({ inbound: [PHONE_B] });
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "add", phones: [PHONE_A, PHONE_B] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ phone: PHONE_A, result: "not_eligible" }, { phone: PHONE_B, result: "ok" }] });
  assert.deepEqual(h.called("onWhatsApp").map((c) => c.args), [[PHONE_B]]);
});

test("add: a phone WhatsApp does not know is not_on_whatsapp and is not added", async () => {
  const h = makeHarness({ inbound: [PHONE_A] });
  (h.session.sock as Record<string, unknown>).onWhatsApp = async () => [];
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "add", phones: [PHONE_A] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ phone: PHONE_A, result: "not_on_whatsapp" }] });
  assert.equal(h.called("groupParticipantsUpdate").length, 0);
  assert.equal(h.actions.length, 0);
});

test("add: during warm-up, eligible phones are warmup and nothing is added", async () => {
  const h = makeHarness({ inbound: [PHONE_A] });
  h.pacer.setLinkedAt(Date.now());
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "add", phones: [PHONE_A] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ phone: PHONE_A, result: "warmup" }] });
  assert.equal(h.called("groupParticipantsUpdate").length, 0);
  assert.equal(h.actions.length, 0);
});

test("add: past the daily grant the rest are limit_reached", async () => {
  const h = makeHarness({ inbound: [PHONE_A, PHONE_B], seed: { creates: 0, adds: 49 } });
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "add", phones: [PHONE_A, PHONE_B] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ phone: PHONE_A, result: "ok" }, { phone: PHONE_B, result: "limit_reached" }] });
  assert.deepEqual(h.called("groupParticipantsUpdate").map((c) => c.args[1]), [["447700900311@s.whatsapp.net"]]);
});

test("add: not an admin -> not_admin, nothing looked up or added", async () => {
  const h = makeHarness({ inbound: [PHONE_A], participants: [{ ...OUR_MEMBER, admin: null }, PN_MEMBER] });
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "add", phones: [PHONE_A] });
  assert.deepEqual(outcome, { kind: "refused", code: "not_admin", message: GROUP_NOT_ADMIN_REASON });
  assert.equal(h.called("hasInboundFromPhone").length, 0);
  assert.equal(h.mutations().length, 0);
});

test("remove: a LID-only member is removed by memberId", async () => {
  const h = makeHarness();
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "remove", memberIds: ["123456789012345@lid"] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ memberId: "123456789012345@lid", result: "ok" }] });
  assert.deepEqual(h.called("groupParticipantsUpdate").map((c) => c.args), [[GROUP_JID, ["123456789012345@lid"], "remove"]]);
  assert.deepEqual(h.actions, [{ action: "remove", count: 1, groupJid: GROUP_JID }]);
});

test("remove: a memberId not in the group is not_member and nothing is sent", async () => {
  const h = makeHarness();
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "remove", memberIds: ["447700900999@s.whatsapp.net"] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ memberId: "447700900999@s.whatsapp.net", result: "not_member" }] });
  assert.equal(h.called("groupParticipantsUpdate").length, 0);
  assert.equal(h.actions.length, 0);
});

test("remove: our own number is refused as self", async () => {
  const h = makeHarness();
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "remove", memberIds: [OUR_MEMBER.id, PN_MEMBER.id] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ memberId: OUR_MEMBER.id, result: "self" }, { memberId: PN_MEMBER.id, result: "ok" }] });
  assert.deepEqual(h.called("groupParticipantsUpdate").map((c) => c.args[1]), [[PN_MEMBER.id]]);
});

test("demote: the only admin demoting themselves is last_admin", async () => {
  const h = makeHarness();
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "demote", memberIds: [OUR_MEMBER.id] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ memberId: OUR_MEMBER.id, result: "last_admin" }] });
  assert.equal(h.called("groupParticipantsUpdate").length, 0);
});

test("demote: with a second admin, demoting ourselves goes through; promote sends promote", async () => {
  const h = makeHarness({ participants: [OUR_MEMBER, { ...PN_MEMBER, admin: "admin" }, LID_MEMBER] });
  const demote = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "demote", memberIds: [OUR_MEMBER.id] });
  assert.deepEqual(demote, { kind: "ok", value: [{ memberId: OUR_MEMBER.id, result: "ok" }] });
  const promote = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "promote", memberIds: [LID_MEMBER.id] });
  assert.deepEqual(promote, { kind: "ok", value: [{ memberId: LID_MEMBER.id, result: "ok" }] });
  assert.deepEqual(h.called("groupParticipantsUpdate").map((c) => c.args[2]), ["demote", "promote"]);
});

test("demote: both admins at once — the second is last_admin", async () => {
  const h = makeHarness({ participants: [OUR_MEMBER, { ...PN_MEMBER, admin: "admin" }] });
  const outcome = await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "demote", memberIds: [PN_MEMBER.id, OUR_MEMBER.id] });
  assert.deepEqual(outcome, { kind: "ok", value: [{ memberId: PN_MEMBER.id, result: "ok" }, { memberId: OUR_MEMBER.id, result: "last_admin" }] });
});

test("participants: a Baileys throw is failed, logging only the error name", async () => {
  const lines: string[] = [];
  const log = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  const h = makeHarness({ log });
  (h.session.sock as Record<string, unknown>).groupParticipantsUpdate = async () => {
    throw new TypeError(`boom for ${LID_MEMBER.id}`);
  };
  assert.deepEqual(await h.manager.updateGroupParticipants(TENANT, GROUP_JID, { action: "remove", memberIds: [LID_MEMBER.id] }), { kind: "failed" });
  assert.ok(lines.some((l) => l.includes("TypeError")));
  assert.ok(!lines.join("").includes(LID_MEMBER.id));
});

// ---------------------------------------------------------------------------
// Update, invite link, leave.
// ---------------------------------------------------------------------------

test("update: each field goes to its Baileys call", async () => {
  const h = makeHarness();
  const outcome = await h.manager.updateGroup(TENANT, GROUP_JID, { name: "New name", description: "New desc", announcement: false, approval: true });
  assert.deepEqual(outcome, { kind: "ok", value: null });
  assert.deepEqual(
    h.mutations().map((c) => [c.method, ...c.args]),
    [
      ["groupUpdateSubject", GROUP_JID, "New name"],
      ["groupUpdateDescription", GROUP_JID, "New desc"],
      ["groupSettingUpdate", GROUP_JID, "not_announcement"],
      ["groupJoinApprovalMode", GROUP_JID, "on"],
    ]
  );
  assert.deepEqual(h.actions, [{ action: "update", count: 1, groupJid: GROUP_JID }]);
});

test("update: not an admin", async () => {
  const h = makeHarness({ participants: [{ ...OUR_MEMBER, admin: null }, { ...PN_MEMBER, admin: "admin" }] });
  const outcome = await h.manager.updateGroup(TENANT, GROUP_JID, { name: "New name" });
  assert.deepEqual(outcome, { kind: "refused", code: "not_admin", message: "This number isn't an admin of that group." });
  assert.equal(h.mutations().length, 0, "no Baileys mutation");
  assert.equal(h.actions.length, 0);
});

test("invite link: returns https://chat.whatsapp.com/<code>", async () => {
  const h = makeHarness();
  assert.deepEqual(await h.manager.getGroupInviteLink(TENANT, GROUP_JID), { kind: "ok", value: { link: `https://chat.whatsapp.com/${INVITE_CODE}` } });
  assert.deepEqual(await h.manager.resetGroupInviteLink(TENANT, GROUP_JID), { kind: "ok", value: { link: "https://chat.whatsapp.com/NewCode987654321Xyz" } });
  assert.deepEqual(h.actions, [{ action: "invite_reset", count: 1, groupJid: GROUP_JID }]);
});

test("invite link: not an admin -> not_admin", async () => {
  const h = makeHarness({ participants: [{ ...OUR_MEMBER, admin: null }] });
  assert.deepEqual(await h.manager.getGroupInviteLink(TENANT, GROUP_JID), { kind: "refused", code: "not_admin", message: GROUP_NOT_ADMIN_REASON });
  assert.equal(h.called("groupInviteCode").length, 0);
});

test("leave: no admin check; leaves and drops the group from the enabled set", async () => {
  const h = makeHarness({ participants: [{ ...OUR_MEMBER, admin: null }] });
  assert.deepEqual(await h.manager.leaveGroup(TENANT, GROUP_JID), { kind: "ok", value: null });
  assert.deepEqual(h.called("groupLeave").map((c) => c.args), [[GROUP_JID]]);
  assert.equal(h.session.enabledGroups.has(GROUP_JID), false);
  assert.deepEqual(h.actions, [{ action: "leave", count: 1, groupJid: GROUP_JID }]);
});

test("every op: a disabled or malformed JID is group_not_enabled", async () => {
  const h = makeHarness();
  const ops = (jid: string) => [
    () => h.manager.getGroupDetail(TENANT, jid),
    () => h.manager.updateGroup(TENANT, jid, { name: "x" }),
    () => h.manager.updateGroupParticipants(TENANT, jid, { action: "add", phones: [PHONE_A] }),
    () => h.manager.updateGroupParticipants(TENANT, jid, { action: "remove", memberIds: [PN_MEMBER.id] }),
    () => h.manager.getGroupInviteLink(TENANT, jid),
    () => h.manager.resetGroupInviteLink(TENANT, jid),
    () => h.manager.leaveGroup(TENANT, jid),
  ];
  h.session.enabledGroups.add("abc@g.us"); // a malformed JID never passes, even if it were in the set
  for (const jid of ["abc@g.us", "120363000000000123@g.us"]) {
    for (const op of ops(jid)) assert.deepEqual(await op(), { kind: "group_not_enabled" });
  }
  assert.equal(h.calls.length, 0, "nothing reached the socket or the store");
  assert.equal(h.actions.length, 0);
});

// ---------------------------------------------------------------------------
// Privacy.
// ---------------------------------------------------------------------------

test("logs: no name, description, link, phone or memberId reaches the logger", async () => {
  const lines: string[] = [];
  const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
  const h = makeHarness({ log, createThrows: 1, inbound: [PHONE_A, PHONE_B] });
  // Make the description call fail too, so the error path logs.
  (h.session.sock as Record<string, unknown>).groupUpdateDescription = async () => {
    throw new Error(`desc failed: ${GROUP_DESC}`);
  };
  await h.manager.createGroup(TENANT, { requestId: "req-00011", name: GROUP_NAME, description: GROUP_DESC, participants: [PHONE_A] });
  await h.manager.updateGroupParticipants(TENANT, NEW_GROUP_JID, { action: "add", phones: [PHONE_B] });
  await h.manager.updateGroupParticipants(TENANT, NEW_GROUP_JID, { action: "remove", memberIds: [LID_MEMBER.id] });
  await h.manager.getGroupInviteLink(TENANT, NEW_GROUP_JID);
  await h.manager.resetGroupInviteLink(TENANT, NEW_GROUP_JID);
  const all = lines.join("\n");
  assert.ok(lines.length > 0, "the run logged something to check");
  for (const secret of [GROUP_NAME, GROUP_DESC, INVITE_CODE, "chat.whatsapp.com", PHONE_A, PHONE_B, PHONE_A.slice(1), PHONE_B.slice(1), LID_MEMBER.id, "123456789012345", NEW_GROUP_JID, GROUP_JID]) {
    assert.ok(!all.includes(secret), `log leaked ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// store.hasInboundFromPhone — the 90-day eligibility window.
// ---------------------------------------------------------------------------

test("store.hasInboundFromPhone: only a 1:1 row from the last 90 days counts", async () => {
  const store = new BridgeStore(makeConfig());
  const filters: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "gte"]) {
    builder[method] = (...args: unknown[]) => {
      filters.push([method, ...args]);
      return builder;
    };
  }
  builder.limit = async () => ({ data: [{ id: 1 }], error: null });
  (store as unknown as { supabase: unknown }).supabase = { from: (table: string) => (filters.push(["from", table]), builder) };
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  assert.equal(await store.hasInboundFromPhone(TENANT, PHONE_A, now), true);
  assert.deepEqual(filters, [
    ["from", "whatsapp_inbound_messages"],
    ["select", "id"],
    ["eq", "coach_id", TENANT],
    ["eq", "from_phone", PHONE_A],
    ["is", "group_jid", null],
    ["gte", "received_at", "2026-07-19T12:00:00.000Z"],
  ]);
});
