import test from "node:test";
import assert from "node:assert/strict";
import {
  ADD_BATCH_MAX,
  GROUP_ADDS_PER_DAY,
  GROUP_CREATES_PER_DAY,
  GROUP_MEMBER_CAP,
  REASON_ALREADY_MEMBER,
  REASON_BATCH_TOO_LARGE,
  REASON_CONSENT_REQUIRED,
  REASON_GROUPS_DISABLED,
  REASON_GROUP_FULL,
  REASON_INTERRUPTED,
  REASON_INVITE_NEEDED,
  REASON_INVITE_SKIPPED_OPT_OUT,
  REASON_NOT_CONNECTED,
  REASON_NOT_ON_WHATSAPP,
  REASON_NO_VALID_NUMBERS,
  REASON_RECENTLY_LEFT,
  REASON_WHATSAPP_REFUSED,
  groupGate,
  inviteIdempotencyKey,
  inviteText,
  memberStateForOutcome,
  parsePastedNumbers,
  planAddMembers,
  reasonForBridgeFailure,
  reasonMemberCap,
  reconcileJob,
  validateDescription,
  validatePostText,
  validateSubject,
} from "@/lib/groups/rules";
import { REASON_NOT_ACTIVATED, reasonSubscriptionInactive } from "@/lib/billing/gate";
import type { GroupJobOutcome, WhatsappGroupJob, WhatsappGroupMember } from "@/lib/types";

const loc = { accountId: "a1", activatedAt: "2026-10-01T00:00:00Z" };
const okGate = { groupsEnabled: true, location: loc, billingStatus: "active" as const, sessionStatus: "connected" as const, brandName: "PingWren" };

test("groupGate precedence", () => {
  assert.equal(groupGate({ ...okGate, groupsEnabled: false, location: null, billingStatus: null, sessionStatus: null }), REASON_GROUPS_DISABLED);
  assert.equal(groupGate({ ...okGate, location: null }), REASON_NOT_ACTIVATED);
  assert.equal(groupGate({ ...okGate, billingStatus: "cancelled" }), reasonSubscriptionInactive("PingWren"));
  assert.equal(groupGate({ ...okGate, billingStatus: "cancelled", sessionStatus: "disconnected" }), reasonSubscriptionInactive("PingWren"));
  assert.equal(groupGate({ ...okGate, sessionStatus: "disconnected" }), REASON_NOT_CONNECTED);
  assert.equal(groupGate({ ...okGate, sessionStatus: null }), REASON_NOT_CONNECTED);
  assert.equal(groupGate(okGate), null);
});

test("validators trim and bound", () => {
  assert.deepEqual(validateSubject("  Team  "), { ok: true, value: "Team" });
  assert.equal(validateSubject("   ").ok, false);
  assert.equal(validateSubject("x".repeat(100)).ok, true);
  assert.equal(validateSubject("x".repeat(101)).ok, false);
  assert.deepEqual(validateDescription("   "), { ok: true, value: null });
  assert.deepEqual(validateDescription(" hi "), { ok: true, value: "hi" });
  assert.equal(validateDescription("x".repeat(2048)).ok, true);
  assert.equal(validateDescription("x".repeat(2049)).ok, false);
  assert.deepEqual(validatePostText(" hello "), { ok: true, value: "hello" });
  assert.equal(validatePostText("").ok, false);
  assert.equal(validatePostText("x".repeat(4096)).ok, true);
  assert.equal(validatePostText("x".repeat(4097)).ok, false);
});

test("parsePastedNumbers normalises and dedupes", () => {
  assert.deepEqual(parsePastedNumbers("07700 900123, +447700900123\n00447700900124;rubbish"), [{ phone: "+447700900123" }, { phone: "+447700900124" }]);
  assert.deepEqual(parsePastedNumbers(""), []);
});

const c = (n: number) => ({ phone: `+4477009${String(n).padStart(5, "0")}`, ghlContactId: null, displayName: null });
const base = { candidates: [c(1), c(2)], existingPhones: new Set<string>(), optedOutPhones: new Set<string>(), currentCount: 1, consent: true, brandName: "PingWren" };

test("planAddMembers refusals in order", () => {
  assert.equal(planAddMembers({ ...base, consent: false, candidates: [] }).refusal, REASON_CONSENT_REQUIRED);
  assert.equal(planAddMembers({ ...base, candidates: [{ phone: "bad", ghlContactId: null, displayName: null }] }).refusal, REASON_NO_VALID_NUMBERS);
  assert.equal(planAddMembers({ ...base, existingPhones: new Set([c(1).phone, c(2).phone]) }).refusal, REASON_NO_VALID_NUMBERS);
  const many = Array.from({ length: ADD_BATCH_MAX + 1 }, (_, i) => c(i + 1));
  const big = planAddMembers({ ...base, candidates: many });
  assert.equal(big.refusal, REASON_BATCH_TOO_LARGE);
  assert.equal(planAddMembers({ ...base, currentCount: GROUP_MEMBER_CAP - 1 }).refusal, reasonMemberCap("PingWren"));
  assert.equal(planAddMembers({ ...base, currentCount: GROUP_MEMBER_CAP - 2 }).refusal, null);
});

test("planAddMembers dedupes, drops existing, splits opted out", () => {
  const plan = planAddMembers({
    ...base,
    candidates: [c(1), { ...c(1), displayName: "dup" }, c(2), c(3), { phone: "nope", ghlContactId: null, displayName: null }],
    existingPhones: new Set([c(2).phone]),
    optedOutPhones: new Set([c(3).phone]),
  });
  assert.deepEqual(plan.toAdd, [c(1)]);
  assert.equal(plan.skippedExisting, 1);
  assert.deepEqual(plan.optedOut, [c(3)]);
  assert.equal(plan.refusal, null);
  // only opted-out left is not a refusal
  const only = planAddMembers({ ...base, candidates: [c(3)], optedOutPhones: new Set([c(3).phone]) });
  assert.equal(only.refusal, null);
  assert.equal(only.toAdd.length, 0);
});

test("memberStateForOutcome", () => {
  const cases: [GroupJobOutcome, string, string | null][] = [
    ["added", "added", null],
    ["invite_needed", "invite_needed", REASON_INVITE_NEEDED],
    ["recently_left", "recently_left", REASON_RECENTLY_LEFT],
    ["already_member", "already_member", REASON_ALREADY_MEMBER],
    ["not_on_whatsapp", "not_on_whatsapp", REASON_NOT_ON_WHATSAPP],
    ["group_full", "group_full", REASON_GROUP_FULL],
    ["failed", "failed", REASON_WHATSAPP_REFUSED],
  ];
  for (const [o, state, reason] of cases) assert.deepEqual(memberStateForOutcome(o), { state, reason });
});

test("inviteText and key", () => {
  const t = inviteText({ subject: "x".repeat(100), inviteCode: "ABC123" });
  assert.ok(t.length <= 4096);
  assert.ok(t.endsWith("https://chat.whatsapp.com/ABC123"));
  assert.equal(inviteText({ subject: "Team", inviteCode: "K" }), `You're invited to the WhatsApp group "Team". Tap to join: https://chat.whatsapp.com/K`);
  assert.equal(inviteIdempotencyKey("m-1"), "grp-inv-m-1");
});

const mem = (id: string, phone: string, over: Partial<WhatsappGroupMember> = {}): WhatsappGroupMember => ({
  id, groupId: "g", phone, ghlContactId: null, displayName: null, state: "pending", jobId: "j1", inviteIdempotencyKey: null,
  consentConfirmedAt: "2026-10-17T00:00:00Z", addedByProfileId: null, lastReason: null, createdAt: "", updatedAt: "", ...over,
});
const P = (n: number) => `+4477009${String(n).padStart(5, "0")}`;
const job = (over: Partial<WhatsappGroupJob> = {}): WhatsappGroupJob => ({
  id: "j1", coachId: "c", groupJid: "1@g.us", status: "done", requestedCount: 8,
  results: [
    { phone: P(1), code: "200", outcome: "added" },
    { phone: P(2), code: "403", outcome: "invite_needed" },
    { phone: P(3), code: "403", outcome: "invite_needed" },
    { phone: P(4), code: "408", outcome: "recently_left" },
    { phone: P(5), code: "409", outcome: "already_member" },
    { phone: P(6), code: "404", outcome: "not_on_whatsapp" },
    { phone: P(7), code: "419", outcome: "group_full" },
    { phone: P(8), code: "500", outcome: "failed" },
  ],
  createdAt: "", finishedAt: null, ...over,
});

test("reconcileJob maps results, invites, opt-out", () => {
  const members = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => mem(`m${n}`, P(n)));
  const plan = reconcileJob(job(), members, new Set([P(3)]));
  const byId = Object.fromEntries(plan.updates.map((u) => [u.memberId, u]));
  assert.equal(plan.updates.length, 8);
  assert.deepEqual(byId.m1, { memberId: "m1", state: "added", reason: null });
  assert.deepEqual(byId.m2, { memberId: "m2", state: "invite_needed", reason: REASON_INVITE_NEEDED });
  assert.deepEqual(byId.m3, { memberId: "m3", state: "opted_out", reason: REASON_INVITE_SKIPPED_OPT_OUT });
  assert.equal(byId.m4.state, "recently_left");
  assert.equal(byId.m5.state, "already_member");
  assert.equal(byId.m6.state, "not_on_whatsapp");
  assert.equal(byId.m7.state, "group_full");
  assert.deepEqual(byId.m8, { memberId: "m8", state: "failed", reason: REASON_WHATSAPP_REFUSED });
  assert.deepEqual(plan.invites, [{ memberId: "m2", phone: P(2) }]);
});

test("reconcileJob is replay-safe and ignores other jobs", () => {
  const members = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => mem(`m${n}`, P(n)));
  const optedOut = new Set([P(3)]);
  const first = reconcileJob(job(), members, optedOut);
  const applied = members.map((m) => {
    const u = first.updates.find((x) => x.memberId === m.id);
    return u ? { ...m, state: u.state, lastReason: u.reason } : m;
  });
  assert.deepEqual(reconcileJob(job(), applied, optedOut), { updates: [], invites: [] });
  const other = members.map((m) => ({ ...m, jobId: "other" }));
  assert.deepEqual(reconcileJob(job(), other, optedOut), { updates: [], invites: [] });
});

test("reconcileJob interrupted fails remaining pending only", () => {
  const members = [mem("m1", P(1)), mem("m2", P(2)), mem("m3", P(3), { state: "added" }), mem("m4", P(4), { jobId: "other" })];
  const j = job({ status: "interrupted", results: [{ phone: P(1), code: "200", outcome: "added" }] });
  const plan = reconcileJob(j, members, new Set());
  assert.deepEqual(plan.updates, [
    { memberId: "m1", state: "added", reason: null },
    { memberId: "m2", state: "failed", reason: REASON_INTERRUPTED },
  ]);
  assert.deepEqual(plan.invites, []);
});

test("invite-needed copy promises a link to follow, not one already sent", () => {
  assert.equal(REASON_INVITE_NEEDED, "their privacy settings only allow invites — invite link to follow");
});

test("bridge refusal for no resolvable participants maps to the no-valid-numbers reason", () => {
  assert.equal(reasonForBridgeFailure("invalid_participants"), REASON_NO_VALID_NUMBERS);
});

test("the daily limits shown to customers equal the bridge's configured defaults", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(`${process.cwd()}/services/whatsapp-bridge/src/config.ts`, "utf8");
  assert.match(src, new RegExp(`"WA_GROUP_CREATES_DAILY_CAP", ${GROUP_CREATES_PER_DAY}\\)`));
  assert.match(src, new RegExp(`"WA_GROUP_ADDS_DAILY_CAP", ${GROUP_ADDS_PER_DAY}\\)`));
});
