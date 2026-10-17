import test from "node:test";
import assert from "node:assert/strict";

import {
  addMembers,
  contactPickerData,
  createGroup,
  loadGroupView,
  postToGroup,
  reconcileGroupJobs,
  refreshGroup,
  rotateInviteLink,
  type GroupsDeps,
  type GroupsRepo,
} from "@/lib/groups/service";
import { REASON_BATCH_TOO_LARGE, REASON_CONSENT_REQUIRED, REASON_GROUPS_DISABLED, REASON_NOT_CONNECTED, REASON_OPTED_OUT } from "@/lib/groups/rules";
import { reasonSubscriptionInactive } from "@/lib/billing/gate";
import type { BillingStatus, GroupJobOutcome, WhatsappGroup, WhatsappGroupJob, WhatsappGroupMember, WhatsappGroupMemberDraft } from "@/lib/types";

const session = { accountId: "acc-1", profileId: "prof-1" };
const NOW = "2026-10-17T10:00:00.000Z";
const phone = (n: number) => `+4477009${String(n).padStart(5, "0")}`;
const cand = (n: number) => ({ phone: phone(n), ghlContactId: `c${n}`, displayName: `Name ${n}` });

function harness(
  opts: { status?: BillingStatus; session?: "connected" | "disconnected"; enabled?: boolean; optedOut?: string[]; jobs?: WhatsappGroupJob[]; createOutcomes?: Record<string, GroupJobOutcome> } = {},
) {
  const groups = new Map<string, WhatsappGroup>();
  const members: WhatsappGroupMember[] = [];
  const jobs = new Map((opts.jobs ?? []).map((j) => [j.id, j]));
  const optedOut = new Set(opts.optedOut ?? []);
  const log = { bridge: [] as string[], texts: [] as { to: string; key: string; text: string }[], notes: [] as string[], posts: new Map<string, number>(), addPhones: [] as string[][], createPhones: [] as string[][] };
  let seq = 0;
  const account = { id: "acc-1", billingStatus: opts.status ?? "active" };
  const repo = {
    listGhlAccountsForAccount: async () => [{ locationId: "loc-1", tenantId: "ten-1", label: "Studio", accountId: "acc-1", activatedAt: NOW }],
    getGhlAccountByLocationId: async () => ({ locationId: "loc-1", status: "active", accessToken: "tok", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z" }),
    getAccountById: async () => account,
    getWhatsappSessionSummary: async () => ({ status: opts.session ?? "connected" }),
    isOptedOut: async (_t: string, p: string) => optedOut.has(p),
    createWhatsappGroup: async (d: Omit<WhatsappGroup, "id" | "createdAt" | "updatedAt">) => {
      const g = { ...d, id: `grp-${++seq}`, createdAt: NOW, updatedAt: NOW } as WhatsappGroup;
      groups.set(g.id, g);
      return g;
    },
    getWhatsappGroup: async (id: string) => groups.get(id) ?? null,
    listWhatsappGroupsForAccount: async (a: string) => [...groups.values()].filter((g) => g.accountId === a),
    updateWhatsappGroup: async (id: string, patch: Partial<WhatsappGroup>) => {
      groups.set(id, { ...groups.get(id)!, ...patch });
    },
    insertWhatsappGroupMembers: async (drafts: WhatsappGroupMemberDraft[]) => {
      const out: WhatsappGroupMember[] = [];
      for (const d of drafts) {
        if (members.some((m) => m.groupId === d.groupId && m.phone === d.phone)) continue;
        const m = { ...d, id: `mem-${++seq}`, inviteIdempotencyKey: null, createdAt: NOW, updatedAt: NOW } as WhatsappGroupMember;
        members.push(m);
        out.push(m);
      }
      return out;
    },
    listWhatsappGroupMembers: async (gid: string) => members.filter((m) => m.groupId === gid),
    updateWhatsappGroupMember: async (id: string, p: { state: WhatsappGroupMember["state"]; lastReason: string | null; inviteIdempotencyKey?: string }) => {
      const m = members.find((x) => x.id === id)!;
      m.state = p.state;
      m.lastReason = p.lastReason;
      if (p.inviteIdempotencyKey) m.inviteIdempotencyKey = p.inviteIdempotencyKey;
    },
    listPendingGroupJobIds: async () => {
      const seen = new Map<string, string>();
      for (const m of members) if (m.state === "pending" && m.jobId) seen.set(m.jobId, m.groupId);
      return [...seen].map(([jobId, groupId]) => ({ jobId, groupId }));
    },
    getWhatsappGroupJob: async (id: string) => jobs.get(id) ?? null,
    listWhatsappGroupPosts: async () => [],
    claimGhlTokenRefresh: async () => true,
    saveGhlTokens: async () => {},
    markGhlNeedsReauth: async () => {},
  } as unknown as GroupsRepo;
  const deps: GroupsDeps = {
    groupsEnabled: opts.enabled ?? true,
    brandName: "PingWren",
    now: () => new Date(NOW),
    bridge: {
      createGroup: (async (_c: string, input: { participants: string[] }) => {
        log.bridge.push("create");
        log.createPhones.push(input.participants);
        return {
          ok: true,
          group: { jid: "120363@g.us", subject: "x", inviteCode: "ABC123", participantCount: 1 + input.participants.length, weAreAdmin: true },
          results: input.participants.map((p) => ({ phone: p, code: "200", outcome: opts.createOutcomes?.[p] ?? "added" })),
        };
      }) as never,
      addParticipants: (async (_c: string, _j: string, phones: string[]) => {
        log.bridge.push("add");
        log.addPhones.push(phones);
        return { ok: true, job: { id: `job-${log.addPhones.length}`, status: "queued", requestedCount: phones.length } };
      }) as never,
      getJob: (async () => ({ ok: false, code: "internal", message: "" })) as never,
      post: (async (_c: string, _j: string, _t: string, key: string) => {
        log.bridge.push("post");
        const n = log.posts.get(key) ?? 0;
        log.posts.set(key, n + 1);
        return { ok: true, replay: n > 0, post: {} };
      }) as never,
      getGroup: (async () => {
        log.bridge.push("get");
        return { ok: true, group: { jid: "120363@g.us", subject: "x", inviteCode: "NEW", participantCount: 9, weAreAdmin: false } };
      }) as never,
      revokeInvite: (async () => {
        log.bridge.push("revoke");
        return { ok: true, inviteCode: "ROTATED" };
      }) as never,
      sendText: (async (i: { to: string; text: string; idempotencyKey: string }) => {
        log.bridge.push("text");
        const dup = log.texts.some((t) => t.key === i.idempotencyKey);
        if (!dup) log.texts.push({ to: i.to, key: i.idempotencyKey, text: i.text });
        return { ok: true, replay: dup, message: {} };
      }) as never,
    },
    ghl: {
      listContacts: (async () => ({ ok: true, contacts: [{ id: "c1", name: "A", phone: "+447700900001", tags: ["vip"] }, { id: "c2", name: "B", phone: null, tags: [] }], nextStartAfterId: null })) as never,
      token: { refreshToken: (async () => ({ ok: false })) as never, refreshWaitMs: 0, notify: () => {} },
    },
    notify: (t) => log.notes.push(t),
  };
  return { repo, deps, log, groups, members, jobs };
}

async function seedGroup(h: ReturnType<typeof harness>) {
  const r = await createGroup(h.repo, h.deps, session, { locationId: "loc-1", subject: "Secret Club", description: "", announceOnly: false, adminAddOnly: true, candidates: [cand(1)], consent: true });
  assert.ok(r.ok);
  h.log.bridge.length = 0;
  return r.value.groupId;
}

test("create: 6 candidates -> 5 in the create call, 1 in an add job; no phone or subject in notify", async () => {
  const h = harness();
  const r = await createGroup(h.repo, h.deps, session, { locationId: "loc-1", subject: "Secret Club", description: "d", announceOnly: false, adminAddOnly: true, candidates: [1, 2, 3, 4, 5, 6].map(cand), consent: true });
  assert.ok(r.ok);
  assert.deepEqual(h.log.createPhones[0], [1, 2, 3, 4, 5].map(phone));
  assert.deepEqual(h.log.addPhones, [[phone(6)]]);
  const states = h.members.map((m) => `${m.phone.slice(-1)}:${m.state}`);
  assert.deepEqual(states, ["1:added", "2:added", "3:added", "4:added", "5:added", "6:pending"]);
  assert.ok(h.members.every((m) => m.consentConfirmedAt === NOW));
  assert.equal(h.log.notes.length, 1);
  assert.match(h.log.notes[0]!, /^\[groups\] created: 1 group, 6 members, 0 invites$/);
  assert.doesNotMatch(h.log.notes.join(" "), /Secret|\+44/);
});

test("create: an opted-out candidate never reaches the bridge and is recorded opted_out", async () => {
  const h = harness({ optedOut: [phone(2)] });
  const r = await createGroup(h.repo, h.deps, session, { locationId: "loc-1", subject: "S", description: "", announceOnly: false, adminAddOnly: true, candidates: [cand(1), cand(2)], consent: true });
  assert.ok(r.ok);
  assert.deepEqual(h.log.createPhones[0], [phone(1)]);
  const m2 = h.members.find((m) => m.phone === phone(2))!;
  assert.equal(m2.state, "opted_out");
  assert.equal(m2.lastReason, REASON_OPTED_OUT);
});

test("create: refuses without consent, for a foreign location, and when every candidate opted out", async () => {
  const h = harness({ optedOut: [phone(1)] });
  const base = { subject: "S", description: "", announceOnly: false, adminAddOnly: true };
  const noConsent = await createGroup(h.repo, h.deps, session, { ...base, locationId: "loc-1", candidates: [cand(2)], consent: false });
  assert.deepEqual(noConsent, { ok: false, reason: REASON_CONSENT_REQUIRED });
  const foreign = await createGroup(h.repo, h.deps, session, { ...base, locationId: "loc-x", candidates: [cand(2)], consent: true });
  assert.deepEqual(foreign, { ok: false, reason: "not_found" });
  const allOut = await createGroup(h.repo, h.deps, session, { ...base, locationId: "loc-1", candidates: [cand(1)], consent: true });
  assert.equal(allOut.ok, false);
  assert.deepEqual(h.log.bridge, []);
});

test("gate refusals: disabled, billing paused, not connected block every write while the view still loads", async () => {
  const cases: [string, Parameters<typeof harness>[0], string][] = [
    ["disabled", { enabled: false }, REASON_GROUPS_DISABLED],
    ["paused", { status: "paused" as BillingStatus }, reasonSubscriptionInactive("PingWren")],
    ["not connected", { session: "disconnected" }, REASON_NOT_CONNECTED],
  ];
  for (const [name, opts, reason] of cases) {
    const h = harness();
    const gid = await seedGroup(h);
    // flip the world after the group exists
    const g = harness(opts);
    g.groups.set(gid, h.groups.get(gid)!);
    const c = await createGroup(g.repo, g.deps, session, { locationId: "loc-1", subject: "S", description: "", announceOnly: false, adminAddOnly: true, candidates: [cand(2)], consent: true });
    const a = await addMembers(g.repo, g.deps, session, { groupId: gid, candidates: [cand(3)], consent: true });
    const p = await postToGroup(g.repo, g.deps, session, { groupId: gid, text: "hi", token: "tokentoken1" });
    const r = await rotateInviteLink(g.repo, g.deps, session, gid);
    for (const res of [c, a, p, r]) assert.deepEqual(res, { ok: false, reason }, name);
    assert.deepEqual(g.log.bridge, [], name);
    const view = await loadGroupView(g.repo, g.deps, session, gid);
    assert.equal(view?.group.id, gid, name);
    assert.equal(view?.gateReason, reason, name);
  }
});

test("ownership: another account's group is not_found everywhere and the view is null", async () => {
  const h = harness();
  const gid = await seedGroup(h);
  const other = { accountId: "acc-2", profileId: "p2" };
  assert.deepEqual(await addMembers(h.repo, h.deps, other, { groupId: gid, candidates: [cand(2)], consent: true }), { ok: false, reason: "not_found" });
  assert.deepEqual(await postToGroup(h.repo, h.deps, other, { groupId: gid, text: "hi", token: "tokentoken1" }), { ok: false, reason: "not_found" });
  assert.deepEqual(await refreshGroup(h.repo, h.deps, other, gid), { ok: false, reason: "not_found" });
  assert.deepEqual(await rotateInviteLink(h.repo, h.deps, other, gid), { ok: false, reason: "not_found" });
  assert.equal(await loadGroupView(h.repo, h.deps, other, gid), null);
  assert.deepEqual(h.log.bridge, []);
});

test("addMembers: 51 candidates -> BATCH_TOO_LARGE with no bridge call; existing and opted-out are handled", async () => {
  const h = harness({ optedOut: [phone(40)] });
  const gid = await seedGroup(h);
  const big = await addMembers(h.repo, h.deps, session, { groupId: gid, candidates: Array.from({ length: 51 }, (_, i) => cand(100 + i)), consent: true });
  assert.deepEqual(big, { ok: false, reason: REASON_BATCH_TOO_LARGE });
  assert.deepEqual(h.log.bridge, []);

  const r = await addMembers(h.repo, h.deps, session, { groupId: gid, candidates: [cand(1), cand(40), cand(41), cand(41)], consent: true });
  assert.deepEqual(r, { ok: true, value: { queued: 1, optedOut: 1, skippedExisting: 1 } });
  assert.deepEqual(h.log.addPhones, [[phone(41)]]);
  assert.equal(h.members.find((m) => m.phone === phone(40))!.state, "opted_out");
  assert.equal(h.members.find((m) => m.phone === phone(41))!.state, "pending");
});

test("addMembers: refuses without consent", async () => {
  const h = harness();
  const gid = await seedGroup(h);
  assert.deepEqual(await addMembers(h.repo, h.deps, session, { groupId: gid, candidates: [cand(2)], consent: false }), { ok: false, reason: REASON_CONSENT_REQUIRED });
  assert.deepEqual(h.log.bridge, []);
});

test("postToGroup: the same token twice is one message and the second is a replay; bad tokens never reach the bridge", async () => {
  const h = harness();
  const gid = await seedGroup(h);
  const a = await postToGroup(h.repo, h.deps, session, { groupId: gid, text: "hello", token: "abcdefgh12" });
  const b = await postToGroup(h.repo, h.deps, session, { groupId: gid, text: "hello", token: "abcdefgh12" });
  assert.deepEqual(a, { ok: true, value: { replay: false } });
  assert.deepEqual(b, { ok: true, value: { replay: true } });
  assert.deepEqual([...h.log.posts], [["grp-post-abcdefgh12", 2]]);
  assert.equal((await postToGroup(h.repo, h.deps, session, { groupId: gid, text: "hello", token: "short" })).ok, false);
  assert.equal((await postToGroup(h.repo, h.deps, session, { groupId: gid, text: "   ", token: "abcdefgh12" })).ok, false);
  assert.equal(h.log.posts.size, 1);
});

test("refresh and rotate update the stored group", async () => {
  const h = harness();
  const gid = await seedGroup(h);
  assert.deepEqual(await refreshGroup(h.repo, h.deps, session, gid), { ok: true, value: undefined });
  assert.deepEqual([h.groups.get(gid)!.participantCount, h.groups.get(gid)!.weAreAdmin, h.groups.get(gid)!.inviteCode], [9, false, "NEW"]);
  assert.deepEqual(await rotateInviteLink(h.repo, h.deps, session, gid), { ok: true, value: { inviteCode: "ROTATED" } });
  assert.equal(h.groups.get(gid)!.inviteCode, "ROTATED");
});

test("create: a 403 candidate becomes invite_needed and gets exactly one invite text", async () => {
  const h = harness({ createOutcomes: { [phone(2)]: "invite_needed" } });
  const r = await createGroup(h.repo, h.deps, session, { locationId: "loc-1", subject: "Club", description: "", announceOnly: false, adminAddOnly: true, candidates: [cand(1), cand(2)], consent: true });
  assert.ok(r.ok);
  const m2 = h.members.find((m) => m.phone === phone(2))!;
  assert.equal(m2.state, "invite_sent");
  assert.equal(h.log.texts.length, 1);
  assert.equal(h.log.texts[0]!.key, `grp-inv-${m2.id}`);
  assert.match(h.log.texts[0]!.text, /chat\.whatsapp\.com\/ABC123/);
  assert.match(h.log.notes[0]!, /1 invites$/);
});

function doneJob(id: string, results: { phone: string; outcome: GroupJobOutcome }[]): WhatsappGroupJob {
  return { id, coachId: "ten-1", groupJid: "120363@g.us", status: "done", requestedCount: results.length, results: results.map((r) => ({ ...r, code: "" })), createdAt: NOW, finishedAt: NOW };
}

test("reconcile: one invite per invite_needed member across two passes; opted-out skipped; replay is a no-op", async () => {
  const h = harness({ optedOut: [phone(8)] });
  const gid = await seedGroup(h);
  const r = await addMembers(h.repo, h.deps, session, { groupId: gid, candidates: [cand(7), cand(9)], consent: true });
  assert.ok(r.ok);
  // 8 opted out only after the add was queued (STOP arrives mid-job)
  await h.repo.insertWhatsappGroupMembers([{ groupId: gid, phone: phone(8), ghlContactId: null, displayName: null, state: "pending", jobId: "job-1", consentConfirmedAt: NOW, addedByProfileId: null, lastReason: null }]);
  h.jobs.set("job-1", doneJob("job-1", [{ phone: phone(7), outcome: "invite_needed" }, { phone: phone(9), outcome: "added" }, { phone: phone(8), outcome: "invite_needed" }]));

  const first = await reconcileGroupJobs(h.repo, h.deps, "acc-1");
  const second = await reconcileGroupJobs(h.repo, h.deps, "acc-1");
  assert.deepEqual(first, { jobs: 1, invitesSent: 1 });
  assert.deepEqual(second, { jobs: 0, invitesSent: 0 });
  assert.equal(h.log.texts.length, 1);
  assert.equal(h.log.texts[0]!.to, phone(7));
  const by = (n: number) => h.members.find((m) => m.phone === phone(n))!.state;
  assert.deepEqual([by(7), by(8), by(9)], ["invite_sent", "opted_out", "added"]);
});

test("reconcile: a running job is left alone; billing lapse holds invites for retry", async () => {
  const h = harness();
  const gid = await seedGroup(h);
  await addMembers(h.repo, h.deps, session, { groupId: gid, candidates: [cand(7)], consent: true });
  h.jobs.set("job-1", { ...doneJob("job-1", []), status: "running" });
  assert.deepEqual(await reconcileGroupJobs(h.repo, h.deps, "acc-1"), { jobs: 0, invitesSent: 0 });
  assert.equal(h.members.find((m) => m.phone === phone(7))!.state, "pending");

  h.jobs.set("job-1", doneJob("job-1", [{ phone: phone(7), outcome: "invite_needed" }]));
  const lapsed = harness({ status: "paused" as BillingStatus });
  lapsed.groups.set(gid, h.groups.get(gid)!);
  h.members.forEach((m) => lapsed.members.push(m));
  lapsed.jobs.set("job-1", h.jobs.get("job-1")!);
  assert.deepEqual(await reconcileGroupJobs(lapsed.repo, lapsed.deps, "acc-1"), { jobs: 1, invitesSent: 0 });
  assert.equal(lapsed.members.find((m) => m.phone === phone(7))!.state, "invite_needed");
  assert.deepEqual(lapsed.log.texts, []);
  // billing restored: the held invite goes out once
  const ok = harness();
  ok.groups.set(gid, h.groups.get(gid)!);
  lapsed.members.forEach((m) => ok.members.push(m));
  assert.deepEqual(await reconcileGroupJobs(ok.repo, ok.deps, "acc-1"), { jobs: 0, invitesSent: 1 });
});

test("contactPickerData: ownership, phone-less contacts dropped, tags offered; disabled and foreign refused", async () => {
  const h = harness();
  const r = await contactPickerData(h.repo, h.deps, session, "loc-1", { query: "al" });
  assert.deepEqual(r, { contacts: [{ id: "c1", name: "A", phone: "+447700900001", tags: ["vip"] }], tags: ["vip"], truncated: false });
  assert.deepEqual(await contactPickerData(h.repo, h.deps, session, "loc-x", { query: "al" }), { error: "not_found" });
  const off = harness({ enabled: false });
  assert.equal("error" in (await contactPickerData(off.repo, off.deps, session, "loc-1", {})), true);
});
