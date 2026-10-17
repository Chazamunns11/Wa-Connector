/**
 * Opt-in WhatsApp groups (src/groups.ts, plus the group paths through
 * src/sessions.ts and src/store.ts). No Baileys socket, no Supabase, no
 * network: the manager-level tests drive the REAL `SessionManager`'s accept
 * and drain paths against a fake session dropped into its private session
 * map, a fake socket (only `groupMetadata`/`sendMessage`/`sendPresenceUpdate`)
 * and a fake store — the same "fake only what the path touches" pattern as
 * test/sessions-shutdown-race.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pino } from "pino";
import {
  GROUP_SEND_CAP_UNITS,
  NOT_IN_GROUP_REASON,
  checkGroupMembership,
  isGroupJid,
  isOwnNumberAParticipant,
  toGroupList,
} from "../src/groups.js";
import { SessionManager } from "../src/sessions.js";
import { SessionPacer } from "../src/pacing.js";
import { PendingWrites } from "../src/pending-writes.js";
import { BridgeStore, type MessageRecord } from "../src/store.js";
import type { BridgeConfig } from "../src/config.js";

const silentLog = pino({ level: "silent" });
const TENANT = "11111111-1111-4111-8111-111111111111";
const GROUP_JID = "120363418570879210@g.us";
const ME = { id: "447700900001:12@s.whatsapp.net", lid: "200000000000001:12@lid" };

// ---------------------------------------------------------------------------
// isGroupJid — the same regex as whatsapp_groups.group_jid's CHECK (0004).
// ---------------------------------------------------------------------------

test("isGroupJid: accepts both WhatsApp group id shapes", () => {
  assert.equal(isGroupJid("120363418570879210@g.us"), true);
  assert.equal(isGroupJid("447700900123-1612345678@g.us"), true);
});

test("isGroupJid: rejects a user JID, an empty user part, letters, and near misses", () => {
  for (const bad of ["447700900123@s.whatsapp.net", "@g.us", "abc@g.us", "123@g.usx", " 123@g.us", "123-@g.us", "-123@g.us", "123@G.US", "123@lid", ""]) {
    assert.equal(isGroupJid(bad), false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("GROUP_SEND_CAP_UNITS is 5 (global constraint: a group send costs 5 cap units)", () => {
  assert.equal(GROUP_SEND_CAP_UNITS, 5);
});

// ---------------------------------------------------------------------------
// Participant check — Baileys 7 may list a participant by LID or by PN.
// ---------------------------------------------------------------------------

test("isOwnNumberAParticipant: matches our PN against a participant id, ignoring the device part", () => {
  assert.equal(isOwnNumberAParticipant([{ id: "447700900001@s.whatsapp.net" }], ME), true);
});

test("isOwnNumberAParticipant: matches our LID against a LID-addressed participant", () => {
  assert.equal(isOwnNumberAParticipant([{ id: "200000000000001@lid" }], ME), true);
});

test("isOwnNumberAParticipant: matches via a participant's phoneNumber / lid fields", () => {
  assert.equal(isOwnNumberAParticipant([{ id: "999@lid", phoneNumber: "447700900001@s.whatsapp.net" }], ME), true);
  assert.equal(isOwnNumberAParticipant([{ id: "447700900777@s.whatsapp.net", lid: "200000000000001@lid" }], { id: "447700900002:3@s.whatsapp.net", lid: "200000000000001:3@lid" }), true);
});

test("isOwnNumberAParticipant: a LID whose digits equal our PN digits is NOT us (server suffix compared too)", () => {
  assert.equal(isOwnNumberAParticipant([{ id: "447700900001@lid" }], { id: "447700900001:1@s.whatsapp.net" }), false);
});

test("isOwnNumberAParticipant: not listed, or no own identity at all -> false", () => {
  assert.equal(isOwnNumberAParticipant([{ id: "447700900777@s.whatsapp.net" }], ME), false);
  assert.equal(isOwnNumberAParticipant([{ id: "447700900001@s.whatsapp.net" }], undefined), false);
});

test("checkGroupMembership: member / not_member / check_failed", async () => {
  const member = await checkGroupMembership({ user: ME, groupMetadata: async () => ({ participants: [{ id: "447700900001@s.whatsapp.net" }] }) }, GROUP_JID);
  assert.equal(member.kind, "member");
  const notMember = await checkGroupMembership({ user: ME, groupMetadata: async () => ({ participants: [{ id: "447700900777@s.whatsapp.net" }] }) }, GROUP_JID);
  assert.equal(notMember.kind, "not_member");
  const failed = await checkGroupMembership({ user: ME, groupMetadata: async () => { throw new Error("item-not-found"); } }, GROUP_JID);
  assert.equal(failed.kind, "check_failed");
});

test("toGroupList: { jid, name, size } per group; malformed JIDs are left out", () => {
  const list = toGroupList({
    [GROUP_JID]: { id: GROUP_JID, subject: "Monday bootcamp", participants: [{ id: "a@s.whatsapp.net" }, { id: "b@lid" }] },
    "447700900123-1612345678@g.us": { id: "447700900123-1612345678@g.us", subject: "Old group", size: 12, participants: [] },
    "abc@g.us": { id: "abc@g.us", subject: "bad", participants: [] },
  });
  assert.deepEqual(list, [
    { jid: GROUP_JID, name: "Monday bootcamp", size: 2 },
    { jid: "447700900123-1612345678@g.us", name: "Old group", size: 12 },
  ]);
});

// ---------------------------------------------------------------------------
// SessionManager — accept-time reservation and the group dispatch path.
// ---------------------------------------------------------------------------

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

function makeRecord(idempotencyKey: string, target: { toPhone: string } | { groupJid: string }): MessageRecord {
  return {
    id: `id-${idempotencyKey}`,
    coachId: TENANT,
    idempotencyKey,
    toPhone: "toPhone" in target ? target.toPhone : null,
    groupJid: "groupJid" in target ? target.groupJid : null,
    status: "accepted",
    waMessageId: null,
    error: null,
    dispatchAttempted: false,
    createdAt: "2026-10-17T10:00:00.000Z",
    sentAt: null,
    kind: "text",
  };
}

interface Harness {
  manager: SessionManager;
  session: Record<string, unknown> & { pacer: SessionPacer; queue: unknown[]; enabledGroups: Set<string> };
  calls: { method: string; args: unknown[] }[];
  terminal: Promise<void>;
  sent: { jid: string; content: unknown }[];
}

function makeHarness(opts: {
  sentToday?: number;
  leaseHeld?: boolean;
  participants?: { id: string }[];
  groupMetadataThrows?: boolean;
  enabledGroups?: string[];
  listEnabledGroupJids?: () => Promise<string[]>;
}): Harness {
  const calls: { method: string; args: unknown[] }[] = [];
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => (resolveTerminal = resolve));
  const store = {
    getMessage: async () => null,
    acceptMessage: async (coachId: string, key: string, target: { toPhone: string } | { groupJid: string }, kind: string) => {
      calls.push({ method: "acceptMessage", args: [coachId, key, target, kind] });
      return { record: makeRecord(key, target), fresh: true };
    },
    claimMessage: async () => true,
    markMessageFailed: async (...args: unknown[]) => {
      calls.push({ method: "markMessageFailed", args });
      resolveTerminal();
    },
    markMessageSent: async (...args: unknown[]) => {
      calls.push({ method: "markMessageSent", args });
      resolveTerminal();
    },
    markMessageNotOnWhatsapp: async (...args: unknown[]) => {
      calls.push({ method: "markMessageNotOnWhatsapp", args });
      resolveTerminal();
    },
    listEnabledGroupJids: opts.listEnabledGroupJids ?? (async () => []),
  } as unknown as BridgeStore;
  const sent: { jid: string; content: unknown }[] = [];
  const sock = {
    user: ME,
    groupMetadata: async (jid: string) => {
      calls.push({ method: "groupMetadata", args: [jid] });
      if (opts.groupMetadataThrows) throw new Error("timed out");
      return { id: jid, subject: "x", participants: opts.participants ?? [{ id: "447700900001@s.whatsapp.net" }] };
    },
    onWhatsApp: async (phone: string) => {
      calls.push({ method: "onWhatsApp", args: [phone] });
      return [{ exists: true, jid: `${phone.slice(1)}@s.whatsapp.net` }];
    },
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid: string, content: unknown) => {
      sent.push({ jid, content });
      return { key: { id: "WAID1" } };
    },
  };
  const manager = new SessionManager(store, makeConfig(), silentLog);
  const session = {
    coachId: TENANT,
    sock,
    lock: { isHeld: () => opts.leaseHeld ?? true, confirmHeld: async () => true, release: async () => {} },
    pacer: new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 10 }, opts.sentToday ?? 0, Date.now, () => 0),
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
    enabledGroups: new Set(opts.enabledGroups ?? [GROUP_JID]),
    enabledGroupsLoad: 0,
  };
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(TENANT, session);
  return { manager, session, calls, terminal, sent };
}

test("send to a group: refused group_not_enabled when the JID is not in the enabled set — nothing written", async () => {
  const h = makeHarness({ enabledGroups: [] });
  const outcome = await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1");
  assert.equal(outcome.kind, "group_not_enabled");
  assert.equal(h.calls.filter((c) => c.method === "acceptMessage").length, 0);
});

test("send to a group: the ledger row records the group target, never a phone", async () => {
  const h = makeHarness({ leaseHeld: false });
  const outcome = await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1");
  assert.equal(outcome.kind, "accepted");
  const accept = h.calls.find((c) => c.method === "acceptMessage");
  assert.deepEqual(accept?.args, [TENANT, "g-1", { groupJid: GROUP_JID }, "text"]);
});

test("accept-time reservation: a group send reserves 5 units (6 sent of 10 -> refused)", async () => {
  const h = makeHarness({ sentToday: 6, leaseHeld: false });
  const outcome = await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1");
  assert.deepEqual(outcome, { kind: "daily_cap_reached", cap: 10 });
});

test("accept-time reservation: a QUEUED group send counts 5 units, not 1, against later accepts", async () => {
  const h = makeHarness({ sentToday: 5, leaseHeld: false }); // lease not held -> the drain leaves the queue alone.
  assert.equal((await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1")).kind, "accepted"); // 5 + 0 + 5 = 10
  assert.equal(h.session.queue.length, 1);
  // 5 sent + 5 queued + 1 = 11 > 10. queue.length (1) would have let this through.
  assert.deepEqual(await h.manager.send(TENANT, "+447700900123", "hi", "p-1"), { kind: "daily_cap_reached", cap: 10 });
});

test("accept-time reservation: a phone send still costs exactly 1 (the daily_cap_reached contract is unchanged)", async () => {
  const h = makeHarness({ sentToday: 9, leaseHeld: false });
  assert.equal((await h.manager.send(TENANT, "+447700900123", "hi", "p-1")).kind, "accepted"); // 9 + 0 + 1 = 10
  assert.deepEqual(await h.manager.send(TENANT, "+447700900124", "hi", "p-2"), { kind: "daily_cap_reached", cap: 10 });
});

test("drain: a group send where our number is no longer a participant fails NOT dispatched with the fixed string", async () => {
  const h = makeHarness({ participants: [{ id: "447700900777@s.whatsapp.net" }] });
  await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1");
  await h.terminal;
  const failed = h.calls.find((c) => c.method === "markMessageFailed");
  assert.deepEqual(failed?.args, ["id-g-1", NOT_IN_GROUP_REASON, false]);
  assert.equal(NOT_IN_GROUP_REASON, "This WhatsApp number is no longer in that group");
  assert.equal(h.sent.length, 0, "sendMessage must never be called");
  assert.equal(h.session.pacer.sentTodayCount(), 0, "a not-dispatched send spends no cap units");
  assert.equal(h.calls.filter((c) => c.method === "onWhatsApp").length, 0, "groups skip the onWhatsApp existence check");
});

test("drain: groupMetadata throwing fails NOT dispatched, like the existing existence-check failure", async () => {
  const h = makeHarness({ groupMetadataThrows: true });
  await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1");
  await h.terminal;
  const failed = h.calls.find((c) => c.method === "markMessageFailed");
  assert.equal(failed?.args[2], false);
  assert.equal(h.sent.length, 0);
});

test("drain: a member group send goes to the stored group JID and records 5 cap units", async () => {
  const h = makeHarness({});
  await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1");
  await h.terminal;
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.jid, GROUP_JID);
  assert.deepEqual(h.sent[0]?.content, { text: "hi all", linkPreview: null });
  assert.equal(h.session.pacer.sentTodayCount(), 5);
  assert.deepEqual(h.calls.find((c) => c.method === "markMessageSent")?.args, ["id-g-1", "WAID1"]);
});

test("drain: a group disabled between accept and dispatch is not sent", async () => {
  const h = makeHarness({ leaseHeld: false });
  await h.manager.sendToGroup(TENANT, GROUP_JID, "hi all", "g-1");
  h.session.enabledGroups = new Set();
  (h.session.lock as { isHeld: () => boolean }).isHeld = () => true;
  void (h.manager as unknown as { drainQueue: (s: unknown) => Promise<void> }).drainQueue(h.session);
  await h.terminal;
  const failed = h.calls.find((c) => c.method === "markMessageFailed");
  assert.deepEqual(failed?.args, ["id-g-1", "WhatsApp group sync is turned off for this group", false]);
  assert.equal(h.sent.length, 0);
});

test("refreshEnabledGroups: loads the set from the store, keeping only valid group JIDs", async () => {
  const h = makeHarness({ enabledGroups: [], listEnabledGroupJids: async () => [GROUP_JID, "abc@g.us"] });
  assert.deepEqual(await h.manager.refreshEnabledGroups(TENANT), { kind: "refreshed" });
  assert.deepEqual([...h.session.enabledGroups], [GROUP_JID]);
});

test("refreshEnabledGroups: a failed read empties the set (fail closed) and reports refresh_failed", async () => {
  const h = makeHarness({ listEnabledGroupJids: async () => { throw new Error("supabase down"); } });
  assert.deepEqual(await h.manager.refreshEnabledGroups(TENANT), { kind: "refresh_failed" });
  assert.equal(h.session.enabledGroups.size, 0);
});

test("refreshEnabledGroups / listGroups: no local session -> session_not_connected", async () => {
  const manager = new SessionManager({} as BridgeStore, makeConfig(), silentLog);
  assert.deepEqual(await manager.refreshEnabledGroups(TENANT), { kind: "session_not_connected", status: "disconnected" });
  assert.deepEqual(await manager.listGroups(TENANT), { kind: "session_not_connected", status: "disconnected" });
});

test("listGroups: a connected session returns groupFetchAllParticipating mapped to { jid, name, size }", async () => {
  const h = makeHarness({});
  (h.session.sock as Record<string, unknown>).groupFetchAllParticipating = async () => ({
    [GROUP_JID]: { id: GROUP_JID, subject: "Monday bootcamp", participants: [{ id: "a@s.whatsapp.net" }] },
  });
  assert.deepEqual(await h.manager.listGroups(TENANT), { kind: "ok", groups: [{ jid: GROUP_JID, name: "Monday bootcamp", size: 1 }] });
  h.session.status = "waiting_qr";
  assert.deepEqual(await h.manager.listGroups(TENANT), { kind: "session_not_connected", status: "waiting_qr" });
});

const SESSIONS_SRC = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");

test("LOCKSTEP (SOURCE-LEVEL): the enabled-group set is (re)loaded on every connection 'open'", () => {
  const open = SESSIONS_SRC.slice(SESSIONS_SRC.indexOf('if (connection === "open")'), SESSIONS_SRC.indexOf('if (connection === "close")'));
  assert.match(open, /this\.loadEnabledGroups\(session\)/);
});

test("LOCKSTEP (SOURCE-LEVEL): inbound processing reads the session's enabled-group set", () => {
  const upsert = SESSIONS_SRC.slice(SESSIONS_SRC.indexOf('sock.ev.on("messages.upsert"'));
  assert.match(upsert.slice(0, 4000), /enabledGroups: session\.enabledGroups/);
});

// ---------------------------------------------------------------------------
// BridgeStore — group JIDs are validated before ANY write. The Supabase
// client is swapped for a recording fake; nothing leaves the process.
// ---------------------------------------------------------------------------

function storeWithFakeClient() {
  const store = new BridgeStore(makeConfig());
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  let touched = 0;
  (store as unknown as { supabase: unknown }).supabase = {
    from(table: string) {
      touched += 1;
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "row-1", to_phone: null, group_jid: null, ...row, status: "accepted", dispatch_attempted: false, created_at: "x", sent_at: null, wa_message_id: null, error: null }, error: null }) }) };
        },
      };
    },
  };
  return { store, inserts, touched: () => touched };
}

test("store.recordInboundMessage: a malformed group JID is refused before Supabase is touched", async () => {
  const { store, touched } = storeWithFakeClient();
  await assert.rejects(
    store.recordInboundMessage({ coachId: TENANT, fromPhone: "+447700900555", waMessageId: "M1", body: "hi", messageType: "conversation", receivedAt: "x", groupJid: "abc@g.us", senderName: "Sam" })
  );
  assert.equal(touched(), 0);
});

test("store.recordInboundMessage: a group row carries group_jid and sender_name; a 1:1 row names neither column", async () => {
  const { store, inserts } = storeWithFakeClient();
  await store.recordInboundMessage({ coachId: TENANT, fromPhone: "+447700900555", waMessageId: "M1", body: "hi", messageType: "conversation", receivedAt: "x", groupJid: GROUP_JID, senderName: "Sam" });
  assert.equal(inserts[0]?.row.group_jid, GROUP_JID);
  assert.equal(inserts[0]?.row.sender_name, "Sam");
  await store.recordInboundMessage({ coachId: TENANT, fromPhone: "+447700900555", waMessageId: "M2", body: "hi", messageType: "conversation", receivedAt: "x", groupJid: null, senderName: null });
  assert.equal("group_jid" in inserts[1]!.row, false);
  assert.equal("sender_name" in inserts[1]!.row, false);
});

test("store.acceptMessage: a group target writes group_jid with no to_phone; a malformed JID is refused before Supabase", async () => {
  const { store, inserts, touched } = storeWithFakeClient();
  const { record } = await store.acceptMessage(TENANT, "g-1", { groupJid: GROUP_JID });
  assert.equal(inserts[0]?.row.group_jid, GROUP_JID);
  assert.equal("to_phone" in inserts[0]!.row, false);
  assert.equal(record.groupJid, GROUP_JID);
  assert.equal(record.toPhone, null);
  const before = touched();
  await assert.rejects(store.acceptMessage(TENANT, "g-2", { groupJid: "447700900123@s.whatsapp.net" }));
  assert.equal(touched(), before);
});
