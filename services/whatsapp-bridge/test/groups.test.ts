import { test } from "node:test";
import assert from "node:assert/strict";
import { GroupLimiter, inviteLinkFor, isGroupJid, outcomeForParticipantStatus, runAddJob } from "../src/groups.js";

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

test("runAddJob: a requested phone missing from the response is failed/missing; pairing is by resolved jid", async () => {
  const sock = {
    onWhatsApp: async (...p: string[]) => p.map((ph, i) => ({ jid: `9${i}@lid`, exists: true })),
    groupParticipantsUpdate: async (_j: string, parts: string[]) => [{ status: "200", jid: parts[1] }],
  };
  const l = new GroupLimiter({ addBatch: 5, addGapMs: 1000, addJitterMs: 0, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 0, createsToday: 0 }, () => 0, () => 0);
  const r = await runAddJob(sock, l, "1@g.us", ["+447700900101", "+447700900102"], async () => {}, () => true);
  assert.deepEqual(r.results, [
    { phone: "+447700900101", code: "missing", outcome: "failed" },
    { phone: "+447700900102", code: "200", outcome: "added" },
  ]);
});
