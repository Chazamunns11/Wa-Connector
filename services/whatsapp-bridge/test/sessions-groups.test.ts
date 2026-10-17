import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, contentForQueueItem, participantResultsFromCreate, weAreAdminIn } from "../src/sessions.js";
import { GroupLimiter } from "../src/groups.js";
import type { GroupPostRecord } from "../src/store.js";

test("weAreAdminIn: device suffix is normalised and superadmin counts", () => {
  const meta = { participants: [{ id: "447700900100@s.whatsapp.net", admin: "superadmin" }, { id: "447700900101@s.whatsapp.net", admin: null }] };
  assert.equal(weAreAdminIn(meta, ["447700900100:12@s.whatsapp.net"]), true);
  assert.equal(weAreAdminIn(meta, ["447700900101:3@s.whatsapp.net"]), false);
  assert.equal(weAreAdminIn(meta, ["447700900199:1@s.whatsapp.net"]), false);
  assert.equal(weAreAdminIn({ participants: [{ id: "447700900100@s.whatsapp.net", admin: "admin" }] }, ["447700900100:1@s.whatsapp.net"]), true);
  assert.equal(weAreAdminIn(meta, []), false);
});

test("participantResultsFromCreate: in meta is added, unresolved is not_on_whatsapp, the rest invite_needed", () => {
  const meta = { participants: [{ id: "447700900100@s.whatsapp.net" }, { id: "447700900101@s.whatsapp.net" }] };
  const r = participantResultsFromCreate(meta, [
    { phone: "+447700900101", jid: "447700900101@s.whatsapp.net" },
    { phone: "+447700900102", jid: "447700900102@s.whatsapp.net" },
    { phone: "+447700900103", jid: null },
  ]);
  assert.deepEqual(r.map((x) => x.outcome), ["added", "invite_needed", "not_on_whatsapp"]);
  assert.deepEqual(r.map((x) => x.code), ["200", "403", "404"]);
});

test("contentForQueueItem: a group post is plain text with link previews off", () => {
  const post = { id: "p" } as GroupPostRecord;
  assert.deepEqual(contentForQueueItem({ kind: "group_post", post, text: "hello https://x.test" }), { text: "hello https://x.test", linkPreview: null });
});

test("participantResultsFromCreate: LID-addressed groups match through phoneNumber, so nobody present is invite_needed", () => {
  const meta = {
    participants: [
      { id: "111@lid", phoneNumber: "447700900101@s.whatsapp.net" },
      { id: "222@lid", phoneNumber: "447700900102:5@s.whatsapp.net" },
    ],
  };
  const r = participantResultsFromCreate(meta, [
    { phone: "+447700900101", jid: "447700900101@s.whatsapp.net" },
    { phone: "+447700900102", jid: "447700900102@s.whatsapp.net" },
    { phone: "+447700900103", jid: "447700900103@s.whatsapp.net" },
  ]);
  assert.deepEqual(r.map((x) => x.outcome), ["added", "added", "invite_needed"]);
});

test("createGroup: no resolvable participant answers invalid_participants and does not spend a create", async () => {
  const limiter = new GroupLimiter({ addBatch: 5, addGapMs: 1, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 });
  let created = 0;
  const sock = { onWhatsApp: async () => [], groupCreate: async () => { created++; return {}; } };
  const mgr = Object.create(SessionManager.prototype) as Record<string, unknown>;
  mgr.sessions = new Map([["c1", { status: "connected", sock, groupLimiter: limiter }]]);
  mgr.config = { groupCreatesDailyCap: 3 };
  const out = await (mgr as unknown as SessionManager).createGroup("c1", { subject: "S", participants: ["+447700900101"], announceOnly: false, adminAddOnly: false });
  assert.deepEqual(out, { kind: "invalid_participants" });
  assert.equal(created, 0);
  assert.equal(limiter.remainingCreatesToday(), 3);
});

test("createGroup: a successful create spends exactly one create", async () => {
  const limiter = new GroupLimiter({ addBatch: 5, addGapMs: 1, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 });
  const sock = {
    onWhatsApp: async (...p: string[]) => p.map((ph) => ({ jid: `${ph.slice(1)}@s.whatsapp.net`, exists: true })),
    groupCreate: async () => ({ id: "120363401234567890@g.us", subject: "S", participants: [{ id: "447700900101@s.whatsapp.net" }] }),
    groupInviteCode: async () => "Code1",
    user: { id: "447700900100:1@s.whatsapp.net" },
  };
  const mgr = Object.create(SessionManager.prototype) as Record<string, unknown>;
  mgr.sessions = new Map([["c1", { status: "connected", sock, groupLimiter: limiter }]]);
  mgr.config = { groupCreatesDailyCap: 3 };
  mgr.store = { createGroupJob: async () => ({}) };
  mgr.log = { warn: () => {} };
  const out = await (mgr as unknown as SessionManager).createGroup("c1", { subject: "S", participants: ["+447700900101"], announceOnly: false, adminAddOnly: false });
  assert.equal(out.kind, "created");
  assert.equal(limiter.remainingCreatesToday(), 2);
});
