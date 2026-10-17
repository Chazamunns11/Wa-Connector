/**
 * Group invites (src/lib/group-invites.ts): template validation and rendering,
 * contact resolution, and sending. Fully offline: every dependency is a fake.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GROUP_INVITE_TEMPLATE,
  INVITE_TEMPLATE_MISSING_LINK,
  renderInviteMessage,
  resolveInvitees,
  sendGroupInvites,
  validateInviteTemplate,
  type Invitee,
  type ResolveInviteesDeps,
  type SendGroupInvitesDeps,
} from "@/lib/group-invites";
import type { GhlContactLite } from "@/lib/ghl";
import type { HandleProviderOutboundOutcome } from "@/lib/ghl-provider";
import type { BridgeParticipantResult } from "@/lib/whatsapp-bridge";
import type { GhlAccount } from "@/lib/types";

const LINK = "https://chat.whatsapp.com/AbC123xyz0";
const ACCOUNT = { locationId: "loc-1", tenantId: "tenant-1" } as GhlAccount;
const GROUP = { jid: "120363012345678901@g.us", name: "Spring Cohort" };

const contact = (id: string, over: Partial<GhlContactLite> = {}): GhlContactLite => ({
  id,
  firstName: id,
  name: `${id} Name`,
  phone: null,
  tags: [],
  ...over,
});

function resolveDeps(contacts: GhlContactLite[], optedOut: string[] = []): ResolveInviteesDeps & { optedOutChecks: string[] } {
  const optedOutChecks: string[] = [];
  return {
    optedOutChecks,
    getContact: async (_t, id) => {
      const c = contacts.find((x) => x.id === id);
      return c ? { ok: true, contact: c } : { ok: false, error: "x" };
    },
    searchContacts: async () => ({ ok: true, contacts, truncated: false }),
    optedOutReason: async (_l, _t, phone) => {
      optedOutChecks.push(phone);
      return optedOut.includes(phone) ? "opted out" : null;
    },
  };
}

const RESOLVE_INPUT = { accessToken: "tok", locationId: "loc-1", tenantId: "tenant-1" };

function sendDeps(over: Partial<SendGroupInvitesDeps> = {}): SendGroupInvitesDeps & {
  texts: { contactId: string; text: string; tenantId: string }[];
  adds: string[][];
} {
  const texts: { contactId: string; text: string; tenantId: string }[] = [];
  const adds: string[][] = [];
  return {
    texts,
    adds,
    getInvite: async () => ({ ok: true, link: LINK }),
    updateParticipants: async (_c, _j, req) => {
      if (req.action !== "add") throw new Error("unexpected");
      adds.push(req.phones);
      return { ok: true, results: req.phones.map((phone) => ({ phone, result: "ok" as const })) };
    },
    getTemplate: async () => null,
    hasInboundFromPhone: async () => false,
    optedOutReason: async () => null,
    sendText: async (i) => {
      texts.push({ contactId: i.ghlContactId, text: i.text, tenantId: i.tenantId });
      return { kind: "accepted" };
    },
    ...over,
  };
}

const invitee = (id: string, phone: string): Invitee => ({ contactId: id, firstName: id, phone });
const SEND_INPUT = { account: ACCOUNT, tenantId: "tenant-1", group: GROUP, directAdd: false, coachName: "Coach Jo" };

test("template: saving without {link} is refused", () => {
  assert.deepEqual(validateInviteTemplate("Join us"), { ok: false, message: "The invite message must include {link}." });
  assert.equal(INVITE_TEMPLATE_MISSING_LINK, "The invite message must include {link}.");
  assert.deepEqual(validateInviteTemplate(undefined), { ok: false, message: INVITE_TEMPLATE_MISSING_LINK });
});

test("template: 501 code points refused, 500 accepted, trimmed", () => {
  const pad = (n: number) => "😀".repeat(n - "{link}".length) + "{link}";
  assert.equal(validateInviteTemplate(pad(501)).ok, false);
  const ok = validateInviteTemplate(`  ${pad(500)}  `);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && [...ok.template].length, 500);
});

test("template: the default renders the example message", () => {
  assert.equal(
    renderInviteMessage(DEFAULT_GROUP_INVITE_TEMPLATE, { firstName: "Sam", groupName: "Spring Cohort", coachName: "Coach Jo", link: LINK }),
    `Hi Sam, Coach Jo invited you to join Spring Cohort on WhatsApp: ${LINK}`
  );
});

test("render: no first name → \"Hi there\"; {link} twice → both replaced; other braces and $ left alone", () => {
  assert.equal(
    renderInviteMessage(DEFAULT_GROUP_INVITE_TEMPLATE, { firstName: null, groupName: "G", coachName: "C", link: LINK }),
    `Hi there, C invited you to join G on WhatsApp: ${LINK}`
  );
  assert.equal(renderInviteMessage("{link} or {link} {other} {first_name}", { firstName: "$&", groupName: "G", coachName: "C", link: "L" }), "L or L {other} $&");
});

test("resolve: tag pulls in a group contact, a phoneless contact and two contacts sharing a phone", async () => {
  const deps = resolveDeps([
    contact("g", { phone: "+447700900001", tags: ["WhatsApp-Group"] }),
    contact("np"),
    contact("a", { phone: "07700 900123" }),
    contact("b", { phone: "+447700900123" }),
  ]);
  const res = await resolveInvitees(deps, { ...RESOLVE_INPUT, tag: "cohort" });
  assert.ok(res.ok);
  assert.deepEqual(res.invitees, [{ contactId: "a", firstName: "a", phone: "+447700900123" }]);
  assert.deepEqual(
    res.skipped.map((s) => [s.contactId, s.reason]),
    [["g", "group_contact"], ["np", "no_phone"], ["b", "duplicate_phone"]]
  );
  assert.equal(res.truncated, false);
});

test("resolve: an opted-out contact is skipped as opted_out and never reaches sendGroupInvites or the bridge add", async () => {
  const deps = resolveDeps([contact("a", { phone: "+447700900123" }), contact("b", { phone: "+447700900124" })], ["+447700900123"]);
  const res = await resolveInvitees(deps, { ...RESOLVE_INPUT, contactIds: ["a", "b"] });
  assert.ok(res.ok);
  assert.deepEqual(res.skipped.map((s) => [s.contactId, s.reason]), [["a", "opted_out"]]);
  assert.deepEqual(res.invitees.map((i) => i.contactId), ["b"]);

  const send = sendDeps({ hasInboundFromPhone: async () => true });
  await sendGroupInvites(send, { ...SEND_INPUT, directAdd: true, invitees: res.invitees });
  assert.deepEqual(send.adds, [["+447700900124"]]);
  assert.ok(!send.texts.some((t) => t.contactId === "a"));
});

test("resolve: a failed GHL read is a fixed message; no ids and no tag is refused", async () => {
  const deps = resolveDeps([]);
  const missing = await resolveInvitees(deps, { ...RESOLVE_INPUT, contactIds: ["nope"] });
  assert.equal(missing.ok, false);
  const none = await resolveInvitees(deps, RESOLVE_INPUT);
  assert.equal(none.ok, false);
});

test("resolve: more than 100 contact ids are capped and flagged truncated", async () => {
  const all = Array.from({ length: 101 }, (_, n) => contact(`c${n}`, { phone: `+4477009${String(10000 + n)}` }));
  const res = await resolveInvitees(resolveDeps(all), { ...RESOLVE_INPUT, contactIds: all.map((c) => c.id) });
  assert.ok(res.ok);
  assert.equal(res.invitees.length, 100);
  assert.equal(res.truncated, true);
});

test("send: each invite goes through sendAppOriginatedText on the group's tenant, in order", async () => {
  const deps = sendDeps();
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002")] });
  assert.deepEqual(deps.texts.map((t) => [t.contactId, t.tenantId]), [["a", "tenant-1"], ["b", "tenant-1"]]);
  assert.equal(deps.texts[0].text, `Hi a, Coach Jo invited you to join Spring Cohort on WhatsApp: ${LINK}`);
  assert.equal(res.sent, 2);
  assert.deepEqual(res.delivered, deps.texts.map((t) => ({ contactId: t.contactId, text: t.text, outcome: "accepted" })));
  assert.deepEqual(deps.adds, []);
});

test("send: the sub-account's template is used; a stored template without {link} falls back to the default", async () => {
  const custom = sendDeps({ getTemplate: async () => "Join {group_name}: {link}" });
  await sendGroupInvites(custom, { ...SEND_INPUT, invitees: [invitee("a", "+447700900001")] });
  assert.equal(custom.texts[0].text, `Join Spring Cohort: ${LINK}`);
  const bad = sendDeps({ getTemplate: async () => "no link here" });
  await sendGroupInvites(bad, { ...SEND_INPUT, invitees: [invitee("a", "+447700900001")] });
  assert.equal(bad.texts[0].text, `Hi a, Coach Jo invited you to join Spring Cohort on WhatsApp: ${LINK}`);
});

test("send: direct add only for people who messaged before; the added get no message", async () => {
  const deps = sendDeps({ hasInboundFromPhone: async (_t, p) => p === "+447700900001" });
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, directAdd: true, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002")] });
  assert.deepEqual(deps.adds, [["+447700900001"]]);
  assert.deepEqual(res.added, ["a"]);
  assert.deepEqual(deps.texts.map((t) => t.contactId), ["b"]);
  assert.deepEqual(res.delivered.map((d) => d.contactId), ["b"]);
});

test("send: a direct add refused for privacy falls back to the link message", async () => {
  const deps = sendDeps({
    hasInboundFromPhone: async () => true,
    updateParticipants: async (_c, _j, req) => ({
      ok: true,
      results: (req.action === "add" ? req.phones : []).map((phone): BridgeParticipantResult => ({ phone, result: phone.endsWith("1") ? "ok" : "invite_required" })),
    }),
  });
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, directAdd: true, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002")] });
  assert.deepEqual(res.added, ["a"]);
  assert.deepEqual(deps.texts.map((t) => t.contactId), ["b"]);
  assert.equal(res.sent, 1);
});

test("send: add limit reached → the rest get links (also when the whole call is refused)", async () => {
  const some = sendDeps({
    hasInboundFromPhone: async () => true,
    updateParticipants: async (_c, _j, req) => ({
      ok: true,
      results: (req.action === "add" ? req.phones : []).map((phone): BridgeParticipantResult => ({ phone, result: phone.endsWith("1") ? "ok" : "limit_reached" })),
    }),
  });
  const r1 = await sendGroupInvites(some, { ...SEND_INPUT, directAdd: true, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002")] });
  assert.deepEqual(r1.added, ["a"]);
  assert.deepEqual(some.texts.map((t) => t.contactId), ["b"]);

  const none = sendDeps({
    hasInboundFromPhone: async () => true,
    updateParticipants: async () => ({ ok: false, code: "add_limit", message: "limit" }),
  });
  const r2 = await sendGroupInvites(none, { ...SEND_INPUT, directAdd: true, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002")] });
  assert.deepEqual(r2.added, []);
  assert.deepEqual(none.texts.map((t) => t.contactId), ["a", "b"]);
  assert.deepEqual(r2.refused, []);
});

test("send: more than 50 direct adds are chunked", async () => {
  const many = Array.from({ length: 120 }, (_, n) => invitee(`c${n}`, `+4477009${String(10000 + n)}`));
  const deps = sendDeps({ hasInboundFromPhone: async () => true });
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, directAdd: true, invitees: many });
  assert.deepEqual(deps.adds.map((a) => a.length), [50, 50, 20]);
  assert.equal(res.added.length, 120);
  assert.equal(deps.texts.length, 0);
});

test("send: an opted-out phone is never directly added", async () => {
  const deps = sendDeps({ hasInboundFromPhone: async () => true, optedOutReason: async () => "opted out" });
  await sendGroupInvites(deps, { ...SEND_INPUT, directAdd: true, invitees: [invitee("a", "+447700900001")] });
  assert.deepEqual(deps.adds, []);
});

test("send: a held invite is counted in held, not refused", async () => {
  const deps = sendDeps({ sendText: async () => ({ kind: "held" }) });
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, invitees: [invitee("a", "+447700900001")] });
  assert.equal(res.held, 1);
  assert.equal(res.sent, 0);
  assert.deepEqual(res.refused, []);
  assert.deepEqual(res.delivered.map((d) => d.outcome), ["held"]);
});

test("send: outcome mapping — pending_retry is sent, refused keeps its reason, error is a fixed string", async () => {
  const outcomes: HandleProviderOutboundOutcome[] = [{ kind: "pending_retry" }, { kind: "refused", reason: "Opted out" }, { kind: "error", recorded: true }];
  let n = 0;
  const deps = sendDeps({ sendText: async () => outcomes[n++] });
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002"), invitee("c", "+447700900003")] });
  assert.equal(res.sent, 1);
  assert.deepEqual(res.delivered.map((d) => [d.contactId, d.outcome]), [["a", "pending_retry"]]);
  assert.deepEqual(res.refused, [
    { contactId: "b", reason: "Opted out" },
    { contactId: "c", reason: "Couldn't send the invite — try again" },
  ]);
});

test("send: no invite link → everyone refused, nothing added or sent", async () => {
  const deps = sendDeps({ getInvite: async () => ({ ok: false, code: "not_admin", message: "x" }), hasInboundFromPhone: async () => true });
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, directAdd: true, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002")] });
  assert.deepEqual(deps.adds, []);
  assert.deepEqual(deps.texts, []);
  assert.equal(res.refused.length, 2);
  assert.equal(res.refused[0].reason, res.refused[1].reason);
  assert.equal(res.sent + res.held + res.added.length + res.delivered.length, 0);
});

test("resolve: a 404 contact is skipped as not_found; any other lookup error fails the whole resolve", async () => {
  const deps = resolveDeps([contact("a", { phone: "+447700900123" })]);
  deps.getContact = async (_t, id) => {
    if (id === "a") return { ok: true, contact: contact("a", { phone: "+447700900123" }) };
    if (id === "gone") return { ok: false, error: "x", notFound: true };
    return { ok: false, error: "x" };
  };
  const res = await resolveInvitees(deps, { ...RESOLVE_INPUT, contactIds: ["gone", "a"] });
  assert.ok(res.ok);
  assert.deepEqual(res.skipped, [{ contactId: "gone", name: null, reason: "not_found" }]);
  assert.deepEqual(res.invitees.map((i) => i.contactId), ["a"]);
  const bad = await resolveInvitees(deps, { ...RESOLVE_INPUT, contactIds: ["a", "boom"] });
  assert.equal(bad.ok, false);
});

test("resolve: contact lookups run at most 5 at a time and keep input order", async () => {
  const all = Array.from({ length: 12 }, (_, n) => contact(`c${n}`, { phone: `+4477009${String(10000 + n)}` }));
  const deps = resolveDeps(all);
  let active = 0;
  let peak = 0;
  deps.getContact = async (_t, id) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, id === "c0" ? 15 : 1));
    active--;
    return { ok: true, contact: all.find((c) => c.id === id)! };
  };
  const res = await resolveInvitees(deps, { ...RESOLVE_INPUT, contactIds: all.map((c) => c.id) });
  assert.ok(res.ok);
  assert.deepEqual(res.invitees.map((i) => i.contactId), all.map((c) => c.id));
  assert.equal(peak, 5);
});

test("send: already_member is reported separately from added", async () => {
  const deps = sendDeps({
    hasInboundFromPhone: async () => true,
    updateParticipants: async (_c, _j, req) => ({
      ok: true,
      results: (req.action === "add" ? req.phones : []).map((phone): BridgeParticipantResult => ({ phone, result: phone.endsWith("1") ? "ok" : "already_member" })),
    }),
  });
  const res = await sendGroupInvites(deps, { ...SEND_INPUT, directAdd: true, invitees: [invitee("a", "+447700900001"), invitee("b", "+447700900002")] });
  assert.deepEqual(res.added, ["a"]);
  assert.deepEqual(res.alreadyMember, ["b"]);
  assert.deepEqual(deps.texts, []);
});
