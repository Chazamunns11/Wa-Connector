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
import { REASON_SENT_AS_SMS, REASON_SMS_FALLBACK_LOOP, SMS_FALLBACK_ECHO_MS, smsFallbackTextSha256, trySmsFallback } from "@/lib/sms-fallback";
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
  const echoes = new Map<string, string>();
  const optOuts = new Set<string>();
  const remembered = new Map<string, string>();
  const groups = new Map<string, { tenantId: string; groupJid: string; enabled: boolean; left: boolean }>();
  const calls: string[] = [];
  const fail = { consume: false };
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
    async recordSmsFallbackEcho(locationId: string, contactId: string, textSha256: string, expiresIso: string) {
      echoes.set(`${locationId}|${contactId}|${textSha256}`, expiresIso);
    },
    async consumeSmsFallbackEcho(locationId: string, contactId: string, textSha256: string, nowIso: string) {
      if (fail.consume) throw new Error("db down");
      const key = `${locationId}|${contactId}|${textSha256}`;
      const until = echoes.get(key);
      if (until === undefined || until <= nowIso) return false;
      echoes.delete(key);
      return true;
    },
    async blockSmsFallback(locationId: string) {
      if (locationId === LOCATION && account.smsFallbackBlockedAt === null) account.smsFallbackBlockedAt = new Date().toISOString();
    },
    async claimSmsFallback(id: string) {
      const row = rows.get(id)!;
      if (row.smsFallback || row.reportedStatus !== null) return false;
      row.smsFallback = "claimed";
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
      return { ok: true };
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

test("the echo hash is the sha256 of the trimmed text", () => {
  assert.equal(smsFallbackTextSha256("  hi there \n"), createHash("sha256").update("hi there", "utf8").digest("hex"));
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
  const [[key, expires]] = [...w.echoes.entries()];
  assert.equal(key, `${LOCATION}|${CONTACT}|${smsFallbackTextSha256("Your class is at 6pm")}`);
  assert.ok(!key.includes("class"), "never the text itself");
  const ttl = Date.parse(expires) - Date.now();
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
      return slow({ ok: true as const });
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
  assert.equal(d.smsCalls.length, 1);
  assert.equal(d.fired.length, 1);
  assert.deepEqual(d.statusCalls.at(-1), { messageId: next.ghlMessageId, status: "failed", errorMessage: "recipient has no WhatsApp account" });
});

test("echo: a different text or a different contact is a normal send", async () => {
  flags();
  const w = makeWorld();
  w.echoes.set(`${LOCATION}|${CONTACT}|${smsFallbackTextSha256("Your class is at 6pm")}`, new Date(Date.now() + 60_000).toISOString());
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload({ messageId: "m-a", message: "Something else" }), d.deps), { kind: "accepted" });
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload({ messageId: "m-b", contactId: "contact-other" }), d.deps), { kind: "accepted" });
  assert.equal(d.bridgeCalls.length, 2);
  assert.equal(w.account.smsFallbackBlockedAt, null);
});

test("echo: an expired echo is not a match", async () => {
  flags();
  const w = makeWorld();
  w.echoes.set(`${LOCATION}|${CONTACT}|${smsFallbackTextSha256("Your class is at 6pm")}`, new Date(Date.now() - 1000).toISOString());
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload(), d.deps), { kind: "accepted" });
});

test("echo: a read error fails open and the message is sent as normal", async () => {
  flags();
  const w = makeWorld();
  w.fail.consume = true;
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload(), d.deps), { kind: "accepted" });
  assert.equal(d.bridgeCalls.length, 1);
});

test("echo: with the flag off the guard reads nothing", async () => {
  flags({ sms: false });
  const w = makeWorld();
  const d = makeDeps();
  assert.deepEqual(await handleProviderOutboundMessage(w.repo, payload(), d.deps), { kind: "accepted" });
  assert.ok(!w.calls.includes("consumeSmsFallbackEcho"));
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
