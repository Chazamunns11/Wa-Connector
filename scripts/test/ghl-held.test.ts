/**
 * Reliability T8 — the held-message release pass. Offline: a small in-memory
 * repo and a fake bridge; nothing here can send a real WhatsApp message.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { releaseHeldOutboundMessages, type GhlHeldRepo } from "@/lib/ghl-held";
import { GHL_PROVIDER_REASONS, type GhlProviderDeps } from "@/lib/ghl-provider";
import { heldExpiredReason } from "@/lib/ghl-held-rules";
import type { Account, GhlAccount, GhlOutboundAttachment, GhlOutboundMessage } from "@/lib/types";
import type { BridgeSendResult, SendWhatsappAttachmentInput, SendWhatsappInput } from "@/lib/whatsapp-bridge";

const REASON_CAP_REACHED = GHL_PROVIDER_REASONS.capReached;
const TENANT = "11111111-1111-4111-8111-111111111111";
const LOC = "loc-1";
const NOW = Date.parse("2026-10-16T12:00:00Z");

function account(): GhlAccount {
  return {
    locationId: LOC, tenantId: TENANT, label: "T", companyId: null, conversationProviderId: null,
    accessToken: "tok", accessTokenExpiresAt: new Date(NOW + 3_600_000 + Date.now()).toISOString(), refreshToken: "r",
    status: "active", lastError: null, createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    accountId: "acc", activatedAt: "2026-10-01T00:00:00Z",
  };
}

function heldRow(n: number, ageHours: number, over: Partial<GhlOutboundMessage> = {}): GhlOutboundMessage {
  return {
    id: `row-${n}`, locationId: LOC, tenantId: TENANT, ghlMessageId: `m${n}`, ghlContactId: "c",
    idempotencyKey: `key-${n}`, toPhone: "+447700900123", hadAttachments: false, sendState: "held", sendAttempts: 0,
    pendingText: `text ${n}`, refusalReason: null, reportedStatus: null, reportedAt: null, reportError: null,
    createdAt: new Date(NOW - ageHours * 3_600_000).toISOString(), ...over,
  };
}

function setup(rowList: GhlOutboundMessage[]) {
  const rows = new Map(rowList.map((r) => [r.id, r]));
  const optOuts = new Set<string>();
  const ledger = new Set<string>();
  const parts = new Map<string, GhlOutboundAttachment>();
  // Multiple numbers and groups (merge): the location's numbers (slot 1 is
  // the account's own tenant) and group contacts keyed by GHL contact id.
  const numbers: { tenantId: string; slot: 1 | 2 | 3; isDefault: boolean; label: string | null }[] = [{ tenantId: TENANT, slot: 1, isDefault: true, label: null }];
  const groups = new Map<string, { tenantId: string; groupJid: string; enabled: boolean; left: boolean; numberRemoved: boolean }>();
  let failListTenants = false;
  let onIsOptedOut: (() => void) | undefined;
  let onLedgerRead: (() => void) | undefined;
  const repo = {
    async getGhlAccountByLocationId() { return account(); },
    async getAccountById(id: string) {
      return { id, name: "A", kind: "business", ownerEmail: "o@x.test", stripeCustomerId: null, stripeSubscriptionId: null, billingStatus: "active", trialEndsAt: null, cancelledAt: null, cleanedUpAt: null, createdAt: "2026-10-01T00:00:00Z" } as Account;
    },
    async isOptedOut(t: string, p: string) { onIsOptedOut?.(); return optOuts.has(`${t}:${p}`); },
    async getWhatsappSessionSummary() { return null; },
    async listLocationNumbers() { return numbers.map((n) => ({ ...n })); },
    async getWhatsappGroupByContact(_locationId: string, contactId: string) { return groups.get(contactId) ?? null; },
    async getWhatsappMessagesByTenantKeys(pairs: { tenantId: string; idempotencyKey: string }[]) {
      onLedgerRead?.();
      return pairs.filter((p) => ledger.has(p.idempotencyKey)).map((p) => ({ coachId: p.tenantId, idempotencyKey: p.idempotencyKey, status: "sent", error: null }));
    },
    async updateGhlOutboundSendState(id: string, patch: { sendState: GhlOutboundMessage["sendState"]; refusalReason?: string; sendAttempts?: number; onlyIfSendState?: GhlOutboundMessage["sendState"] }) {
      const row = rows.get(id)!;
      if (patch.onlyIfSendState !== undefined && row.sendState !== patch.onlyIfSendState) return 0;
      row.sendState = patch.sendState;
      if (patch.sendState !== "pending_send" && patch.sendState !== "held") row.pendingText = null;
      if (patch.sendState === "refused" && patch.refusalReason !== undefined) row.refusalReason = patch.refusalReason;
      return 1;
    },
    async markGhlOutboundReported(id: string, patch: { reportedStatus: GhlOutboundMessage["reportedStatus"]; reportError: string | null }) {
      const row = rows.get(id)!;
      if (patch.reportedStatus !== null) row.reportedStatus = patch.reportedStatus;
      row.reportError = patch.reportError;
    },
    async claimGhlTokenRefresh() { return true; },
    async saveGhlTokens() {},
    async markGhlNeedsReauth() {},
    async listHeldTenantIds() {
      if (failListTenants) throw new Error("db down");
      return [...new Set([...rows.values()].filter((r) => r.sendState === "held").map((r) => r.tenantId))];
    },
    async listHeldGhlOutboundMessages(tenantId: string, limit = 50) {
      return [...rows.values()].filter((r) => r.tenantId === tenantId && r.sendState === "held").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map((r) => ({ ...r }));
    },
    async listGhlOutboundAttachmentsForMessages(ids: string[]) {
      return [...parts.values()].filter((a) => ids.includes(a.outboundMessageId)).sort((a, b) => a.seq - b.seq).map((a) => ({ ...a }));
    },
    async updateGhlOutboundAttachmentSendState(id: string, patch: { sendState: GhlOutboundAttachment["sendState"]; refusalReason?: string }) {
      const part = parts.get(id)!;
      part.sendState = patch.sendState;
      if (patch.sendState !== "pending_send") part.pendingUrl = null;
      if (patch.sendState === "refused" && patch.refusalReason !== undefined) part.refusalReason = patch.refusalReason;
    },
    async listExpiredHeldGhlOutboundMessages(cutoffIso: string, limit = 50) {
      return [...rows.values()].filter((r) => r.createdAt < cutoffIso).filter((r) => r.sendState === "held" || r.sendState === "accepted").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map((r) => ({ ...r, sendState: "held" as const }));
    },
  } as unknown as GhlHeldRepo;

  const sendCalls: SendWhatsappInput[] = [];
  const statusCalls: { messageId: string; status: string; errorMessage?: string }[] = [];
  let sendImpl: (input: SendWhatsappInput, n: number) => BridgeSendResult = (input) => ({
    ok: true, replay: false,
    message: { id: "b", idempotencyKey: input.idempotencyKey, toPhone: input.to, status: "accepted", waMessageId: null, error: null, createdAt: "x", sentAt: null },
  });
  const attachCalls: SendWhatsappAttachmentInput[] = [];
  let attachImpl: (input: SendWhatsappAttachmentInput, n: number) => BridgeSendResult = (input) => ({
    ok: true, replay: false,
    message: { id: "b", idempotencyKey: input.idempotencyKey, toPhone: input.to, status: "accepted", waMessageId: null, error: null, createdAt: "x", sentAt: null },
  });
  const deps = {
    sendWhatsapp: async (input: SendWhatsappInput) => { sendCalls.push(input); const r = sendImpl(input, sendCalls.length); if (r.ok) ledger.add(input.idempotencyKey); return r; },
    sendAttachment: async (input: SendWhatsappAttachmentInput) => { attachCalls.push(input); const r = attachImpl(input, attachCalls.length); if (r.ok) ledger.add(input.idempotencyKey); return r; },
    updateStatus: async (_t: string, messageId: string, status: string, errorMessage?: string) => { statusCalls.push({ messageId, status, errorMessage }); return { ok: true }; },
    refreshToken: async () => ({ ok: false, kind: "invalid_grant" }),
    refreshWaitMs: 1,
    notify: () => {},
  } as unknown as GhlProviderDeps;
  return {
    repo, deps, rows, parts, optOuts, ledger, sendCalls, attachCalls, statusCalls, numbers, groups,
    setAttach(fn: typeof attachImpl) { attachImpl = fn; },
    setSend(fn: typeof sendImpl) { sendImpl = fn; },
    failTenants() { failListTenants = true; },
    onIsOptedOut(fn: () => void) { onIsOptedOut = fn; },
    onLedgerRead(fn: () => void) { onLedgerRead = fn; },
  };
}
const fail = (code: string): BridgeSendResult => ({ ok: false, code, message: code } as BridgeSendResult);

test("held rows are released oldest-first under their original keys and text, regardless of DB session status", async () => {
  const s = setup([heldRow(2, 3), heldRow(1, 5)]);
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.deepEqual(s.sendCalls.map((c) => [c.idempotencyKey, c.text]), [["key-1", "text 1"], ["key-2", "text 2"]]);
  assert.equal(s.rows.get("row-1")!.sendState, "accepted");
  assert.equal(s.rows.get("row-2")!.sendState, "accepted");
  assert.equal(res.released, 2);
  assert.equal(s.statusCalls.length, 0);
});

test("still disconnected: first send says session_not_connected -> stays held, loop stops, nothing reported", async () => {
  const s = setup([heldRow(1, 5), heldRow(2, 3)]);
  s.setSend(() => fail("session_not_connected"));
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length, 1);
  assert.equal(res.stillHeld, 1);
  assert.equal(s.rows.get("row-1")!.sendState, "held");
  assert.equal(s.rows.get("row-2")!.sendState, "held");
  assert.equal(s.statusCalls.length, 0);
});

test("mid-release drop: first accepted, second session_not_connected, rest stay held", async () => {
  const s = setup([heldRow(1, 5), heldRow(2, 4), heldRow(3, 3)]);
  s.setSend((input, n) => (n === 2 ? fail("session_not_connected") : { ok: true, replay: false, message: { id: "b", idempotencyKey: input.idempotencyKey, toPhone: input.to, status: "accepted", waMessageId: null, error: null, createdAt: "x", sentAt: null } }));
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length, 2);
  assert.equal(s.rows.get("row-1")!.sendState, "accepted");
  assert.equal(s.rows.get("row-2")!.sendState, "held");
  assert.equal(s.rows.get("row-3")!.sendState, "held");
  assert.equal(res.released, 1);
  assert.equal(res.stillHeld, 1);
});

test("daily cap during release: refused as capReached, reported failed, next row still attempted", async () => {
  const s = setup([heldRow(1, 5), heldRow(2, 4)]);
  s.setSend((input, n) => (n === 1 ? fail("daily_cap_reached") : { ok: true, replay: false, message: { id: "b", idempotencyKey: input.idempotencyKey, toPhone: input.to, status: "accepted", waMessageId: null, error: null, createdAt: "x", sentAt: null } }));
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.rows.get("row-1")!.sendState, "refused");
  assert.equal(s.rows.get("row-1")!.refusalReason, REASON_CAP_REACHED);
  assert.deepEqual(s.statusCalls, [{ messageId: "m1", status: "failed", errorMessage: REASON_CAP_REACHED }]);
  assert.equal(s.sendCalls.length, 2);
  assert.equal(res.refused, 1);
  assert.equal(res.released, 1);
});

test("opted out since being held: refused optedOut, never sent", async () => {
  const s = setup([heldRow(1, 5)]);
  s.optOuts.add(`${TENANT}:+447700900123`);
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length, 0);
  assert.equal(s.rows.get("row-1")!.refusalReason, GHL_PROVIDER_REASONS.optedOut);
  assert.equal(s.statusCalls[0].status, "failed");
  assert.equal(res.refused, 1);
});

test("expired: refused with heldExpiredReason(24) and reported failed, not sent", async () => {
  const s = setup([heldRow(1, 25)]);
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length, 0);
  assert.equal(s.rows.get("row-1")!.sendState, "refused");
  assert.equal(s.rows.get("row-1")!.refusalReason, heldExpiredReason(24));
  assert.deepEqual(s.statusCalls, [{ messageId: "m1", status: "failed", errorMessage: heldExpiredReason(24) }]);
  assert.equal(res.expired, 1);
});

test("expiry guard: a row a concurrent pass moved on between listing and the guarded write is not reported failed", async () => {
  const s = setup([heldRow(1, 25)]);
  // the other pass accepts the row (no ledger entry visible yet) just before our guarded refuse
  s.onLedgerRead(() => { s.rows.get("row-1")!.sendState = "accepted"; });
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.rows.get("row-1")!.sendState, "accepted");
  assert.equal(s.statusCalls.length, 0);
  assert.equal(res.reportFailed, 0);
});

test("lost race on a gate refusal: the other pass won the row, so GoHighLevel is not told it failed", async () => {
  const s = setup([heldRow(1, 5)]);
  s.optOuts.add(`${TENANT}:+447700900123`);
  s.onIsOptedOut(() => { s.rows.get("row-1")!.sendState = "accepted"; });
  await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.rows.get("row-1")!.sendState, "accepted");
  assert.equal(s.statusCalls.length, 0);
  assert.equal(s.rows.get("row-1")!.reportedStatus, null);
});

test("never sent late: with more expired rows than the sweep batch, none is sent", async () => {
  const s = setup(Array.from({ length: 60 }, (_, i) => heldRow(i + 1, 30 + i * 0.001)));
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length, 0);
  assert.equal(res.expired, 60);
  assert.equal(s.statusCalls.length, 60);
});

test("OUTBOUND_HOLD_MAX_HOURS=48: a 30h-old row is released, not expired", async () => {
  const s = setup([heldRow(1, 30)]);
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, { OUTBOUND_HOLD_MAX_HOURS: "48" });
  assert.equal(res.expired, 0);
  assert.equal(res.released, 1);
});

test("a row with no phone or text is refused defensively", async () => {
  const s = setup([heldRow(1, 5, { pendingText: null })]);
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length, 0);
  assert.equal(s.rows.get("row-1")!.sendState, "refused");
  assert.equal(res.refused, 1);
});

test("transient bridge failure: row stays held, next row still attempted", async () => {
  const s = setup([heldRow(1, 5), heldRow(2, 4)]);
  s.setSend((input, n) => (n === 1 ? fail("unreachable") : { ok: true, replay: false, message: { id: "b", idempotencyKey: input.idempotencyKey, toPhone: input.to, status: "accepted", waMessageId: null, error: null, createdAt: "x", sentAt: null } }));
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.rows.get("row-1")!.sendState, "held");
  assert.equal(s.rows.get("row-2")!.sendState, "accepted");
  assert.equal(res.stillHeld, 1);
});

test("never throws when listHeldTenantIds rejects", async () => {
  const s = setup([heldRow(1, 5)]);
  s.failTenants();
  const orig = console.error;
  console.error = () => {};
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {}).finally(() => { console.error = orig; });
  assert.equal(res.released, 0);
  assert.equal(s.sendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// F2 — held picture/file messages: released text first, then attachments in
// seq order; a re-drop mid-message keeps the remaining parts held and the
// bridge ledger stops any part going out twice.
// ---------------------------------------------------------------------------
function mediaRow(n: number, ageHours: number, over: Partial<GhlOutboundMessage> = {}): GhlOutboundMessage {
  return heldRow(n, ageHours, { hadAttachments: true, ...over });
}
function addParts(s: ReturnType<typeof setup>, rowId: string, key: string, count: number) {
  for (let seq = 0; seq < count; seq++) {
    const id = `${rowId}-att-${seq}`;
    s.parts.set(id, { id, outboundMessageId: rowId, seq, idempotencyKey: `${key}-att-${seq}`, pendingUrl: `https://x/${seq}.jpg`, fileName: null, sendState: "pending_send", refusalReason: null, sendAttempts: 0, createdAt: "x" });
  }
}
const partStates = (s: ReturnType<typeof setup>) => [...s.parts.values()].sort((a, b) => a.seq - b.seq).map((p) => p.sendState);
const notConnected = fail("session_not_connected");

test("F2 release: held media message goes out text then attachments in seq order, then parent and parts are accepted", async () => {
  const s = setup([mediaRow(1, 3)]);
  addParts(s, "row-1", "key-1", 2);
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.deepEqual(s.sendCalls.map((c) => c.text), ["text 1"]);
  assert.deepEqual(s.attachCalls.map((c) => c.attachment.url), ["https://x/0.jpg", "https://x/1.jpg"]);
  assert.equal(s.rows.get("row-1")!.sendState, "accepted");
  assert.deepEqual(partStates(s), ["accepted", "accepted"]);
  assert.equal(res.released, 1);
  assert.equal(s.statusCalls.length, 0, "delivery is reported later by the status drain");
});

test("F2 release: attachments-only held message (no text) sends the attachments and the parent ends with the internal no-text marker", async () => {
  const s = setup([mediaRow(1, 3, { pendingText: null })]);
  addParts(s, "row-1", "key-1", 1);
  await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length, 0);
  assert.equal(s.attachCalls.length, 1);
  assert.equal(s.rows.get("row-1")!.sendState, "refused");
  assert.match(s.rows.get("row-1")!.refusalReason!, /media plan internal/);
});

test("F2 release: re-drop mid-message keeps the rest held; next pass sends only what is missing (no duplicate)", async () => {
  const s = setup([mediaRow(1, 3), heldRow(2, 2)]);
  addParts(s, "row-1", "key-1", 3);
  s.setAttach((input, n) => (n === 2 ? notConnected : { ok: true, replay: false, message: { id: "b", idempotencyKey: input.idempotencyKey, toPhone: input.to, status: "accepted", waMessageId: null, error: null, createdAt: "x", sentAt: null } }));
  const first = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(first.stillHeld, 1);
  assert.equal(s.rows.get("row-1")!.sendState, "held");
  assert.equal(s.rows.get("row-1")!.pendingText, "text 1");
  assert.equal(s.rows.get("row-2")!.sendState, "held", "the later message waits behind the interrupted one");
  assert.deepEqual(partStates(s), ["accepted", "pending_send", "pending_send"]);
  s.setAttach((input) => ({ ok: true, replay: false, message: { id: "b", idempotencyKey: input.idempotencyKey, toPhone: input.to, status: "accepted", waMessageId: null, error: null, createdAt: "x", sentAt: null } }));
  await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  const everySentKey = [...s.sendCalls.map((c) => c.idempotencyKey), ...s.attachCalls.map((c) => c.idempotencyKey)];
  const sentCounts = new Map<string, number>();
  for (const k of everySentKey) sentCounts.set(k, (sentCounts.get(k) ?? 0) + 1);
  // the one failed attachment attempt (key-1-att-1) is the only key seen twice: once refused offline, once accepted
  assert.deepEqual([...sentCounts].filter(([, c]) => c > 1).map(([k]) => k), ["key-1-att-1"]);
  assert.equal(s.sendCalls.filter((c) => c.idempotencyKey === "key-1").length, 1, "text part never re-sent");
  assert.equal(s.attachCalls.filter((c) => c.idempotencyKey === "key-1-att-0").length, 1, "accepted attachment never re-sent");
  assert.equal(s.rows.get("row-1")!.sendState, "accepted");
  assert.equal(s.rows.get("row-2")!.sendState, "accepted");
  assert.deepEqual(partStates(s), ["accepted", "accepted", "accepted"]);
});

test("F2 release: a drop on the text part sends no attachment and leaves everything held", async () => {
  const s = setup([mediaRow(1, 3)]);
  addParts(s, "row-1", "key-1", 2);
  s.setSend(() => notConnected);
  await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.attachCalls.length, 0);
  assert.equal(s.rows.get("row-1")!.sendState, "held");
  assert.deepEqual(partStates(s), ["pending_send", "pending_send"]);
});

test("F2 release: expired media message is refused with every pending part, reported failed, nothing sent", async () => {
  const s = setup([mediaRow(1, 30)]);
  addParts(s, "row-1", "key-1", 2);
  const res = await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(res.expired, 1);
  assert.equal(s.sendCalls.length + s.attachCalls.length, 0);
  assert.equal(s.rows.get("row-1")!.sendState, "refused");
  assert.deepEqual(partStates(s), ["refused", "refused"]);
  assert.deepEqual(s.statusCalls.map((c) => [c.status, c.errorMessage]), [["failed", heldExpiredReason(24)]]);
});

test("F2 release: contact opted out while held -> refused optedOut, parts refused, nothing sent", async () => {
  const s = setup([mediaRow(1, 3)]);
  addParts(s, "row-1", "key-1", 2);
  s.optOuts.add(`${TENANT}:+447700900123`);
  await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length + s.attachCalls.length, 0);
  assert.deepEqual(partStates(s), ["refused", "refused"]);
  assert.deepEqual(s.statusCalls.map((c) => [c.status, c.errorMessage]), [["failed", GHL_PROVIDER_REASONS.optedOut]]);
});

test("F2 release: opted out after the text part already went -> remaining parts refused, no failed report (the status drain reports the partial delivery)", async () => {
  const s = setup([mediaRow(1, 3)]);
  addParts(s, "row-1", "key-1", 2);
  s.ledger.add("key-1");
  s.optOuts.add(`${TENANT}:+447700900123`);
  await releaseHeldOutboundMessages(s.repo, s.deps, NOW, {});
  assert.equal(s.sendCalls.length + s.attachCalls.length, 0);
  assert.deepEqual(partStates(s), ["refused", "refused"]);
  assert.equal(s.rows.get("row-1")!.sendState, "accepted");
  assert.equal(s.statusCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Merge: multiple numbers and opt-in groups
// ---------------------------------------------------------------------------

const SECOND = "22222222-2222-4222-8222-222222222222";
const GROUP_JID = "120363012345678901@g.us";

test("merge: a held row on a non-default number is released from THAT number only", async () => {
  const h = setup([heldRow(1, 1, { tenantId: SECOND })]);
  h.numbers.push({ tenantId: SECOND, slot: 2, isDefault: false, label: "Sales" });
  const r = await releaseHeldOutboundMessages(h.repo, h.deps, NOW, {});
  assert.equal(r.released, 1);
  assert.deepEqual(h.sendCalls.map((c) => c.coachId), [SECOND]);
});

test("merge: a held GROUP row (no phone) is released to its group on the row's own number", async () => {
  const h = setup([heldRow(1, 1, { tenantId: SECOND, toPhone: null, ghlContactId: "group-contact" })]);
  h.numbers.push({ tenantId: SECOND, slot: 2, isDefault: false, label: null });
  h.groups.set("group-contact", { tenantId: SECOND, groupJid: GROUP_JID, enabled: true, left: false, numberRemoved: false });
  const r = await releaseHeldOutboundMessages(h.repo, h.deps, NOW, {});
  assert.equal(r.released, 1);
  assert.equal(h.sendCalls.length, 1);
  assert.equal(h.sendCalls[0].coachId, SECOND);
  assert.equal((h.sendCalls[0] as { groupJid?: string }).groupJid, GROUP_JID);
  assert.equal((h.sendCalls[0] as { to?: string }).to, undefined);
});

test("merge: a STOP recorded on ANOTHER number of the location refuses the held row with the other-number string", async () => {
  const h = setup([heldRow(1, 1, { tenantId: SECOND })]);
  h.numbers.push({ tenantId: SECOND, slot: 2, isDefault: false, label: null });
  h.optOuts.add(`${TENANT}:+447700900123`);
  const r = await releaseHeldOutboundMessages(h.repo, h.deps, NOW, {});
  assert.equal(r.refused, 1);
  assert.equal(h.sendCalls.length, 0);
  assert.equal(h.rows.get("row-1")!.refusalReason, GHL_PROVIDER_REASONS.optedOutOtherNumber);
});
