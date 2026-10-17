import { test } from "node:test";
import assert from "node:assert/strict";
import { GroupLimiter, inviteLinkFor, isGroupJid, outcomeForParticipantStatus, resolvePhones, runAddJob } from "../src/groups.js";

test("group jid shape", () => {
  for (const ok of ["120363401234567890@g.us", "447700900123-1612345678@g.us"]) assert.equal(isGroupJid(ok), true);
  for (const bad of ["447700900123@s.whatsapp.net", "@g.us", "abc@g.us", "120363401234567890@g.us/../x", "120363401234567890@G.US"]) {
    assert.equal(isGroupJid(bad), false);
  }
});

test("participant status mapping is fixed", () => {
  assert.deepEqual(
    ["200", "403", "408", "409", "404", "419", "500", ""].map(outcomeForParticipantStatus),
    ["added", "invite_needed", "recently_left", "already_member", "not_on_whatsapp", "group_full", "failed", "failed"]
  );
});

test("invite link", () => {
  assert.equal(inviteLinkFor("AbC123"), "https://chat.whatsapp.com/AbC123");
});

test("runAddJob: resolves jids, batches, maps codes, keeps request order, stops when disconnected", async () => {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const sock = {
    onWhatsApp: async (...p: string[]) => p.map((ph) => ({ jid: `${ph.slice(1)}@s.whatsapp.net`, exists: ph !== "+447700900199" })),
    groupParticipantsUpdate: async (_j: string, parts: string[]) => {
      calls.push(parts);
      return parts.map((jid, i) => ({ status: i === 0 ? "403" : "200", jid }));
    },
  };
  const l = new GroupLimiter({ addBatch: 2, addGapMs: 1000, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 }, () => 0, () => 0);
  const r = await runAddJob(sock, l, "1@g.us", ["+447700900101", "+447700900199", "+447700900102", "+447700900103"], async (ms) => { sleeps.push(ms); }, () => true);
  assert.deepEqual(r.results.map((x) => x.outcome), ["invite_needed", "not_on_whatsapp", "added", "invite_needed"]);
  assert.deepEqual(calls.map((c) => c.length), [2, 1]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(r.interrupted, false);
  const r2 = await runAddJob(sock, l, "1@g.us", ["+447700900101", "+447700900102", "+447700900103"], async () => {}, (() => { let n = 0; return () => n++ < 1; })());
  assert.equal(r2.interrupted, true);
  assert.equal(r2.results.length, 2);
});

test("resolvePhones: pairs by the digits of the returned jid, never by position (dropped and reordered results)", () => {
  const phones = ["+447700900101", "+447700900102", "+447700900103"];
  // Baileys drops non-existent numbers and returns the server's order.
  const m = resolvePhones(phones, [
    { jid: "447700900103@s.whatsapp.net", exists: true },
    { jid: "447700900101:7@s.whatsapp.net", exists: true },
  ]);
  assert.deepEqual([...m.entries()], [
    ["+447700900101", "447700900101:7@s.whatsapp.net"],
    ["+447700900102", null],
    ["+447700900103", "447700900103@s.whatsapp.net"],
  ]);
  const none = resolvePhones(phones, [{ jid: "447700900102@s.whatsapp.net", exists: false }, { jid: "99@lid", exists: true }]);
  assert.deepEqual([...none.values()], [null, null, null]);
  assert.deepEqual([...resolvePhones(phones, undefined).values()], [null, null, null]);
});

test("runAddJob: a dropped non-WhatsApp number in the middle does not shift later phones onto the wrong jid", async () => {
  const added: string[] = [];
  const sock = {
    onWhatsApp: async () => [
      { jid: "447700900103@s.whatsapp.net", exists: true },
      { jid: "447700900101@s.whatsapp.net", exists: true },
    ],
    groupParticipantsUpdate: async (_j: string, parts: string[]) => {
      added.push(...parts);
      return parts.map((jid) => ({ status: jid.startsWith("447700900101") ? "200" : "403", jid }));
    },
  };
  const l = new GroupLimiter({ addBatch: 5, addGapMs: 1000, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 }, () => 0, () => 0);
  const r = await runAddJob(sock, l, "1@g.us", ["+447700900101", "+447700900102", "+447700900103"], async () => {}, () => true);
  assert.deepEqual(added.sort(), ["447700900101@s.whatsapp.net", "447700900103@s.whatsapp.net"]);
  assert.deepEqual(r.results, [
    { phone: "+447700900101", code: "200", outcome: "added" },
    { phone: "+447700900102", code: "404", outcome: "not_on_whatsapp" },
    { phone: "+447700900103", code: "403", outcome: "invite_needed" },
  ]);
});

test("runAddJob: a requested phone missing from the response is failed/missing", async () => {
  const sock = {
    onWhatsApp: async (...p: string[]) => p.map((ph) => ({ jid: `${ph.slice(1)}@s.whatsapp.net`, exists: true })),
    groupParticipantsUpdate: async (_j: string, parts: string[]) => [{ status: "200", jid: parts[1] }],
  };
  const l = new GroupLimiter({ addBatch: 5, addGapMs: 1000, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 }, () => 0, () => 0);
  const r = await runAddJob(sock, l, "1@g.us", ["+447700900101", "+447700900102"], async () => {}, () => true);
  assert.deepEqual(r.results, [
    { phone: "+447700900101", code: "missing", outcome: "failed" },
    { phone: "+447700900102", code: "200", outcome: "added" },
  ]);
});

test("runAddJob: LID-addressed responses match through the phone_number / lid attrs of the returned node", async () => {
  const fallbacks: number[] = [];
  const sock = {
    onWhatsApp: async (...p: string[]) => p.map((ph) => ({ jid: `${ph.slice(1)}@s.whatsapp.net`, exists: true })),
    groupParticipantsUpdate: async () => [
      { status: "200", jid: "111@lid", content: { attrs: { jid: "111@lid", phone_number: "447700900101@s.whatsapp.net" } } },
      { status: "403", jid: "222@lid", content: { attrs: { jid: "222@lid", phone_number: "447700900102@s.whatsapp.net" } } },
      { status: "409", jid: "333@lid", content: { attrs: { jid: "333@lid" } } },
    ],
  };
  const l = new GroupLimiter({ addBatch: 5, addGapMs: 1000, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 }, () => 0, () => 0);
  const r = await runAddJob(sock, l, "1@g.us", ["+447700900101", "+447700900102", "+447700900103"], async () => {}, () => true, () => fallbacks.push(1));
  assert.deepEqual(r.results.map((x) => x.outcome), ["added", "invite_needed", "failed"]);
  assert.equal(fallbacks.length, 2);
});

test("runAddJob: device-suffixed jids in the response still match the plain jid and phone_number attr", async () => {
  const fallbacks: number[] = [];
  const sock = {
    onWhatsApp: async (...p: string[]) => p.map((ph) => ({ jid: `${ph.slice(1)}@s.whatsapp.net`, exists: true })),
    groupParticipantsUpdate: async () => [
      { status: "200", jid: "447700900101:12@s.whatsapp.net" },
      { status: "403", jid: "222@lid", content: { attrs: { jid: "222@lid", phone_number: "447700900102:7@s.whatsapp.net" } } },
    ],
  };
  const l = new GroupLimiter({ addBatch: 5, addGapMs: 1000, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 }, () => 0, () => 0);
  const r = await runAddJob(sock, l, "1@g.us", ["+447700900101", "+447700900102"], async () => {}, () => true, () => fallbacks.push(1));
  assert.deepEqual(r.results.map((x) => x.outcome), ["added", "invite_needed"]);
  assert.equal(fallbacks.length, 1);
});
