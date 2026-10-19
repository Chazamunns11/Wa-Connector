/**
 * SMS fallback B (docs/superpowers/plans/2026-10-17-sms-fallback-b.md): when a
 * contact isn't on WhatsApp the text goes out as an SMS through GHL, with a
 * loop guard for a sub-account whose SMS provider is PingWren itself.
 * Offline: an in-memory repo, a fake bridge, a fake GHL status call and a fake
 * SMS call. Any repo method a test did not expect throws.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { drainGhlOutboundStatuses, handleProviderOutboundMessage, GHL_PROVIDER_REASONS, type GhlProviderDeps, type GhlProviderRepo } from "@/lib/ghl-provider";
import { trySmsFallback } from "@/lib/sms-fallback";
import { normaliseSmsFallbackText, REASON_SENT_AS_SMS, REASON_SMS_FALLBACK_LOOP, SMS_FALLBACK_CLAIM_BUSY_MS, SMS_FALLBACK_ECHO_MS, smsFallbackTextSha256 } from "@/lib/sms-fallback-shared";
import type { GhlAccount, GhlOutboundAttachment, GhlOutboundMessage, GhlOutboundMessageDraft } from "@/lib/types";

const LOCATION = "loc-sms";
const TENANT = "22222222-2222-4222-8222-222222222222";
const CONTACT = "contact-sms-1";
const PHONE = "+447700900555";
const OUR_NUMBER = "+447700900111";

const SENT_REASON = "Not on WhatsApp — sent as SMS instead";
const LOOP_REASON = "This sub-account sends SMS through PingWren, so the SMS fallback can't be used — not sent";

const envBefore = { sms: process.env.GHL_SMS_FALLBACK_ENABLED, triggers: process.env.GHL_WORKFLOW_TRIGGERS_ENABLED };
afterEach(() => {
  for (const [name, value] of [
    ["GHL_SMS_FALLBACK_ENABLED", envBefore.sms],
    ["GHL_WORKFLOW_TRIGGERS_ENABLED", envBefore.triggers],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function flags({ sms = true, triggers = true }: { sms?: boolean; triggers?: boolean } = {}) {
  if (sms) process.env.GHL_SMS_FALLBACK_ENABLED = "true";
  else delete process.env.GHL_SMS_FALLBACK_ENABLED;
  if (triggers) process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = "true";
  else delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
}

function makeAccount(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: LOCATION,
    tenantId: TENANT,
    label: "SMS Location",
    companyId: null,
    conversationProviderId: null,
    accessToken: "loc-token",
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshToken: "refresh",
    status: "active",
    lastError: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    connectLinkVersion: 0,
    brandLogoPath: null,
    brandAccentColor: null,
    accountId: "acc-1",
    activatedAt: "2026-10-01T00:00:00Z",
    showReactions: false,
    showDeletes: false,
    smsFallbackEnabled: true,
    smsFallbackBlockedAt: null,
    ...overrides,
  };
}

function makeWorld(accountOverrides: Partial<GhlAccount> = {}) {
  const account = makeAccount(accountOverrides);
  const rows = new Map<string, GhlOutboundMessage>();
  const attachments: GhlOutboundAttachment[] = [];
  const ledger = new Map<string, { status: string; error: string | null }>();
  /** Keyed `${locationId}|${contactId}` (one echo per contact). */
  const echoes = new Map<string, { textSha256: string; outboundMessageId: string; ghlMessageId: string | null; sentAt: string | null; expiresAt: string }>();
  const optOuts = new Set<string>();
  const remembered = new Map<string, string>();
  const groups = new Map<string, { tenantId: string; groupJid: string; enabled: boolean; left: boolean }>();
  const calls: string[] = [];
  const fail = { find: false, optOutReads: 0 };
  let nextId = 1;

  const impl: Record<string, (...args: never[]) => Promise<unknown>> = {
    async getGhlAccountByLocationId(locationId: string) {
      return locationId === LOCATION ? account : null;
    },
    async getAccountById(id: string) {
      return { id, billingStatus: "active" };
    },
    async listLocationNumbers() {
      return [{ tenantId: TENANT, slot: 1, isDefault: true, label: null }];
    },
    async getStickyTenant() {
      return null;
    },
    async getWhatsappGroupByContact(_locationId: string, contactId: string) {
      return groups.get(contactId) ?? null;
    },
    async getTenantPhone() {
      return OUR_NUMBER;
    },
    async claimGhlTokenRefresh() {
      return true;
    },
    async isOptedOut(tenantId: string, phone: string) {
      if (fail.optOutReads > 0) {
        fail.optOutReads--;
        throw new Error("db down");
      }
      return optOuts.has(`${tenantId}:${phone}`);
    },
    async isRememberedNotOnWhatsapp(locationId: string, phone: string, nowIso: string) {
      const until = remembered.get(`${locationId}:${phone}`);
      return until !== undefined && until > nowIso;
    },
    async rememberNotOnWhatsapp(locationId: string, phone: string, untilIso: string) {
      remembered.set(`${locationId}:${phone}`, untilIso);
    },
    async listHeldGhlOutboundMessages() {
      return [];
    },
    async recordGhlOutboundMessage(draft: GhlOutboundMessageDraft) {
      const existing = [...rows.values()].find((r) => r.ghlMessageId === draft.ghlMessageId);
      if (existing) return { message: existing, isNew: false };
      const row: GhlOutboundMessage = {
        id: `row-${nextId++}`,
        ...draft,
        sendState: "pending_send",
        sendAttempts: 0,
        refusalReason: null,
        reportedStatus: null,
        reportedAt: null,
        reportError: null,
        readReportedAt: null,
        readReportError: null,
        smsFallback: null,
        createdAt: new Date(Date.now() + nextId).toISOString(),
      };
      rows.set(row.id, row);
      return { message: row, isNew: true };
    },
    async updateGhlOutboundSendState(id: string, patch: { sendState: GhlOutboundMessage["sendState"]; refusalReason?: string }) {
      const row = rows.get(id)!;
      row.sendState = patch.sendState;
      const keep = process.env.GHL_WORKFLOW_TRIGGERS_ENABLED === "true" || process.env.GHL_SMS_FALLBACK_ENABLED === "true";
      if (patch.sendState === "refused" || (patch.sendState === "accepted" && !keep)) row.pendingText = null;
      if (patch.sendState === "refused" && patch.refusalReason !== undefined) row.refusalReason = patch.refusalReason;
      return 1;
    },
    async listUnreportedGhlOutboundMessages() {
      return [...rows.values()].filter((r) => r.reportedStatus === null).map((r) => ({ ...r }));
    },
    async listGhlOutboundAttachmentsForMessages(ids: string[]) {
      return attachments.filter((a) => ids.includes(a.outboundMessageId));
    },
    async getWhatsappMessagesByTenantKeys(pairs: { tenantId: string; idempotencyKey: string }[]) {
      return pairs.flatMap((p) => {
        const e = ledger.get(p.idempotencyKey);
        return e ? [{ coachId: p.tenantId, idempotencyKey: p.idempotencyKey, ...e }] : [];
      });
    },
    async markGhlOutboundReported(id: string, patch: { reportedStatus: GhlOutboundMessage["reportedStatus"]; reportError: string | null }) {
      const row = rows.get(id)!;
      if (row.reportedStatus !== null) return false;
      if (patch.reportedStatus !== null) {
        row.reportedStatus = patch.reportedStatus;
        row.pendingText = null;
      }
      row.reportError = patch.reportError;
      return true;
    },
    async recordSmsFallbackEcho(
      echo: { locationId: string; contactId: string; textSha256: string; outboundMessageId: string; expiresIso: string },
      nowIso: string
    ) {
      const key = `${echo.locationId}|${echo.contactId}`;
      const existing = echoes.get(key);
      if (existing && existing.expiresAt > nowIso) return false;
      echoes.set(key, { textSha256: echo.textSha256, outboundMessageId: echo.outboundMessageId, ghlMessageId: null, sentAt: null, expiresAt: echo.expiresIso });
      return true;
    },
    async markSmsFallbackEchoSent(locationId: string, contactId: string, outboundMessageId: string, ghlMessageId: string | null) {
      const e = echoes.get(`${locationId}|${contactId}`);
      if (e && e.outboundMessageId === outboundMessageId) {
        e.sentAt = new Date().toISOString();
        e.ghlMessageId = ghlMessageId;
      }
    },
    async isMirroredPhoneSentMessage() {
      return false;
    },
    async findSmsFallbackEcho(locationId: string, contactId: string, nowIso: string) {
      if (fail.find) throw new Error("db down");
      const e = echoes.get(`${locationId}|${contactId}`);
      return e && e.expiresAt > nowIso ? { ...e } : null;
    },
    async deleteSmsFallbackEcho(locationId: string, contactId: string, outboundMessageId: string) {
      const key = `${locationId}|${contactId}`;
      if (echoes.get(key)?.outboundMessageId !== outboundMessageId) return false;
      echoes.delete(key);
      return true;
    },
    async getGhlOutboundMessage(id: string) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async failSmsFallback(id: string) {
      const row = rows.get(id);
      if (!row || (row.smsFallback !== "claimed" && row.smsFallback !== "sent")) return false;
      row.smsFallback = "failed";
      return true;
    },
    async blockSmsFallback(locationId: string) {
      if (locationId === LOCATION && account.smsFallbackBlockedAt === null) account.smsFallbackBlockedAt = new Date().toISOString();
    },
    async claimSmsFallback(id: string) {
      const row = rows.get(id)!;
      if (row.smsFallback || row.reportedStatus !== null) return false;
      row.smsFallback = "claimed";
      row.smsFallbackClaimedAt = new Date().toISOString();
      return true;
    },
    async setSmsFallbackResult(id: string, result: "sent" | "failed") {
      const row = rows.get(id)!;
      if (row.smsFallback === "claimed") row.smsFallback = result;
    },
  };
  const repo = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) {
        return (...args: never[]) => {
          calls.push(prop);
          return target[prop](...args);
        };
      }
      return async () => {
        throw new Error(`unexpected repo call ${prop}`);
      };
    },
  }) as unknown as GhlProviderRepo;

  /** An accepted 1:1 row whose WhatsApp send has come back as not on WhatsApp. */
  function seedNotOnWhatsapp(overrides: Partial<GhlOutboundMessage> = {}): GhlOutboundMessage {
    const id = `row-${nextId++}`;
    const row: GhlOutboundMessage = {
      id,
      locationId: LOCATION,
      tenantId: TENANT,
      ghlMessageId: `ghl-${id}`,
      ghlContactId: CONTACT,
      idempotencyKey: `key-${id}`,
      toPhone: PHONE,
      hadAttachments: false,
      sendState: "accepted",
      sendAttempts: 1,
      pendingText: "Your class is at 6pm",
      refusalReason: null,
      reportedStatus: null,
      reportedAt: null,
      reportError: null,
      readReportedAt: null,
      readReportError: null,
      smsFallback: null,
      createdAt: new Date(Date.now() + nextId).toISOString(),
      ...overrides,
    };
    rows.set(id, row);
    ledger.set(row.idempotencyKey, { status: "not_on_whatsapp", error: null });
    return row;
  }

  return { account, repo, rows, attachments, ledger, echoes, optOuts, remembered, groups, calls, fail, seedNotOnWhatsapp };
}

function makeDeps(overrides: Partial<GhlProviderDeps> = {}) {
  const smsCalls: { accessToken: string; contactId: string; message: string }[] = [];
  const statusCalls: { messageId: string; status: string; errorMessage?: string }[] = [];
  const bridgeCalls: unknown[] = [];
  const fired: { key: string; payload: unknown }[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const deps: GhlProviderDeps = {
    sendWhatsapp: async (input) => {
      bridgeCalls.push(input);
      return { ok: true, replay: false, message: { id: "b-1", idempotencyKey: input.idempotencyKey, toPhone: "", status: "accepted", waMessageId: null, error: null, createdAt: "", sentAt: null } };
    },
    sendAttachment: async (input) => {
      bridgeCalls.push(input);
      return { ok: true, replay: false, message: { id: "b-2", idempotencyKey: input.idempotencyKey, toPhone: "", status: "accepted", waMessageId: null, error: null, createdAt: "", sentAt: null } };
    },
    getSession: async () => ({ ok: true, session: { coachId: TENANT, status: "connected", phoneNumber: OUR_NUMBER, qr: null, sentToday: 0, dailyCap: 150, queueLength: 0 } }),
    updateStatus: async (_token, messageId, status, errorMessage) => {
      statusCalls.push({ messageId, status, errorMessage });
      return { ok: true };
    },
    refreshToken: async () => ({ ok: false, kind: "transient" }),
    refreshWaitMs: 1,
    notify: () => {},
    defer: (fn) => {
      deferred.push(fn);
    },
    fireTrigger: async (_repo, _locationId, key, payload) => {
      fired.push({ key, payload });
      return { fired: 1, failed: 0 };
    },
    sendSms: async (accessToken, input) => {
      smsCalls.push({ accessToken, ...input });
      return { ok: true, messageId: null };
    },
    ...overrides,
  };
  return { deps, smsCalls, statusCalls, bridgeCalls, fired, deferred };
}

async function settle(deferred: (() => Promise<void>)[]) {
  for (const fn of deferred.splice(0)) await fn();
}

function payload(overrides: Record<string, unknown> = {}) {
  return { type: "SMS", locationId: LOCATION, messageId: "ghl-in-1", contactId: CONTACT, phone: PHONE, message: "Your class is at 6pm", attachments: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Fixed strings and the hash
// ---------------------------------------------------------------------------

test("the status reason, the loop reason and the 10-minute echo window are the plan's exact values", () => {
  assert.equal(REASON_SENT_AS_SMS, SENT_REASON);
  assert.equal(REASON_SMS_FALLBACK_LOOP, LOOP_REASON);
  assert.equal(SMS_FALLBACK_ECHO_MS, 10 * 60 * 1000);
  assert.equal(GHL_PROVIDER_REASONS.notOnWhatsapp, "recipient has no WhatsApp account");
});

test("the echo hash is the sha256 of the normalised text: CRLF to LF, whitespace runs collapsed, trimmed", () => {
  assert.equal(normaliseSmsFallbackText("  hi\r\n\r\nthere \t now \n"), "hi there now");
  assert.equal(smsFallbackTextSha256("  hi there \n"), createHash("sha256").update("hi there", "utf8").digest("hex"));
  assert.equal(smsFallbackTextSha256("Line one\r\nLine two  "), smsFallbackTextSha256("Line one\nLine two"));
  assert.equal(SMS_FALLBACK_CLAIM_BUSY_MS, 2 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Status drain
// ---------------------------------------------------------------------------

test("drain: sent as SMS -> the status says so, no trigger fires, the echo holds only the hash", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  const d = makeDeps();
  const result = await drainGhlOutboundStatuses(w.repo, d.deps);

  assert.equal(result.failed, 1);
  assert.deepEqual(d.smsCalls, [{ accessToken: "loc-token", contactId: CONTACT, message: "Your class is at 6pm" }]);
  assert.deepEqual(d.statusCalls, [{ messageId: row.ghlMessageId, status: "failed", errorMessage: SENT_REASON }]);
  assert.deepEqual(d.fired, []);
  assert.equal(w.rows.get(row.id)!.smsFallback, "sent");
  assert.ok(w.remembered.has(`${LOCATION}:${PHONE}`), "the contact is still remembered as not on WhatsApp");
  const [[key, echo]] = [...w.echoes.entries()];
  assert.equal(key, `${LOCATION}|${CONTACT}`);
  assert.deepEqual({ ...echo, expiresAt: "", sentAt: echo.sentAt ? "set" : null }, { textSha256: smsFallbackTextSha256("Your class is at 6pm"), outboundMessageId: row.id, ghlMessageId: null, sentAt: "set", expiresAt: "" });
  assert.ok(!JSON.stringify(echo).includes("class"), "never the text itself");
  const ttl = Date.parse(echo.expiresAt) - Date.now();
  assert.ok(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000);
});

test("drain: the SMS call fails -> the trigger fires with the text and the status keeps the old reason", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  const d = makeDeps({ sendSms: async () => ({ ok: false, status: 422 }) });
  await drainGhlOutboundStatuses(w.repo, d.deps);

  assert.deepEqual(d.statusCalls, [{ messageId: row.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" }]);
  assert.equal(d.fired.length, 1);
  assert.equal(d.fired[0].key, "whatsapp_not_on_whatsapp");
  assert.equal((d.fired[0].payload as { message: string }).message, "Your class is at 6pm");
  assert.equal(w.rows.get(row.id)!.smsFallback, "failed");
});

test("drain: no token for the SMS -> treated as failed, the trigger fires", async () => {
  flags();
  // An expired token whose refresh fails transiently: no token for the SMS, and none for the report either.
  const w = makeWorld({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  w.seedNotOnWhatsapp();
  const d = makeDeps();
  const result = await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls, []);
  assert.equal(result.reportFailed, 1);
  // The next pass (token back) reports the old reason, fires, and never retries the SMS.
  w.account.accessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls, []);
  assert.deepEqual(d.statusCalls.map((c) => c.errorMessage), ["recipient has no WhatsApp account"]);
  assert.equal(d.fired.length, 1);
});

test("drain: the global flag off, the sub-account switched off, or blocked -> no SMS, the trigger fires as today", async () => {
  for (const [label, sms, overrides] of [
    ["flag off", false, {}],
    ["switched off", true, { smsFallbackEnabled: false }],
    ["blocked", true, { smsFallbackBlockedAt: "2026-10-17T09:00:00Z" }],
  ] as const) {
    flags({ sms });
    const w = makeWorld(overrides);
    const row = w.seedNotOnWhatsapp();
    const d = makeDeps();
    await drainGhlOutboundStatuses(w.repo, d.deps);
    assert.deepEqual(d.smsCalls, [], label);
    assert.deepEqual(d.statusCalls, [{ messageId: row.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" }], label);
    assert.equal(d.fired.length, 1, label);
    assert.deepEqual(w.echoes.size, 0, label);
    assert.equal(w.rows.get(row.id)!.smsFallback ?? null, null, `${label}: nothing claimed`);
  }
});

test("drain: an opted-out contact gets no SMS and no trigger (STOP wins)", async () => {
  flags();
  const w = makeWorld();
  w.optOuts.add(`${TENANT}:${PHONE}`);
  const row = w.seedNotOnWhatsapp();
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls, []);
  assert.deepEqual(d.fired, []);
  assert.deepEqual(d.statusCalls, [{ messageId: row.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" }]);
});

test("drain: a group row never falls back", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp({ toPhone: null });
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls, []);
  assert.equal(w.echoes.size, 0);
});

test("drain: a row with no kept text sends no SMS", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp({ pendingText: null });
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls, []);
  assert.equal(d.fired.length, 1);
});

test("drain: two overlapping drains on the same row send one SMS and report it once", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp();
  const slow = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));
  const d = makeDeps({
    updateStatus: async (_t, messageId, status, errorMessage) => {
      d.statusCalls.push({ messageId, status, errorMessage });
      return slow({ ok: true as const });
    },
    sendSms: async (accessToken, input) => {
      d.smsCalls.push({ accessToken, ...input });
      return slow({ ok: true as const, messageId: null });
    },
  });
  await Promise.all([drainGhlOutboundStatuses(w.repo, d.deps), drainGhlOutboundStatuses(w.repo, d.deps)]);
  assert.equal(d.smsCalls.length, 1);
  assert.deepEqual(d.fired, []);
  assert.ok(d.statusCalls.every((c) => c.errorMessage === SENT_REASON), "nobody reports the old reason");
});

test("drain: a status report that fails after the SMS went never sends a second SMS on the retry", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  let putOk = false;
  const d = makeDeps({
    updateStatus: async (_t, messageId, status, errorMessage) => {
      d.statusCalls.push({ messageId, status, errorMessage });
      return putOk ? { ok: true } : { ok: false, error: "GHL status update failed (HTTP 503)" };
    },
  });
  const first = await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(first.reportFailed, 1);
  putOk = true;
  const second = await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(second.failed, 1);
  assert.equal(d.smsCalls.length, 1);
  assert.deepEqual(d.statusCalls.map((c) => c.errorMessage), [SENT_REASON, SENT_REASON]);
  assert.deepEqual(d.fired, []);
  assert.equal(w.rows.get(row.id)!.reportedStatus, "failed");
});

test("drain: a multipart message that isn't on WhatsApp falls back with its text only", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp({ hadAttachments: true, pendingText: "See the attached plan" });
  w.attachments.push({
    id: "att-1",
    outboundMessageId: row.id,
    seq: 1,
    idempotencyKey: "att-key-1",
    pendingUrl: null,
    fileName: "plan.pdf",
    sendState: "accepted",
    refusalReason: null,
    sendAttempts: 1,
    createdAt: row.createdAt,
  });
  w.ledger.set("att-key-1", { status: "not_on_whatsapp", error: null });
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls.map((c) => c.message), ["See the attached plan"]);
  assert.deepEqual(d.statusCalls.map((c) => c.errorMessage), [SENT_REASON]);
  assert.deepEqual(d.fired, []);
});

// ---------------------------------------------------------------------------
// Fast refusal (the 30-day memory)
// ---------------------------------------------------------------------------

test("send: a remembered contact gets the SMS once, never the bridge, and no trigger", async () => {
  flags();
  const w = makeWorld();
  w.remembered.set(`${LOCATION}:${PHONE}`, new Date(Date.now() + 60_000).toISOString());
  const d = makeDeps();
  const outcome = await handleProviderOutboundMessage(w.repo, payload(), d.deps);
  await settle(d.deferred);

  assert.deepEqual(outcome, { kind: "refused", reason: SENT_REASON });
  assert.deepEqual(d.bridgeCalls, []);
  assert.deepEqual(d.smsCalls, [{ accessToken: "loc-token", contactId: CONTACT, message: "Your class is at 6pm" }]);
  assert.deepEqual(d.statusCalls.map((c) => c.errorMessage), [SENT_REASON]);
  assert.deepEqual(d.fired, []);
  const row = [...w.rows.values()][0];
  assert.equal(row.refusalReason, SENT_REASON, "a later retry of the report keeps the reason");

  // A GHL redelivery of the same message is a duplicate: no second SMS.
  await handleProviderOutboundMessage(w.repo, payload(), d.deps);
  assert.equal(d.smsCalls.length, 1);
});

test("send: a remembered contact whose SMS fails -> the trigger fires and the old reason", async () => {
  flags();
  const w = makeWorld();
  w.remembered.set(`${LOCATION}:${PHONE}`, new Date(Date.now() + 60_000).toISOString());
  const d = makeDeps({ sendSms: async () => ({ ok: false, status: null }) });
  const outcome = await handleProviderOutboundMessage(w.repo, payload(), d.deps);
  await settle(d.deferred);
  assert.deepEqual(outcome, { kind: "refused", reason: "recipient has no WhatsApp account" });
  assert.equal(d.fired.length, 1);
});

test("send: an opted-out remembered contact gets nothing — no SMS, no trigger", async () => {
  flags();
  const w = makeWorld();
  w.remembered.set(`${LOCATION}:${PHONE}`, new Date(Date.now() + 60_000).toISOString());
  w.optOuts.add(`${TENANT}:${PHONE}`);
  const d = makeDeps();
  const outcome = await handleProviderOutboundMessage(w.repo, payload(), d.deps);
  await settle(d.deferred);
  assert.equal(outcome.kind, "refused");
  assert.equal((outcome as { reason: string }).reason, GHL_PROVIDER_REASONS.optedOut);
  assert.deepEqual(d.smsCalls, []);
  assert.deepEqual(d.fired, []);
  assert.deepEqual(d.bridgeCalls, []);
});

test("send: attachments with text -> the SMS carries the text only; attachments with no text -> no SMS", async () => {
  flags();
  for (const [message, expected] of [
    ["See attached", ["See attached"]],
    ["", []],
  ] as const) {
    const w = makeWorld();
    w.remembered.set(`${LOCATION}:${PHONE}`, new Date(Date.now() + 60_000).toISOString());
    const d = makeDeps();
    await handleProviderOutboundMessage(w.repo, payload({ message, attachments: ["https://x.test/a.jpg"] }), d.deps);
    await settle(d.deferred);
    assert.deepEqual(d.smsCalls.map((c) => c.message), expected, JSON.stringify(message));
    assert.deepEqual(d.bridgeCalls, []);
  }
});

// ---------------------------------------------------------------------------
// Loop guard
// ---------------------------------------------------------------------------

test("echo: GHL hands our SMS back -> refused with the loop reason, never sent on WhatsApp, the sub-account blocked, and no further SMS", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp();
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(d.smsCalls.length, 1);

  // GHL routes the SMS to its provider: PingWren's own webhook.
  const outcome = await handleProviderOutboundMessage(w.repo, payload({ messageId: "ghl-echo-1", message: "Your class is at 6pm" }), d.deps);
  assert.deepEqual(outcome, { kind: "refused", reason: LOOP_REASON });
  assert.deepEqual(d.bridgeCalls, [], "never sent over WhatsApp");
  assert.ok(w.account.smsFallbackBlockedAt, "the fallback is switched off for this sub-account");
  assert.deepEqual(d.statusCalls.at(-1), { messageId: "ghl-echo-1", status: "failed", errorMessage: LOOP_REASON });
  assert.equal(w.echoes.size, 0, "the echo is consumed");

  // The next contact who isn't on WhatsApp: no SMS, the trigger fires instead.
  const next = w.seedNotOnWhatsapp({ ghlContactId: "contact-sms-2", pendingText: "Another message" });
  await drainGhlOutboundStatuses(w.repo, d.deps);
  await settle(d.deferred);
  assert.equal(d.smsCalls.length, 1);
  assert.equal(d.fired.length, 2, "one for the echoed original (the guard), one for the next message");
  assert.deepEqual(d.statusCalls.at(-1), { messageId: next.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" });
});

test("echo: a different text or a different contact is a normal send", async () => {
  flags();
  const w = makeWorld();
  w.echoes.set(`${LOCATION}|${CONTACT}`, { textSha256: smsFallbackTextSha256("Your class is at 6pm"), outboundMessageId: "row-x", ghlMessageId: null, sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload({ messageId: "m-a", message: "Something else" }), d.deps), { kind: "accepted" });
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload({ messageId: "m-b", contactId: "contact-other" }), d.deps), { kind: "accepted" });
  assert.equal(d.bridgeCalls.length, 2);
  assert.equal(w.account.smsFallbackBlockedAt, null);
});

test("echo: an expired echo is not a match", async () => {
  flags();
  const w = makeWorld();
  w.echoes.set(`${LOCATION}|${CONTACT}`, { textSha256: smsFallbackTextSha256("Your class is at 6pm"), outboundMessageId: "row-x", ghlMessageId: null, sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload(), d.deps), { kind: "accepted" });
});

test("echo: a read error fails open and the message is sent as normal", async () => {
  flags();
  const w = makeWorld();
  w.fail.find = true;
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload(), d.deps), { kind: "accepted" });
  assert.equal(d.bridgeCalls.length, 1);
});

test("echo: the guard still checks with the flag off (echoes may still be pending) and refuses a match", async () => {
  flags({ sms: false });
  const w = makeWorld();
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload(), d.deps), { kind: "accepted" });
  assert.ok(w.calls.includes("findSmsFallbackEcho"));
  w.echoes.set(`${LOCATION}|${CONTACT}`, { textSha256: smsFallbackTextSha256("Your class is at 6pm"), outboundMessageId: "row-gone", ghlMessageId: null, sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload({ messageId: "m-flag-off" }), d.deps), { kind: "refused", reason: LOOP_REASON });
  assert.equal(d.bridgeCalls.length, 1, "only the first message reached the bridge");
});

// ---------------------------------------------------------------------------
// trySmsFallback directly
// ---------------------------------------------------------------------------

test("trySmsFallback never throws: a failing repo resolves to failed", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  const broken = new Proxy(w.repo as unknown as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === "recordSmsFallbackEcho") return async () => {
        throw new Error("db down");
      };
      return target[prop];
    },
  }) as unknown as GhlProviderRepo;
  const d = makeDeps();
  assert.equal(await trySmsFallback(broken, d.deps, { account: w.account, row, text: "hi" }), "failed");
  assert.deepEqual(d.smsCalls, [], "no echo recorded, so no SMS");
});

test("trySmsFallback skips an app-originated row (a WhatsApp group invite)", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp({ ghlMessageId: `pwapp_${"a".repeat(32)}` });
  const d = makeDeps();
  assert.equal(await trySmsFallback(w.repo, d.deps, { account: w.account, row, text: "Join the group" }), "skipped");
  assert.deepEqual(d.smsCalls, []);
});

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------

function seedEcho(w: ReturnType<typeof makeWorld>, text: string, outboundMessageId: string, ghlMessageId: string | null = null) {
  w.echoes.set(`${LOCATION}|${CONTACT}`, { textSha256: smsFallbackTextSha256(text), outboundMessageId, ghlMessageId, sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
}

test("C1: a drain that lists the row while another pass's SMS is in flight leaves it: no report, no trigger", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  let releaseSms!: () => void;
  const smsGate = new Promise<void>((resolve) => (releaseSms = resolve));
  let smsStarted!: () => void;
  const started = new Promise<void>((resolve) => (smsStarted = resolve));
  const d = makeDeps({
    sendSms: async (accessToken, input) => {
      d.smsCalls.push({ accessToken, ...input });
      smsStarted();
      await smsGate;
      return { ok: true, messageId: null };
    },
  });
  const first = drainGhlOutboundStatuses(w.repo, d.deps);
  await started;
  // The second pass lists the row now: it is claimed, a moment ago.
  assert.equal(w.rows.get(row.id)!.smsFallback, "claimed");
  const second = await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(second.unresolved, 1);
  assert.deepEqual(d.statusCalls, [], "no report while the first pass is in flight");
  assert.deepEqual(d.fired, []);
  releaseSms();
  await first;
  assert.equal(d.smsCalls.length, 1);
  assert.deepEqual(d.statusCalls.map((c) => c.errorMessage), [SENT_REASON]);
  assert.deepEqual(d.fired, []);
});

test("C1: a claim older than 2 minutes is treated as failed: the old reason, the trigger fires, no SMS", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp({ smsFallback: "claimed", smsFallbackClaimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls, []);
  assert.deepEqual(d.statusCalls, [{ messageId: row.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" }]);
  assert.equal(d.fired.length, 1);
});

test("C2: at most one fallback SMS per contact per 10 minutes; the second message fires the trigger instead", async () => {
  flags();
  const w = makeWorld();
  const a = w.seedNotOnWhatsapp({ pendingText: "First" });
  const b = w.seedNotOnWhatsapp({ pendingText: "Second" });
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls.map((c) => c.message), ["First"]);
  const byId = new Map(d.statusCalls.map((c) => [c.messageId, c.errorMessage]));
  assert.equal(byId.get(a.ghlMessageId), SENT_REASON);
  assert.equal(byId.get(b.ghlMessageId), "recipient has no WhatsApp account");
  assert.deepEqual(d.fired.map((f) => (f.payload as { message: string }).message), ["Second"]);
});

test("C2: a missed echo costs one hop, never a loop", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp();
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(d.smsCalls.length, 1);

  // The provider changed the text on the way back, so the guard misses it.
  // The 30-day memory refuses it, and the cooldown means no second SMS.
  const viaMemory = await handleProviderOutboundMessage(w.repo, payload({ messageId: "echo-missed-1", message: "Your class is at 6pm. Reply STOP to opt out" }), d.deps);
  await settle(d.deferred);
  assert.deepEqual(viaMemory, { kind: "refused", reason: "recipient has no WhatsApp account" });
  assert.equal(d.smsCalls.length, 1);

  // Without the memory it goes to WhatsApp once, fails as not on WhatsApp, and stops there.
  w.remembered.clear();
  const viaBridge = await handleProviderOutboundMessage(w.repo, payload({ messageId: "echo-missed-2", message: "Your class is at 6pm. Reply STOP to opt out" }), d.deps);
  assert.deepEqual(viaBridge, { kind: "accepted" });
  const echoRow = [...w.rows.values()].find((r) => r.ghlMessageId === "echo-missed-2")!;
  w.ledger.set(echoRow.idempotencyKey, { status: "not_on_whatsapp", error: null });
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(d.smsCalls.length, 1, "never a second SMS");
});

test("C2: a CRLF and whitespace variant of the text still matches the echo", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp({ pendingText: "Line one\nLine two" });
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  const outcome = await handleProviderOutboundMessage(w.repo, payload({ messageId: "echo-crlf", message: "Line one\r\nLine two  " }), d.deps);
  assert.deepEqual(outcome, { kind: "refused", reason: LOOP_REASON });
});

test("C2: the guard stamps the echo row refused before it consumes the echo", async () => {
  flags();
  const w = makeWorld();
  seedEcho(w, "Your class is at 6pm", "row-x");
  const order: string[] = [];
  const traced = new Proxy(w.repo as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, {
    get(target, prop: string) {
      const fn = target[prop];
      return async (...args: unknown[]) => {
        if (prop === "deleteSmsFallbackEcho") order.push("consume");
        if (prop === "updateGhlOutboundSendState" && (args[1] as { sendState: string }).sendState === "refused") order.push("refused");
        return fn(...args);
      };
    },
  }) as unknown as GhlProviderRepo;
  await handleProviderOutboundMessage(traced, payload(), makeDeps().deps);
  assert.deepEqual(order, ["refused", "consume"]);
});

test("I1: an echo after the original was reported marks it failed and fires the trigger with its text, without re-reporting it", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.statusCalls.map((c) => c.errorMessage), [SENT_REASON]);

  await handleProviderOutboundMessage(w.repo, payload({ messageId: "echo-late" }), d.deps);
  await settle(d.deferred);
  assert.equal(w.rows.get(row.id)!.smsFallback, "failed");
  assert.deepEqual(d.fired.map((f) => f.payload), [{ number: OUR_NUMBER, numberLabel: null, contactId: CONTACT, message: "Your class is at 6pm" }]);
  assert.equal(d.statusCalls.filter((c) => c.messageId === row.ghlMessageId).length, 1, "already reported: not reported again");
});

test("I1: an echo that arrives before sendGhlSms returns is honoured: one honest report, one trigger", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  let echoOutcome: unknown;
  const d = makeDeps({
    sendSms: async (accessToken, input) => {
      d.smsCalls.push({ accessToken, ...input });
      // GHL hands it straight back to our webhook before its POST answers.
      echoOutcome = await handleProviderOutboundMessage(w.repo, payload({ messageId: "echo-early", message: input.message }), d.deps);
      return { ok: true, messageId: "sms-early" };
    },
  });
  await drainGhlOutboundStatuses(w.repo, d.deps);
  await settle(d.deferred);
  assert.deepEqual(echoOutcome, { kind: "refused", reason: LOOP_REASON });
  const original = d.statusCalls.filter((c) => c.messageId === row.ghlMessageId);
  assert.ok(original.length >= 1);
  assert.ok(original.every((c) => c.errorMessage === "recipient has no WhatsApp account"), JSON.stringify(original));
  assert.equal(w.rows.get(row.id)!.reportedStatus, "failed");
  assert.equal(w.rows.get(row.id)!.smsFallback, "failed");
  assert.equal(d.fired.length, 1, "the trigger fires once, for the original");
  assert.ok(w.account.smsFallbackBlockedAt);
});

test("I2: the echo stores GHL's messageId, and then only that id matches", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp();
  const d = makeDeps({
    sendSms: async (accessToken, input) => {
      d.smsCalls.push({ accessToken, ...input });
      return { ok: true, messageId: "sms-msg-1" };
    },
  });
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(w.echoes.get(`${LOCATION}|${CONTACT}`)!.ghlMessageId, "sms-msg-1");

  // The SMS went out through another provider; the coach sends the same text by hand.
  const coach = await handleProviderOutboundMessage(w.repo, payload({ messageId: "coach-msg-2" }), d.deps);
  await settle(d.deferred);
  assert.notDeepEqual(coach, { kind: "refused", reason: LOOP_REASON });
  assert.equal(w.account.smsFallbackBlockedAt, null, "not blocked");
  assert.ok(w.echoes.has(`${LOCATION}|${CONTACT}`), "the echo is still pending");

  // GHL hands the fallback SMS itself back: same id, refused.
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload({ messageId: "sms-msg-1", message: "different text is fine" }), d.deps), {
    kind: "refused",
    reason: LOOP_REASON,
  });
});

test("I3: a legacy row whose attachments were folded into the text sends no SMS (no links by SMS)", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp({ hadAttachments: true, pendingText: "See attached\nhttps://x.test/a.jpg" });
  const d = makeDeps();
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.deepEqual(d.smsCalls, []);
  assert.deepEqual(d.statusCalls, [{ messageId: row.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" }]);
  assert.equal(d.fired.length, 1);
});

test("M1: on the fast-refusal path a busy row fires no trigger", async () => {
  flags();
  const w = makeWorld();
  w.remembered.set(`${LOCATION}:${PHONE}`, new Date(Date.now() + 60_000).toISOString());
  const busyRepo = new Proxy(w.repo as unknown as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === "claimSmsFallback") return async () => false;
      return target[prop];
    },
  }) as unknown as GhlProviderRepo;
  const d = makeDeps();
  const outcome = await handleProviderOutboundMessage(busyRepo, payload(), d.deps);
  await settle(d.deferred);
  assert.deepEqual(outcome, { kind: "refused", reason: "recipient has no WhatsApp account" });
  assert.deepEqual(d.smsCalls, []);
  assert.deepEqual(d.fired, []);
});

test("M4: an opted-out contact never fires the trigger and gets no SMS, with the flag off or on", async () => {
  for (const sms of [false, true]) {
    flags({ sms });
    const w = makeWorld();
    w.optOuts.add(`${TENANT}:${PHONE}`);
    const row = w.seedNotOnWhatsapp();
    const d = makeDeps();
    await drainGhlOutboundStatuses(w.repo, d.deps);
    assert.deepEqual(d.smsCalls, [], `flag ${sms}`);
    assert.deepEqual(d.fired, [], `flag ${sms}: STOP wins`);
    assert.deepEqual(d.statusCalls, [{ messageId: row.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" }]);
    assert.equal(await trySmsFallback(w.repo, d.deps, { account: w.account, row: { ...row, reportedStatus: null, smsFallback: null }, text: "hi" }), "opted_out");
  }
});

// ---------------------------------------------------------------------------
// Fix round 2
// ---------------------------------------------------------------------------

test("R2-1: GHL rejects the SMS -> the echo is deleted, so the coach's retry of the same text is not taken as the echo", async () => {
  flags();
  const w = makeWorld();
  w.seedNotOnWhatsapp();
  const d = makeDeps({ sendSms: async () => ({ ok: false, status: 422 }) });
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(w.echoes.size, 0, "nothing was sent: no echo, no cooldown");
  const retry = await handleProviderOutboundMessage(w.repo, payload({ messageId: "coach-retry" }), d.deps);
  await settle(d.deferred);
  assert.notDeepEqual(retry, { kind: "refused", reason: LOOP_REASON });
  assert.equal(w.account.smsFallbackBlockedAt, null);
});

test("R2-1: no token for the SMS (nothing attempted) -> the echo is deleted too", async () => {
  flags();
  const w = makeWorld({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  w.seedNotOnWhatsapp();
  await drainGhlOutboundStatuses(w.repo, makeDeps().deps);
  assert.equal(w.echoes.size, 0);
});

test("R2-1: a network or timeout error keeps the echo (the SMS may have gone)", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  const d = makeDeps({ sendSms: async () => ({ ok: false, status: null }) });
  await drainGhlOutboundStatuses(w.repo, d.deps);
  const echo = w.echoes.get(`${LOCATION}|${CONTACT}`);
  assert.ok(echo, "kept");
  assert.equal(echo!.outboundMessageId, row.id);
  assert.equal(echo!.sentAt, null);
});

test("R2-1: the guard matches the hash only after a successful POST, or for an unsent echo younger than 30 s", async () => {
  flags();
  for (const [label, sentAt, ageMs, expected] of [
    ["sent, any age", "2026-10-17T10:00:00Z", 9 * 60 * 1000, "refused"],
    ["unsent, 5 s old (POST in flight)", null, 5_000, "refused"],
    ["unsent, 60 s old (network error)", null, 60_000, "accepted"],
  ] as const) {
    const w = makeWorld();
    w.echoes.set(`${LOCATION}|${CONTACT}`, {
      textSha256: smsFallbackTextSha256("Your class is at 6pm"),
      outboundMessageId: "row-x",
      ghlMessageId: null,
      sentAt,
      expiresAt: new Date(Date.now() - ageMs + SMS_FALLBACK_ECHO_MS).toISOString(),
    });
    const outcome = await handleProviderOutboundMessage(w.repo, payload({ messageId: `m-${label}` }), makeDeps().deps);
    assert.equal(outcome.kind, expected, label);
  }
});

test("R2-2: an original already failed, then the echo matches -> no second trigger and no second report", async () => {
  flags();
  const w = makeWorld();
  const original = w.seedNotOnWhatsapp({ smsFallback: "failed" });
  seedEcho(w, "Your class is at 6pm", original.id);
  const d = makeDeps();
  const outcome = await handleProviderOutboundMessage(w.repo, payload({ messageId: "echo-after-failed" }), d.deps);
  await settle(d.deferred);
  assert.deepEqual(outcome, { kind: "refused", reason: LOOP_REASON });
  assert.deepEqual(d.fired, []);
  assert.equal(d.statusCalls.filter((c) => c.messageId === original.ghlMessageId).length, 0);
});

test("R2-3: an opt-out read error in the drain leaves the row (busy): no SMS, no trigger, retried next pass", async () => {
  flags();
  const w = makeWorld();
  const row = w.seedNotOnWhatsapp();
  w.fail.optOutReads = 1;
  const d = makeDeps();
  const first = await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(first.unresolved, 1);
  assert.deepEqual(d.statusCalls, []);
  assert.deepEqual(d.fired, []);
  assert.deepEqual(d.smsCalls, []);
  await drainGhlOutboundStatuses(w.repo, d.deps);
  assert.equal(d.smsCalls.length, 1, "the next pass reads the opt-outs and sends");
  assert.deepEqual(d.statusCalls.map((c) => c.messageId), [row.ghlMessageId]);
});

test("R2-3: an opt-out read error on the fast path reports no WhatsApp account and fires no trigger", async () => {
  flags();
  const w = makeWorld();
  w.remembered.set(`${LOCATION}:${PHONE}`, new Date(Date.now() + 60_000).toISOString());
  // The send's own STOP check reads first; the fallback's read is the one that fails.
  const d = makeDeps();
  let reads = 0;
  const flaky = new Proxy(w.repo as unknown as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === "isOptedOut") {
        return async (...args: unknown[]) => {
          reads++;
          if (reads > 1) throw new Error("db down");
          return (target[prop] as (...a: unknown[]) => Promise<boolean>)(...args);
        };
      }
      return target[prop];
    },
  }) as unknown as GhlProviderRepo;
  const outcome = await handleProviderOutboundMessage(flaky, payload(), d.deps);
  await settle(d.deferred);
  assert.deepEqual(outcome, { kind: "refused", reason: "recipient has no WhatsApp account" });
  assert.deepEqual(d.smsCalls, []);
  assert.deepEqual(d.fired, []);
});
