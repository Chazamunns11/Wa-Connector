/**
 * GHL custom conversation provider, Phase 2 (docs/GHL-PROVIDER-PLAN.md §4,
 * items 1-7). Covers `src/lib/ghl.ts`'s pure webhook-signature verifier and
 * send-path helpers, and `src/lib/ghl-provider.ts`'s deps-injected domain
 * logic — entirely offline: the Ed25519 fixture generates its own keypair
 * in-test, the WhatsApp bridge and GHL's own API are both fakes. Nothing
 * here can send a real WhatsApp message, scan a QR, or call a real GHL/
 * WhatsApp endpoint.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";

import {
  addGhlInboundMessage,
  buildOutboundText,
  deriveAttachmentIdempotencyKey,
  deriveIdempotencyKey,
  deriveMediaFallbackIdempotencyKey,
  exchangeGhlCode,
  getGhlLocationTokenFromAgency,
  ghlAppId,
  ghlTenantKeyQueryFilters,
  listGhlInstalledLocations,
  ghlGroupContactKey,
  getGhlContact,
  searchGhlContacts,
  parseGhlInstalledLocations,
  upsertGhlGroupContact,
  verifyGhlSignature,
} from "@/lib/ghl";
import { sendingGate } from "@/lib/billing/gate";
import { brandConfig } from "@/lib/brand-config";
import { listWhatsappGroups, refreshWhatsappGroups, sendWhatsappAttachment, sendWhatsappMessage } from "@/lib/whatsapp-bridge";
import {
  drainGhlOutboundStatuses,
  handleProviderOutboundMessage,
  APP_MESSAGE_ID_PREFIX,
  GHL_PROVIDER_REASONS,
  GROUP_SEND_CAP_UNITS,
  isAppOriginatedMessageId,
  reportGhlOutcome,
  sendAppOriginatedText,
  type GhlProviderDeps,
  type GhlProviderRepo,
} from "@/lib/ghl-provider";
import type { BridgeSendResult, BridgeSessionResult, SendWhatsappAttachmentInput, SendWhatsappInput } from "@/lib/whatsapp-bridge";
import type {
  GhlAccount,
  GhlOutboundAttachment,
  GhlOutboundAttachmentDraft,
  GhlOutboundMessage,
  GhlOutboundMessageDraft,
  LocationNumber,
  Account,
  WhatsappSessionSummary,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// 1. Ed25519 synthetic fixture — src/lib/ghl.ts's verifyGhlSignature
// ---------------------------------------------------------------------------

function samplePayload(): Record<string, unknown> {
  return {
    contactId: "contact-1",
    locationId: "loc-1",
    messageId: "msg-1",
    phone: "+447700900123",
    message: "hi there",
    attachments: [] as string[],
    userId: "user-1",
    type: "SMS",
    timestamp: "2026-08-02T10:00:00.000Z",
    webhookId: "webhook-1",
  };
}

function signBody(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], body: string): string {
  return cryptoSign(null, Buffer.from(body, "utf8"), privateKey).toString("base64");
}

test("verifyGhlSignature: a genuine Ed25519 signature over the exact bytes verifies", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const rawBody = JSON.stringify(samplePayload());
  const signature = signBody(privateKey, rawBody);
  assert.equal(verifyGhlSignature(rawBody, signature, publicKeyPem), true);
});

test("verifyGhlSignature: a one-byte body tamper fails", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const rawBody = JSON.stringify(samplePayload());
  const signature = signBody(privateKey, rawBody);
  const tampered = rawBody.slice(0, -1) + (rawBody.endsWith("}") ? "]" : "}");
  assert.notEqual(tampered, rawBody);
  assert.equal(verifyGhlSignature(tampered, signature, publicKeyPem), false);
});

test("verifyGhlSignature: a re-serialised (key-reordered) JSON body of the SAME object fails", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = samplePayload();
  const rawBody = JSON.stringify(payload);
  const signature = signBody(privateKey, rawBody);

  // Same values, keys inserted in a different order — genuinely different
  // bytes on the wire, which is exactly what pins the "raw bytes, never a
  // parse-then-restringify round trip" rule this function's JSDoc states.
  const reordered = { type: payload.type, timestamp: payload.timestamp, webhookId: payload.webhookId, ...payload };
  const reorderedBody = JSON.stringify(reordered);
  assert.notEqual(reorderedBody, rawBody, "test fixture bug — reordering produced identical bytes");
  assert.equal(verifyGhlSignature(reorderedBody, signature, publicKeyPem), false);
});

test("verifyGhlSignature: a missing header fails closed", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyGhlSignature(JSON.stringify(samplePayload()), null, publicKeyPem), false);
});

test("verifyGhlSignature: a garbage base64 header fails closed, never throws", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.doesNotThrow(() => {
    assert.equal(verifyGhlSignature(JSON.stringify(samplePayload()), "not-valid-base64-!!!@@@", publicKeyPem), false);
  });
});

test("verifyGhlSignature: a signature from a DIFFERENT keypair fails", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const { privateKey: otherPrivateKey } = generateKeyPairSync("ed25519");
  const rawBody = JSON.stringify(samplePayload());
  const wrongSignature = signBody(otherPrivateKey, rawBody);
  assert.equal(verifyGhlSignature(rawBody, wrongSignature, publicKeyPem), false);
});

// ---------------------------------------------------------------------------
// 2. deriveIdempotencyKey
// ---------------------------------------------------------------------------

const BRIDGE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

test("deriveIdempotencyKey: an alphanumeric GHL id passes through verbatim", () => {
  assert.equal(deriveIdempotencyKey("abc123XYZ_-"), "abc123XYZ_-");
});

test("deriveIdempotencyKey: an id with characters outside the bridge's key charset is sha256-hex'd", () => {
  for (const id of ["msg.1234", "msg:5678", "msg-café-☃"]) {
    const derived = deriveIdempotencyKey(id);
    // QA Minor 8 fix — domain-separated hash input ("T|" + id), no longer the bare id.
    assert.equal(derived, createHash("sha256").update(`T|${id}`, "utf8").digest("hex"));
    assert.match(derived, /^[a-f0-9]{64}$/);
  }
});

test("deriveIdempotencyKey: a 200-char id (over the bridge's 128 cap) is sha256-hex'd", () => {
  const longId = "a".repeat(200);
  const derived = deriveIdempotencyKey(longId);
  assert.equal(derived, createHash("sha256").update(`T|${longId}`, "utf8").digest("hex"));
});

test("deriveIdempotencyKey: deterministic across calls", () => {
  for (const id of ["plain-id", "id.with.dots", "x".repeat(500)]) {
    assert.equal(deriveIdempotencyKey(id), deriveIdempotencyKey(id));
  }
});

test("deriveIdempotencyKey: output always matches the bridge's own idempotency-key regex", () => {
  for (const id of ["abc", "a.b:cé", "z".repeat(300), "-_-_-"]) {
    assert.match(deriveIdempotencyKey(id), BRIDGE_KEY_RE);
  }
});

// ---------------------------------------------------------------------------
// 2b. ghlTenantKeyQueryFilters (finding 2 — the getWhatsappMessagesByTenantKeys
// PostgREST 1000-row-cap fix). Pure query-filter builder — see its own JSDoc
// (src/lib/ghl.ts) for why this is tested here rather than only inline in
// src/lib/data/supabase.ts, which cannot run under plain `node --test`.
// ---------------------------------------------------------------------------

test("ghlTenantKeyQueryFilters: computes BOTH a tenantIds filter and an idempotencyKeys filter, each deduped independently", () => {
  const pairs = [
    { tenantId: "t1", idempotencyKey: "k1" },
    { tenantId: "t1", idempotencyKey: "k2" },
    { tenantId: "t2", idempotencyKey: "k1" },
    { tenantId: "t2", idempotencyKey: "k1" }, // exact duplicate pair
  ];
  const { tenantIds, idempotencyKeys } = ghlTenantKeyQueryFilters(pairs);
  assert.deepEqual([...tenantIds].sort(), ["t1", "t2"]);
  assert.deepEqual([...idempotencyKeys].sort(), ["k1", "k2"], "the query must bound itself to the WANTED keys, not just the tenants — this is what keeps the response under PostgREST's 1000-row default cap regardless of how large a tenant's whatsapp_messages ledger has grown");
});

test("ghlTenantKeyQueryFilters: a single pair produces single-element filters, never an unbounded/empty one", () => {
  const { tenantIds, idempotencyKeys } = ghlTenantKeyQueryFilters([{ tenantId: "solo-tenant", idempotencyKey: "solo-key" }]);
  assert.deepEqual(tenantIds, ["solo-tenant"]);
  assert.deepEqual(idempotencyKeys, ["solo-key"]);
});

// ---------------------------------------------------------------------------
// 3. buildOutboundText
// ---------------------------------------------------------------------------

test("buildOutboundText: text-only", () => {
  const result = buildOutboundText("hello there", []);
  assert.deepEqual(result, { ok: true, text: "hello there" });
});

test("buildOutboundText: text plus two attachment URLs, own lines, order preserved", () => {
  const result = buildOutboundText("check these out", ["https://x/a.jpg", "https://x/b.jpg"]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "check these out\nhttps://x/a.jpg\nhttps://x/b.jpg");
  }
});

test("buildOutboundText: attachments-only (empty message) is just the URLs", () => {
  const result = buildOutboundText("", ["https://x/a.jpg"]);
  assert.deepEqual(result, { ok: true, text: "https://x/a.jpg" });
});

test("buildOutboundText: no text AND no attachments is refused as empty, never sent blank", () => {
  const result = buildOutboundText("", []);
  assert.deepEqual(result, { ok: false, reason: "empty" });
});

test("buildOutboundText: combined length over 4096 is refused, never truncated", () => {
  const longText = "a".repeat(4090);
  const result = buildOutboundText(longText, ["https://x/attachment.jpg"]);
  assert.deepEqual(result, { ok: false, reason: "too_long" });
});

// ---------------------------------------------------------------------------
// addGhlInboundMessage — failure classification (adversarial-review finding
// 1, the at-most-once hole). Real network function, exercised directly by
// stubbing `globalThis.fetch` (same pattern `scripts/test/stripe.test.ts`'s
// automation-webhook suite already uses) rather than only via a drain-level
// fake — the bug lives INSIDE this function's own catch block, so a fake
// `addInboundMessage` dep (as `ghl-inbound.test.ts` uses) can never exercise
// it. Restore the real `fetch` after every test.
// ---------------------------------------------------------------------------

async function withStubbedFetch<T>(impl: () => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => impl()) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("addGhlInboundMessage: a genuine AbortSignal timeout is classified timeout_uncertain (never retried)", async () => {
  const result = await withStubbedFetch(
    async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
    () => addGhlInboundMessage("token", { contactId: "contact-1", conversationProviderId: "provider-1", body: "hi" })
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "timeout_uncertain");
});

test("addGhlInboundMessage: a mid-flight socket reset (TypeError, cause.code UND_ERR_SOCKET — reviewer's demonstrated localhost-probe shape) is classified timeout_uncertain, NOT unreachable (adversarial-review finding 1 — this is the fix; the old code returned 'unreachable' here, which is retryable and duplicated the reply)", async () => {
  const result = await withStubbedFetch(
    async () => {
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = { code: "UND_ERR_SOCKET" };
      throw err;
    },
    () => addGhlInboundMessage("token", { contactId: "contact-1", conversationProviderId: "provider-1", body: "hi" })
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "timeout_uncertain", "a post-body-delivered socket reset must be uncertain, never retryable");
});

test("addGhlInboundMessage: ECONNRESET (also possibly post-delivery) is classified timeout_uncertain, not unreachable", async () => {
  const result = await withStubbedFetch(
    async () => {
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
      throw err;
    },
    () => addGhlInboundMessage("token", { contactId: "contact-1", conversationProviderId: "provider-1", body: "hi" })
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "timeout_uncertain");
});

test("addGhlInboundMessage: a provably pre-flight failure (ECONNREFUSED — nothing was listening, nothing reached the wire) is classified unreachable and stays genuinely retryable", async () => {
  const result = await withStubbedFetch(
    async () => {
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      throw err;
    },
    () => addGhlInboundMessage("token", { contactId: "contact-1", conversationProviderId: "provider-1", body: "hi" })
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "unreachable");
});

test("addGhlInboundMessage: ENOTFOUND (DNS never resolved) is classified unreachable", async () => {
  const result = await withStubbedFetch(
    async () => {
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = { code: "ENOTFOUND" };
      throw err;
    },
    () => addGhlInboundMessage("token", { contactId: "contact-1", conversationProviderId: "provider-1", body: "hi" })
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "unreachable");
});

test("addGhlInboundMessage: a 2xx response is still 'ok' (fetch stub sanity check)", async () => {
  const result = await withStubbedFetch(
    async () => new Response("{}", { status: 200 }),
    () => addGhlInboundMessage("token", { contactId: "contact-1", conversationProviderId: "provider-1", body: "hi" })
  );
  assert.deepEqual(result, { ok: true });
});

test("addGhlInboundMessage: a 401/403 is classified 'unauthorized' and RETRYABLE, never a terminal 'rejected' (final cross-phase review finding 6)", async () => {
  // By the time this POST runs, resolveGhlAccessToken already believed the
  // token was fresh — a 401/403 here means it was invalidated in the narrow
  // window between that check and this request (a concurrent re-auth, a
  // clock-skew edge, an in-flight rotation), not that GHL will refuse this
  // exact message forever. The OLD code fell through the 429/>=500 checks
  // straight to the generic terminal 'rejected' branch for any other status
  // — this pins that a 401/403 gets its OWN retryable classification instead.
  for (const status of [401, 403]) {
    const result = await withStubbedFetch(
      async () => new Response("{}", { status }),
      () => addGhlInboundMessage("token", { contactId: "contact-1", conversationProviderId: "provider-1", body: "hi" })
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind, "unauthorized", `HTTP ${status} must not be classified 'rejected' (terminal)`);
  }
});

// ---------------------------------------------------------------------------
// Fixtures shared by the handleProviderOutboundMessage / drainGhlOutboundStatuses
// suites below.
// ---------------------------------------------------------------------------

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const LOCATION_ID = "loc-1";

function makeAccount(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: LOCATION_ID,
    tenantId: TENANT_ID,
    label: "Test Location",
    companyId: null,
    conversationProviderId: null,
    accessToken: "access-token-fresh",
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshToken: "refresh-token-1",
    status: "active",
    lastError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    accountId: "acc",
    activatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

interface FakeCall {
  method: string;
  args: unknown[];
}

/**
 * In-memory `GhlProviderRepo` — mirrors `src/lib/data/supabase.ts`'s actual
 * semantics closely enough to exercise every branch (dedupe on
 * (locationId, ghlMessageId), pending_text cleared on any non-pending_send
 * transition, markGhlOutboundReported's nullable-reportedStatus contract,
 * an atomic-ish claimGhlTokenRefresh).
 *
 * Multiple numbers (Task 3): `opts.numbers` seeds a location's
 * `ghl_location_numbers` rows and `opts.sticky` its `ghl_contact_numbers`
 * (keyed `${locationId}:${ghlContactId}`). With no `numbers` entry, a
 * location gets the one slot-1 default row install creates for the account's
 * own tenant (Task 2), so every pre-Task-3 test sees exactly one number.
 */
function createFakeRepo(
  accounts: GhlAccount[] = [],
  rawOpts: {
    numbers?: Record<string, LocationNumber[]>;
    sticky?: Record<string, string>;
    /** Opt-in groups (Task 9) — group contacts, keyed `${locationId}:${ghlContactId}`. */
    groups?: Record<string, { tenantId: string; groupJid: string; enabled: boolean; left?: boolean; numberRemoved?: boolean }>;
    billing?: { status: Account["billingStatus"] } | null | "default";
  } | { status: Account["billingStatus"] } | null | "default" = {}
) {
  /** Every `markWhatsappGroupLeft` call, in order (Task 9). */
  const groupsLeft: { tenantId: string; groupJid: string }[] = [];
  // Accounts and billing (merge): the default branch's second argument is
  // the owner's billing (`{ status }`, `null` for no owner account, or
  // "default" = active); ours is the numbers/sticky/groups options bag.
  // Both shapes are accepted here.
  type FakeBilling = { status: Account["billingStatus"] } | null | "default";
  type FakeOpts = {
    numbers?: Record<string, LocationNumber[]>;
    sticky?: Record<string, string>;
    groups?: Record<string, { tenantId: string; groupJid: string; enabled: boolean; left?: boolean; numberRemoved?: boolean }>;
    billing?: FakeBilling;
  };
  const isBillingArg = rawOpts === null || rawOpts === "default" || "status" in rawOpts;
  const opts: FakeOpts = isBillingArg ? {} : (rawOpts as FakeOpts);
  const billing: FakeBilling = isBillingArg ? (rawOpts as FakeBilling) : (opts.billing ?? "default");
  const accountsByLocation = new Map(accounts.map((a) => [a.locationId, a]));
  const rows = new Map<string, GhlOutboundMessage>();
  const bridgeLedger = new Map<string, { status: string; error: string | null }>();
  // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — outbound
  // attachment parts, keyed by their own id (mirrors `rows` above).
  const attachments = new Map<string, GhlOutboundAttachment>();
  const calls: FakeCall[] = [];
  // Reliability (T7): session summaries by tenant and opt-outs keyed `${tenantId}:${phone}`.
  const sessionsByTenant = new Map<string, WhatsappSessionSummary>();
  const optOuts = new Set<string>();
  /** SMS fallback memory: `${locationId}:${phone}` -> remembered-until ISO. `memoryReadFails` makes the read throw. */
  const notOnWhatsapp = new Map<string, string>();
  const memory = { readFails: false };
  let nextId = 1;
  let nextAttachmentId = 1;
  let claimedAt: number | null = null;

  const repo: GhlProviderRepo = {
    async getAccountById(id: string) {
      calls.push({ method: "getAccountById", args: [id] });
      if (billing === null) return null;
      const status = billing === "default" ? "active" : billing.status;
      return { id, name: "Acme", kind: "business", ownerEmail: "o@x.test", stripeCustomerId: null, stripeSubscriptionId: null, billingStatus: status, trialEndsAt: null, cancelledAt: null, cleanedUpAt: null, createdAt: "2026-10-01T00:00:00Z" } as Account;
    },
    async getWhatsappSessionSummary(coachId: string) {
      calls.push({ method: "getWhatsappSessionSummary", args: [coachId] });
      return sessionsByTenant.get(coachId) ?? null;
    },
    async getTenantPhone(tenantId: string) {
      calls.push({ method: "getTenantPhone", args: [tenantId] });
      return sessionsByTenant.get(tenantId)?.phoneNumber ?? null;
    },
    async rememberNotOnWhatsapp(locationId: string, phone: string, untilIso: string) {
      calls.push({ method: "rememberNotOnWhatsapp", args: [locationId, phone, untilIso] });
      notOnWhatsapp.set(`${locationId}:${phone}`, untilIso);
    },
    async isRememberedNotOnWhatsapp(locationId: string, phone: string, nowIso: string) {
      calls.push({ method: "isRememberedNotOnWhatsapp", args: [locationId, phone, nowIso] });
      if (memory.readFails) throw new Error("db down");
      const until = notOnWhatsapp.get(`${locationId}:${phone}`);
      return until !== undefined && until > nowIso;
    },
    async isOptedOut(tenantId: string, phone: string) {
      calls.push({ method: "isOptedOut", args: [tenantId, phone] });
      return optOuts.has(`${tenantId}:${phone}`);
    },
    async getGhlAccountByLocationId(locationId: string) {
      calls.push({ method: "getGhlAccountByLocationId", args: [locationId] });
      return accountsByLocation.get(locationId) ?? null;
    },
    async listLocationNumbers(locationId: string) {
      calls.push({ method: "listLocationNumbers", args: [locationId] });
      const seeded = opts.numbers?.[locationId];
      if (seeded) return seeded;
      const account = accountsByLocation.get(locationId);
      return account ? [{ tenantId: account.tenantId, slot: 1, isDefault: true, label: null }] : [];
    },
    async getStickyTenant(locationId: string, ghlContactId: string) {
      calls.push({ method: "getStickyTenant", args: [locationId, ghlContactId] });
      return opts.sticky?.[`${locationId}:${ghlContactId}`] ?? null;
    },
    async getWhatsappGroupByContact(locationId: string, ghlContactId: string) {
      calls.push({ method: "getWhatsappGroupByContact", args: [locationId, ghlContactId] });
      const group = opts.groups?.[`${locationId}:${ghlContactId}`];
      return group ? { ...group, left: group.left ?? false } : null;
    },
    async markWhatsappGroupLeft(tenantId: string, groupJid: string) {
      calls.push({ method: "markWhatsappGroupLeft", args: [tenantId, groupJid] });
      groupsLeft.push({ tenantId, groupJid });
    },
    async recordGhlOutboundMessage(draft: GhlOutboundMessageDraft) {
      calls.push({ method: "recordGhlOutboundMessage", args: [draft] });
      const existing = [...rows.values()].find((r) => r.locationId === draft.locationId && r.ghlMessageId === draft.ghlMessageId);
      if (existing) return { message: existing, isNew: false };
      const row: GhlOutboundMessage = {
        id: `row-${nextId++}`,
        locationId: draft.locationId,
        tenantId: draft.tenantId,
        ghlMessageId: draft.ghlMessageId,
        ghlContactId: draft.ghlContactId,
        idempotencyKey: draft.idempotencyKey,
        toPhone: draft.toPhone,
        hadAttachments: draft.hadAttachments,
        sendState: "pending_send",
        sendAttempts: 0,
        pendingText: draft.pendingText,
        refusalReason: null,
        reportedStatus: null,
        reportedAt: null,
        reportError: null, readReportedAt: null, readReportError: null,
        createdAt: new Date(Date.now() + nextId).toISOString(),
      };
      rows.set(row.id, row);
      return { message: row, isNew: true };
    },
    async updateGhlOutboundSendState(
      id: string,
      patch: { sendState: GhlOutboundMessage["sendState"]; sendAttempts?: number; refusalReason?: string; onlyIfSendState?: GhlOutboundMessage["sendState"] }
    ) {
      calls.push({ method: "updateGhlOutboundSendState", args: [id, patch] });
      const row = rows.get(id);
      if (!row) throw new Error(`no such row ${id}`);
      if (patch.onlyIfSendState !== undefined && row.sendState !== patch.onlyIfSendState) return 0;
      row.sendState = patch.sendState;
      if (patch.sendAttempts !== undefined) row.sendAttempts = patch.sendAttempts;
      // Mirrors src/lib/data/supabase.ts's own clearing rule (0070).
      // 0013: an accepted row keeps its text until its status is reported.
      if (patch.sendState === "refused") row.pendingText = null;
      // Mirrors src/lib/data/supabase.ts's own stamp-once rule (0071).
      if (patch.sendState === "refused" && patch.refusalReason !== undefined) row.refusalReason = patch.refusalReason;
      return 1;
    },
    async listHeldGhlOutboundMessages(tenantId: string, limit = 50) {
      calls.push({ method: "listHeldGhlOutboundMessages", args: [tenantId, limit] });
      return [...rows.values()].filter((r) => r.tenantId === tenantId && r.sendState === "held").slice(0, limit);
    },
    /**
     * Mirrors src/lib/data/supabase.ts's `ghl_accounts!inner(status)` filter
     * (adversarial-review finding 1) — excludes rows tied to a location
     * whose account isn't `'active'`, so this fake genuinely exercises the
     * starvation fix rather than silently diverging from production
     * behaviour (see the "drain starvation" test below).
     */
    async listUnreportedGhlOutboundMessages(limit = 50) {
      calls.push({ method: "listUnreportedGhlOutboundMessages", args: [limit] });
      return [...rows.values()]
        .filter((r) => r.reportedStatus === null)
        .filter((r) => accountsByLocation.get(r.locationId)?.status === "active")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    },
    async getWhatsappMessagesByTenantKeys(pairs: { tenantId: string; idempotencyKey: string }[]) {
      calls.push({ method: "getWhatsappMessagesByTenantKeys", args: [pairs] });
      const out: { coachId: string; idempotencyKey: string; status: string; error: string | null }[] = [];
      for (const p of pairs) {
        const entry = bridgeLedger.get(`${p.tenantId}:${p.idempotencyKey}`);
        if (entry) out.push({ coachId: p.tenantId, idempotencyKey: p.idempotencyKey, status: entry.status, error: entry.error });
      }
      return out;
    },
    async markGhlOutboundReported(id: string, patch: { reportedStatus: GhlOutboundMessage["reportedStatus"]; reportError: string | null }) {
      calls.push({ method: "markGhlOutboundReported", args: [id, patch] });
      const row = rows.get(id);
      if (!row) throw new Error(`no such row ${id}`);
      if (patch.reportedStatus !== null) {
        row.reportedStatus = patch.reportedStatus;
        row.reportedAt = new Date().toISOString();
        row.pendingText = null; // 0013: cleared when the status is reported
      }
      row.reportError = patch.reportError;
    },
    async claimGhlTokenRefresh(locationId: string) {
      calls.push({ method: "claimGhlTokenRefresh", args: [locationId] });
      const now = Date.now();
      if (claimedAt !== null && now - claimedAt < 30_000) return false;
      claimedAt = now;
      return true;
    },
    async saveGhlTokens(locationId: string, tokens: { accessToken: string; accessTokenExpiresAt: string; refreshToken: string }) {
      calls.push({ method: "saveGhlTokens", args: [locationId, tokens] });
      const account = accountsByLocation.get(locationId);
      if (!account) throw new Error(`no such account ${locationId}`);
      account.accessToken = tokens.accessToken;
      account.accessTokenExpiresAt = tokens.accessTokenExpiresAt;
      account.refreshToken = tokens.refreshToken;
      account.status = "active";
      account.lastError = null;
      claimedAt = null;
    },
    async markGhlNeedsReauth(locationId: string, error: string) {
      calls.push({ method: "markGhlNeedsReauth", args: [locationId, error] });
      const account = accountsByLocation.get(locationId);
      if (!account) throw new Error(`no such account ${locationId}`);
      account.status = "needs_reauth";
      account.lastError = error;
      claimedAt = null;
    },
    // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — mirrors
    // src/lib/data/supabase.ts's own semantics: bulk insert with generated
    // ids, batch fetch by parent id ordered by seq, per-part send-state
    // advance that clears pending_url on any non-pending_send transition
    // (0073's pending_url follows 0070's pending_text lifecycle verbatim).
    async recordGhlOutboundAttachments(drafts: GhlOutboundAttachmentDraft[]) {
      calls.push({ method: "recordGhlOutboundAttachments", args: [drafts] });
      const created: GhlOutboundAttachment[] = drafts.map((d) => ({
        id: `att-${nextAttachmentId++}`,
        outboundMessageId: d.outboundMessageId,
        seq: d.seq,
        idempotencyKey: d.idempotencyKey,
        pendingUrl: d.pendingUrl,
        fileName: d.fileName,
        sendState: "pending_send",
        refusalReason: null,
        // Migration 0074 (QA Major 5, WRITTEN NOT APPLIED) — mirrors the DB
        // column's own default of 0.
        sendAttempts: 0,
        createdAt: new Date().toISOString(),
      }));
      for (const a of created) attachments.set(a.id, a);
      return created;
    },
    async listGhlOutboundAttachmentsForMessages(outboundMessageIds: string[]) {
      calls.push({ method: "listGhlOutboundAttachmentsForMessages", args: [outboundMessageIds] });
      const wanted = new Set(outboundMessageIds);
      return [...attachments.values()].filter((a) => wanted.has(a.outboundMessageId)).sort((a, b) => a.seq - b.seq);
    },
    async updateGhlOutboundAttachmentSendState(
      id: string,
      patch: { sendState: GhlOutboundAttachment["sendState"]; sendAttempts?: number; refusalReason?: string }
    ) {
      calls.push({ method: "updateGhlOutboundAttachmentSendState", args: [id, patch] });
      const part = attachments.get(id);
      if (!part) throw new Error(`no such attachment ${id}`);
      part.sendState = patch.sendState;
      if (patch.sendState !== "pending_send") part.pendingUrl = null;
      if (patch.sendState === "refused" && patch.refusalReason !== undefined) part.refusalReason = patch.refusalReason;
      if (patch.sendAttempts !== undefined) part.sendAttempts = patch.sendAttempts;
    },
  };

  return { repo, accountsByLocation, rows, bridgeLedger, attachments, calls, groupsLeft, sessionsByTenant, optOuts, notOnWhatsapp, memory };
}

function makeSendResult(overrides: Partial<Extract<BridgeSendResult, { ok: true }>["message"]> = {}): BridgeSendResult {
  return {
    ok: true,
    replay: false,
    message: {
      id: "bridge-msg-1",
      idempotencyKey: "key-1",
      toPhone: "+447700900123",
      status: "accepted",
      waMessageId: null,
      error: null,
      createdAt: new Date().toISOString(),
      sentAt: null,
      ...overrides,
    },
  };
}

function makeDeps(overrides: Partial<GhlProviderDeps> = {}): {
  deps: GhlProviderDeps;
  deferred: (() => Promise<void>)[];
  sendCalls: SendWhatsappInput[];
  sendAttachmentCalls: SendWhatsappAttachmentInput[];
  statusCalls: { accessToken: string; messageId: string; status: string; errorMessage?: string }[];
} {
  const sendCalls: SendWhatsappInput[] = [];
  const sendAttachmentCalls: SendWhatsappAttachmentInput[] = [];
  const statusCalls: { accessToken: string; messageId: string; status: string; errorMessage?: string }[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const deps: GhlProviderDeps = {
    defer: (fn) => {
      deferred.push(fn);
    },
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return makeSendResult({ idempotencyKey: input.idempotencyKey, toPhone: input.to });
    },
    // Media plan (docs/MEDIA-PLAN.md §5, build-order step 8) — the
    // attachment-part counterpart to `sendWhatsapp` above, same default
    // "always a fresh accept" behaviour so tests that don't care about
    // attachments never have to think about this dep.
    sendAttachment: async (input) => {
      sendAttachmentCalls.push(input);
      return makeSendResult({ idempotencyKey: input.idempotencyKey, toPhone: input.to });
    },
    // Default: a generously-under-cap session, so the accept-time budget
    // check never blocks a test unless it deliberately overrides this to
    // exercise `hasSufficientOutboundBudget`'s refusal path.
    getSession: async (): Promise<BridgeSessionResult> => ({
      ok: true,
      session: { coachId: TENANT_ID, status: "connected", phoneNumber: "+447700900000", qr: null, sentToday: 0, dailyCap: 150, queueLength: 0 },
    }),
    updateStatus: async (accessToken, messageId, status, errorMessage) => {
      statusCalls.push({ accessToken, messageId, status, errorMessage });
      return { ok: true };
    },
    refreshToken: async () => ({ ok: false, kind: "invalid_grant" }),
    refreshWaitMs: 5,
    // A no-op, never the real `defaultGhlProviderDeps.notify` — that default
    // reaches `@/lib/slack` (and, transitively, `@/lib/data`'s live-mode
    // `next/headers` import) via a runtime `import()`, which this suite must
    // never trigger (offline, no Next.js runtime present under `node --test`).
    notify: () => {},
    ...overrides,
  };
  return { deps, deferred, sendCalls, sendAttachmentCalls, statusCalls };
}

function samplePayloadFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "SMS",
    locationId: LOCATION_ID,
    messageId: "ghl-msg-1",
    contactId: "ghl-contact-1",
    phone: "+447700900123",
    message: "hi there",
    attachments: [],
    userId: "ghl-user-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 4. Outbound phone normalisation (through handleProviderOutboundMessage)
// ---------------------------------------------------------------------------

test("handleProviderOutboundMessage: a strict E.164 phone passes through unchanged and the bridge is called with it", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls } = makeDeps();
  await handleProviderOutboundMessage(repo, samplePayloadFor({ phone: "+447700900123" }), deps);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, "+447700900123");
});

test("handleProviderOutboundMessage: a bare GB mobile number normalises before the bridge ever sees it", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls } = makeDeps();
  await handleProviderOutboundMessage(repo, samplePayloadFor({ phone: "07700 900123", messageId: "msg-a" }), deps);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, "+447700900123");
});

test("handleProviderOutboundMessage: an unparseable phone (no + or 00, not GB-national-shaped) never reaches the bridge — fixed 'failed' status reported inline", async () => {
  for (const badPhone of ["447700900123", "garbage", "", "12345"]) {
    const { repo } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, statusCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ phone: badPhone, messageId: `msg-${badPhone}` }), deps);
    assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.invalidPhone }, badPhone);
    assert.equal(sendCalls.length, 0, `bridge must not be called for phone=${JSON.stringify(badPhone)}`);
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].status, "failed");
    assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.invalidPhone);
  }
});

// ---------------------------------------------------------------------------
// 5. handleProviderOutboundMessage against fake repo + fake bridge + fake GHL
// ---------------------------------------------------------------------------

test("handleProviderOutboundMessage: unknown locationId — no bridge call, no status call, ignored", async () => {
  const { repo } = createFakeRepo([]); // no accounts installed at all
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ locationId: "unknown-loc" }), deps);
  assert.deepEqual(outcome, { kind: "ignored", reason: "unknown_location" });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 0);
});

test("handleProviderOutboundMessage: a non-SMS type is ignored before any account lookup", async () => {
  const { repo, calls } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ type: "Call" }), deps);
  assert.deepEqual(outcome, { kind: "ignored", reason: "non_sms_type" });
  assert.equal(sendCalls.length, 0);
  assert.equal(calls.filter((c) => c.method === "getGhlAccountByLocationId").length, 0);
});

test("handleProviderOutboundMessage: duplicate ghl_message_id (a webhook redelivery) never calls the bridge a second time", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls } = makeDeps();
  const payload = samplePayloadFor({ messageId: "dup-1" });
  const first = await handleProviderOutboundMessage(repo, payload, deps);
  const second = await handleProviderOutboundMessage(repo, payload, deps);
  assert.equal(first.kind, "accepted");
  assert.deepEqual(second, { kind: "duplicate" });
  assert.equal(sendCalls.length, 1, "the bridge must be called exactly once across both deliveries");
});

test("handleProviderOutboundMessage: bridge 202 accept -> row accepted, zero status calls", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()]);
  const { deps, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-accept" }), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(statusCalls.length, 0);
  const row = [...rows.values()][0];
  assert.equal(row.sendState, "accepted");
  assert.equal(row.pendingText, "hi there", "0013: an accepted row keeps its text until its status is reported");
});

test("handleProviderOutboundMessage: bridge 429 daily_cap_reached -> inline failed PUT with the fixed cap message", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: async () => ({ ok: false, code: "daily_cap_reached", message: "daily cap of 150 sends reached for this session" }),
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-cap" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.capReached });
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.capReached);
});

test("handleProviderOutboundMessage: bridge 409 session_not_connected -> inline failed", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: async () => ({ ok: false, code: "session_not_connected", message: "session status is 'disconnected'" }),
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-409" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.notConnected });
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "failed");
});

// ---------------------------------------------------------------------------
// Reliability T7 — hold on disconnect, refuse opted-out contacts
// ---------------------------------------------------------------------------

function sessionSummary(overrides: Partial<WhatsappSessionSummary> = {}): WhatsappSessionSummary {
  return { coachId: TENANT_ID, status: "disconnected", phoneNumber: "+447700900000", lastConnectedAt: "2026-10-15T10:00:00Z", lastDisconnectReason: null, sentToday: 0, heldMessages: 0, ...overrides };
}
const notConnectedSend: Partial<GhlProviderDeps> = {
  sendWhatsapp: async () => ({ ok: false, code: "session_not_connected", message: "not connected" }),
};

test("webhook: bridge says session_not_connected for a previously linked number -> row held, no status report", async () => {
  const { repo, rows, sessionsByTenant } = createFakeRepo([makeAccount()]);
  sessionsByTenant.set(TENANT_ID, sessionSummary());
  const { deps, statusCalls } = makeDeps(notConnectedSend);
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "held" });
  const row = [...rows.values()][0];
  assert.equal(row.sendState, "held");
  assert.equal(row.pendingText, "hi there");
  assert.equal(statusCalls.length, 0);
});

test("webhook: session_not_connected for a never-linked number -> refused notConnected, reported failed", async () => {
  const { repo, sessionsByTenant } = createFakeRepo([makeAccount()]);
  sessionsByTenant.set(TENANT_ID, sessionSummary({ lastConnectedAt: null, status: "waiting_qr" }));
  const { deps, statusCalls } = makeDeps(notConnectedSend);
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.notConnected });
  assert.equal(statusCalls[0].status, "failed");
});

test("webhook: banned number -> refused numberBanned, reported failed", async () => {
  const { repo, sessionsByTenant } = createFakeRepo([makeAccount()]);
  sessionsByTenant.set(TENANT_ID, sessionSummary({ status: "banned" }));
  const { deps, statusCalls } = makeDeps(notConnectedSend);
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.numberBanned });
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.numberBanned);
});

test("webhook: opted-out contact -> refused optedOut BEFORE any bridge call, reported failed", async () => {
  const { repo, optOuts, rows } = createFakeRepo([makeAccount()]);
  optOuts.add(`${TENANT_ID}:+447700900123`);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.optedOut });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.optedOut);
  assert.equal([...rows.values()][0].sendState, "refused");
});

test("webhook: opt-out is per number: same phone opted out on another tenant still sends here", async () => {
  const { repo, optOuts } = createFakeRepo([makeAccount()]);
  optOuts.add(`other-tenant:+447700900123`);
  const { deps, sendCalls } = makeDeps();
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
});

test("webhook: W11 over cap is still reported not sent, never held", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, statusCalls } = makeDeps({ sendWhatsapp: async () => ({ ok: false, code: "daily_cap_reached", message: "cap" }) });
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.capReached });
  assert.equal(statusCalls[0].status, "failed");
});

test("drain pending_send: bridge now says session_not_connected for a linked number -> held (not refused), no report", async () => {
  const bundle = createFakeRepo([makeAccount()]);
  bundle.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const { deps, statusCalls } = makeDeps({
    ...notConnectedSend,
  });
  // intake while the bridge is unreachable so the row stays pending_send
  await handleProviderOutboundMessage(bundle.repo, samplePayloadFor(), makeDeps({ sendWhatsapp: async () => ({ ok: false, code: "unreachable", message: "x" }) }).deps);
  const row = [...bundle.rows.values()][0];
  assert.equal(row.sendState, "pending_send");
  const result = await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(row.sendState, "held");
  assert.equal(row.pendingText, "hi there");
  assert.equal(result.held, 1);
  assert.equal(statusCalls.length, 0);
});

test("drain pending_send: contact opted out since -> refused optedOut, no resend, reported failed", async () => {
  const bundle = createFakeRepo([makeAccount()]);
  await handleProviderOutboundMessage(bundle.repo, samplePayloadFor(), makeDeps({ sendWhatsapp: async () => ({ ok: false, code: "unreachable", message: "x" }) }).deps);
  bundle.optOuts.add(`${TENANT_ID}:+447700900123`);
  const { deps, sendCalls, statusCalls } = makeDeps();
  await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.optedOut);
  assert.equal([...bundle.rows.values()][0].sendState, "refused");
});

test("handleProviderOutboundMessage: bridge unreachable -> row stays pending_send, no status call, handler still resolves ok (always-200 contract)", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()]);
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: async () => ({ ok: false, code: "unreachable", message: "WhatsApp bridge unreachable or timed out." }),
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-unreachable" }), deps);
  assert.deepEqual(outcome, { kind: "pending_retry" });
  assert.equal(statusCalls.length, 0);
  const row = [...rows.values()][0];
  assert.equal(row.sendState, "pending_send");
  assert.equal(row.pendingText, "hi there", "pending_text must be retained for the drain's retry");
});

// Adversarial-review finding 3: this test used to assert that a
// needs_reauth account NEVER gets an inline status PUT, full stop — pinning
// the exact defective behaviour the finding identified (a still-unexpired
// access token was being thrown away just because the account's REFRESH
// TOKEN had failed, which silently broke plan D3's "tenant needs_reauth ->
// failed immediately, inline" design and its own §6 risk-3 mitigation, "the
// inline failed status makes it visible inside GHL itself"). Replaced with
// the two cases that actually matter: a still-valid access token DOES
// report inline (fixed); an expired one still can't, but the true reason is
// now persisted for a later pass to use (see the drain test below).
test("handleProviderOutboundMessage: needs_reauth account with a STILL-VALID access token -> inline failed PUT IS attempted and reported (finding 3, fixed)", async () => {
  const account = makeAccount({ status: "needs_reauth", accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const { repo, rows } = createFakeRepo([account]);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-reauth-fresh" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.needsReauth });
  assert.equal(sendCalls.length, 0, "never attempt the bridge for a known-bad account");
  assert.equal(statusCalls.length, 1, "a still-unexpired access token means the inline failed PUT CAN be attempted, even though the refresh token is known-bad");
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.needsReauth);
  const row = [...rows.values()][0];
  assert.equal(row.sendState, "refused");
  assert.equal(row.reportedStatus, "failed", "reported immediately — the whole point of plan D3's design is that this refusal is visible in GHL right away");
  assert.equal(row.refusalReason, GHL_PROVIDER_REASONS.needsReauth);
});

test("handleProviderOutboundMessage: needs_reauth account with an EXPIRED access token -> no PUT attempted, but the true reason is persisted for later (finding 3)", async () => {
  const account = makeAccount({ status: "needs_reauth", accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const { repo, rows } = createFakeRepo([account]);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-reauth-expired" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.needsReauth });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 0, "no usable access token exists — the PUT must never even be attempted");
  const row = [...rows.values()][0];
  assert.equal(row.sendState, "refused");
  assert.equal(row.reportedStatus, null, "left unreported — the drain will retry once reconnected");
  assert.equal(row.reportError, GHL_PROVIDER_REASONS.noAccessToken);
  assert.equal(row.refusalReason, GHL_PROVIDER_REASONS.needsReauth, "the TRUE reason survives even though the report attempt itself failed");
});

test("handleProviderOutboundMessage: a disabled account never attempts the bridge or a status PUT, even with a fresh token — a human turned this off deliberately", async () => {
  const account = makeAccount({ status: "disabled", accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const { repo, rows } = createFakeRepo([account]);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-disabled" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.disabled });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 0, "disabled is a deliberate manual state — unlike needs_reauth, a fresh token changes nothing here");
  const row = [...rows.values()][0];
  assert.equal(row.refusalReason, GHL_PROVIDER_REASONS.disabled);
});

const REASON_GATE_NOT_ACTIVATED = "WhatsApp isn't activated for this sub-account";
const REASON_GATE_INACTIVE = "PingWren subscription inactive — the account owner needs to update billing";

test("sending gate: a location that is not activated is refused with the fixed string, reported failed inline, bridge never called", async () => {
  const { repo, rows, calls } = createFakeRepo([makeAccount({ activatedAt: null })]);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-gate-off" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: REASON_GATE_NOT_ACTIVATED });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 1, "GoHighLevel is told, not left waiting");
  assert.equal(statusCalls[0].status, "failed");
  const update = calls.find((c) => c.method === "updateGhlOutboundSendState");
  assert.deepEqual((update?.args[1] as { refusalReason: string }).refusalReason, REASON_GATE_NOT_ACTIVATED);
  assert.equal([...rows.values()][0].refusalReason, REASON_GATE_NOT_ACTIVATED);
});

test("sending gate: activated but the account is paused -> refused with the subscription-inactive string", async () => {
  const { repo } = createFakeRepo([makeAccount()], { status: "paused" });
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-gate-paused" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: REASON_GATE_INACTIVE });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 1);
});

test("sending gate: activated but the account row is missing -> refused as inactive", async () => {
  const { repo } = createFakeRepo([makeAccount()], null);
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-gate-missing" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: REASON_GATE_INACTIVE });
  assert.equal(sendCalls.length, 0);
});

test("sending gate: an unclaimed location (no account id) is refused as not activated", async () => {
  const { repo } = createFakeRepo([makeAccount({ accountId: null })]);
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-gate-unclaimed" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: REASON_GATE_NOT_ACTIVATED });
  assert.equal(sendCalls.length, 0);
});

for (const status of ["past_due", "comped", "trialing"] as const) {
  test(`sending gate: activated + ${status} still sends`, async () => {
    const { repo } = createFakeRepo([makeAccount()], { status });
    const { deps, sendCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: `msg-gate-${status}` }), deps);
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 1);
  });
}

test("sending gate: the media-split path is gated too", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo } = createFakeRepo([makeAccount({ activatedAt: null })]);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-gate-media", attachments: ["https://x/a.jpg"] }), deps);
    assert.deepEqual(outcome, { kind: "refused", reason: REASON_GATE_NOT_ACTIVATED });
    assert.equal(sendCalls.length, 0);
    assert.equal(sendAttachmentCalls.length, 0);
  });
});

test("drainGhlOutboundStatuses: the 'refused' defensive branch reports the row's PERSISTED refusal reason, not a generic fallback (finding 3)", async () => {
  const repoBundle = createFakeRepo([makeAccount()]); // active, fresh token — reporting IS possible now
  seedAcceptedRow(repoBundle, {
    sendState: "refused",
    refusalReason: GHL_PROVIDER_REASONS.needsReauth,
    reportError: GHL_PROVIDER_REASONS.noAccessToken,
  });
  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.needsReauth, "must forward the ORIGINAL refusal reason, never the generic fallback");
});

// ---------------------------------------------------------------------------
// 5b. Multiple numbers per location (Task 3) — which number an outbound goes
// out from: the contact's sticky number, else the location's default. A
// disconnected sticky number is NEVER silently swapped for another number (a
// reply from an unfamiliar number is worse than a visible failure). Merge
// ruling: one linked before is HELD on that number (the default branch's
// reliability promise); one never linked is refused with the sticky string.
// ---------------------------------------------------------------------------

const SECOND_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const STICKY_DISCONNECTED_REASON = "The WhatsApp number this contact uses is disconnected — reconnect it to reply";

/** Slot 1 is the default (the account's own tenant), slot 2 a second number labelled "Sales". */
const TWO_NUMBERS: Record<string, LocationNumber[]> = {
  [LOCATION_ID]: [
    { tenantId: TENANT_ID, slot: 1, isDefault: true, label: null },
    { tenantId: SECOND_TENANT_ID, slot: 2, isDefault: false, label: "Sales" },
  ],
};
const STICKY_TO_SECOND = { [`${LOCATION_ID}:ghl-contact-1`]: SECOND_TENANT_ID };

function sessionWithStatus(statusByTenant: Record<string, "connected" | "disconnected" | "logged_out">): GhlProviderDeps["getSession"] {
  return async (coachId) => ({
    ok: true,
    session: { coachId, status: statusByTenant[coachId] ?? "connected", phoneNumber: "+447700900000", qr: null, sentToday: 0, dailyCap: 150, queueLength: 0 },
  });
}

test("handleProviderOutboundMessage: a contact sticky to a second number sends from THAT number, and the intake row carries its tenant", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-sticky" }), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
  assert.equal([...rows.values()][0].tenantId, SECOND_TENANT_ID);
});

test("handleProviderOutboundMessage: no sticky row -> the location's default number", async () => {
  const numbers = { [LOCATION_ID]: TWO_NUMBERS[LOCATION_ID].map((n) => ({ ...n, isDefault: n.slot === 2 })) };
  const { repo, rows } = createFakeRepo([makeAccount()], { numbers });
  const { deps, sendCalls } = makeDeps();
  await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-default" }), deps);
  assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID, "slot 2 is the default here, not the account's tenant");
  assert.equal([...rows.values()][0].tenantId, SECOND_TENANT_ID);
});

test("handleProviderOutboundMessage (merge ruling): a sticky number that was linked before and is offline -> HELD on THAT number, one attempt from it only, no fallback, nothing reported", async () => {
  const { repo, rows, sessionsByTenant } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  sessionsByTenant.set(SECOND_TENANT_ID, sessionSummary({ coachId: SECOND_TENANT_ID }));
  const { deps, sendCalls, sendAttachmentCalls, statusCalls } = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: false, code: "session_not_connected", message: "session status is 'disconnected'" };
    },
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-sticky-down" }), deps);
  assert.deepEqual(outcome, { kind: "held" });
  assert.equal(sendCalls.length, 1, "one attempt, from the sticky number — never from another number");
  assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
  assert.equal(sendAttachmentCalls.length, 0);
  const row = [...rows.values()][0];
  assert.equal(row.tenantId, SECOND_TENANT_ID, "the hold is per number: the row stays on the sticky number");
  assert.equal(row.sendState, "held");
  assert.equal(row.pendingText, "hi there");
  assert.equal(statusCalls.length, 0);
});

test("handleProviderOutboundMessage (merge ruling): a sticky number never linked (no session summary) -> refused with the sticky-number string, never the default's", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  const { deps, statusCalls } = makeDeps(notConnectedSend);
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-sticky-never" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: STICKY_DISCONNECTED_REASON });
  assert.equal(GHL_PROVIDER_REASONS.stickyNumberDisconnected, STICKY_DISCONNECTED_REASON);
  assert.equal([...rows.values()][0].refusalReason, STICKY_DISCONNECTED_REASON);
  assert.equal(statusCalls[0].errorMessage, STICKY_DISCONNECTED_REASON);
});

test("handleProviderOutboundMessage (merge ruling): held rows on the DEFAULT number never hold a send from the sticky number (hold-behind is per number)", async () => {
  const bundle = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  const heldFor: string[] = [];
  bundle.repo.listHeldGhlOutboundMessages = async (tenantId: string) => {
    heldFor.push(tenantId);
    return tenantId === TENANT_ID ? [{ id: "older-on-default" } as GhlOutboundMessage] : [];
  };
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, samplePayloadFor({ messageId: "msg-sticky-not-behind" }), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.deepEqual(heldFor, [SECOND_TENANT_ID]);
  assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
});

test("handleProviderOutboundMessage: the bridge itself says session_not_connected for a non-default number -> the same fixed sticky string (the bridge stays authoritative)", async () => {
  const { repo } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  const { deps, sendCalls, statusCalls } = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: false, code: "session_not_connected", message: "session status is 'disconnected'" };
    },
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-sticky-race" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: STICKY_DISCONNECTED_REASON });
  assert.equal(sendCalls.length, 1, "exactly one attempt, from the sticky number — never retried from another");
  assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
  assert.equal(statusCalls[0].errorMessage, STICKY_DISCONNECTED_REASON);
});

test("handleProviderOutboundMessage: the DEFAULT number disconnected keeps today's behaviour — no pre-check, the bridge's own refusal, the existing string", async () => {
  const { repo } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS });
  const sessionCalls: string[] = [];
  const { deps, sendCalls, statusCalls } = makeDeps({
    getSession: async (coachId) => {
      sessionCalls.push(coachId);
      return sessionWithStatus({ [TENANT_ID]: "disconnected" })(coachId);
    },
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: false, code: "session_not_connected", message: "session status is 'disconnected'" };
    },
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-default-down" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.notConnected });
  assert.equal(sessionCalls.length, 0, "the default number's path never gains a session pre-check");
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].coachId, TENANT_ID);
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.notConnected);
});

test("handleProviderOutboundMessage: a sticky number whose session snapshot is unreadable still attempts the send (the diagnostic call never refuses on its own)", async () => {
  const { repo } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  const { deps, sendCalls } = makeDeps({
    getSession: async () => ({ ok: false, code: "unreachable", message: "WhatsApp bridge unreachable or timed out." }),
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-sticky-unknown" }), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
});

test("handleProviderOutboundMessage (media split, merge ruling): a sticky number that was linked before and is offline -> the whole message is HELD on that number", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, attachments, sessionsByTenant } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
    sessionsByTenant.set(SECOND_TENANT_ID, sessionSummary({ coachId: SECOND_TENANT_ID, status: "logged_out" }));
    const { deps, sendCalls, sendAttachmentCalls, statusCalls } = makeDeps({
      sendWhatsapp: async (input) => {
        sendCalls.push(input);
        return { ok: false, code: "session_not_connected", message: "not connected" };
      },
    });
    const outcome = await handleProviderOutboundMessage(
      repo,
      samplePayloadFor({ messageId: "msg-sticky-media-down", message: "docs", attachments: ["https://x/a.pdf"] }),
      deps
    );
    assert.deepEqual(outcome, { kind: "held" });
    assert.deepEqual(sendCalls.map((c) => c.coachId), [SECOND_TENANT_ID]);
    assert.equal(sendAttachmentCalls.length, 0);
    const row = [...rows.values()][0];
    assert.equal(row.tenantId, SECOND_TENANT_ID);
    assert.equal(row.sendState, "held");
    assert.deepEqual([...attachments.values()].map((p) => p.sendState), ["pending_send"]);
    assert.equal(statusCalls.length, 0);
  });
});

test("handleProviderOutboundMessage (media split): a sticky number sends every part from that number", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(
      repo,
      samplePayloadFor({ messageId: "msg-sticky-media", message: "docs", attachments: ["https://x/a.pdf"] }),
      deps
    );
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
    assert.equal(sendAttachmentCalls[0].coachId, SECOND_TENANT_ID);
  });
});

test("handleProviderOutboundMessage: no number rows at all (defensive) -> the account's own tenant, exactly as before multiple numbers", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()], { numbers: { [LOCATION_ID]: [] } });
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-no-numbers" }), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(sendCalls[0].coachId, TENANT_ID);
  assert.equal([...rows.values()][0].tenantId, TENANT_ID);
});

// ---------------------------------------------------------------------------
// 6. drainGhlOutboundStatuses
// ---------------------------------------------------------------------------

function seedAcceptedRow(
  repoBundle: ReturnType<typeof createFakeRepo>,
  overrides: Partial<GhlOutboundMessage> = {}
): GhlOutboundMessage {
  const row: GhlOutboundMessage = {
    id: overrides.id ?? `row-${repoBundle.rows.size + 1}`,
    locationId: LOCATION_ID,
    tenantId: TENANT_ID,
    ghlMessageId: `ghl-msg-${repoBundle.rows.size + 1}`,
    ghlContactId: "ghl-contact-1",
    idempotencyKey: `idem-${repoBundle.rows.size + 1}`,
    toPhone: "+447700900123",
    hadAttachments: false,
    sendState: "accepted",
    sendAttempts: 0,
    pendingText: null,
    refusalReason: null,
    reportedStatus: null,
    reportedAt: null,
    reportError: null, readReportedAt: null, readReportError: null,
    createdAt: new Date(Date.now() + repoBundle.rows.size).toISOString(),
    ...overrides,
  };
  repoBundle.rows.set(row.id, row);
  return row;
}

test("drainGhlOutboundStatuses: bridge ledger 'sent' -> delivered PUT, row stamped", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  const { deps, statusCalls } = makeDeps();

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.delivered, 1);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "delivered");
  assert.equal(row.reportedStatus, "delivered");
});

test("drainGhlOutboundStatuses: bridge ledger 'failed' -> failed PUT forwarding the ledger's own fixed reason", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, {
    status: "failed",
    error: "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key",
  });
  const { deps, statusCalls } = makeDeps();

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key");
});

test("drainGhlOutboundStatuses: bridge ledger 'not_on_whatsapp' -> failed PUT with the fixed 'no WhatsApp account' reason", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  const { deps, statusCalls } = makeDeps();

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.notOnWhatsapp);
});

test("drainGhlOutboundStatuses: bridge ledger still 'accepted' (unresolved) -> row left untouched", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "accepted", error: null });
  const { deps, statusCalls } = makeDeps();

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.unresolved, 1);
  assert.equal(statusCalls.length, 0);
  assert.equal(row.reportedStatus, null);
});

test("drainGhlOutboundStatuses: a pending_send row is retried with the SAME idempotency key and SAME text", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: "resend me please", sendAttempts: 2 });
  const sendCalls: SendWhatsappInput[] = [];
  const { deps } = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: false, code: "unreachable", message: "still down" };
    },
  });

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.retried, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].idempotencyKey, row.idempotencyKey);
  assert.equal(sendCalls[0].text, "resend me please");
  assert.equal(row.sendState, "pending_send");
  assert.equal(row.sendAttempts, 3);
  assert.equal(result.stillPending, 1);
});

for (const [label, accountOver, billing, reasonMatch] of [
  ["a paused (cancelled) account", {}, { status: "cancelled" as const }, /subscription inactive/],
  ["a not-activated number", { activatedAt: null }, "default" as const, /isn't activated/],
  ["an unclaimed location", { accountId: null }, "default" as const, /isn't activated/],
] as const) {
  test(`retry gate: a pending_send row for ${label} is not sent and is reported failed`, async () => {
    const repoBundle = createFakeRepo([makeAccount(accountOver)], billing);
    const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: "hold me", sendAttempts: 1 });
    const sendCalls: SendWhatsappInput[] = [];
    const { deps, statusCalls } = makeDeps({
      sendWhatsapp: async (input) => {
        sendCalls.push(input);
        return { ok: true, message: makeSendResult() } as never;
      },
    });
    const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
    assert.equal(sendCalls.length, 0);
    assert.equal(row.sendState, "refused");
    assert.equal(result.failed, 1);
    assert.equal(statusCalls[0].status, "failed");
    assert.match(statusCalls[0].errorMessage ?? "", reasonMatch);
  });
}

test("retry gate: a multipart text part retry for a paused account is not sent", async () => {
  const { repoBundle, row } = await seedMultipartRow({ messageId: "msg-mp-gate" });
  const sendCalls: SendWhatsappInput[] = [];
  row.sendState = "pending_send";
  row.pendingText = "retry text";
  row.sendAttempts = 1;
  const paused = createFakeRepo([makeAccount()], { status: "cancelled" });
  // Re-use the seeded rows/parts but swap in a repo whose owner is cancelled.
  for (const [k, v] of repoBundle.rows) paused.rows.set(k, v);
  for (const [k, v] of repoBundle.attachments) paused.attachments.set(k, v);
  const { deps } = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: true, message: makeSendResult() } as never;
    },
  });
  await withMediaOutboundEnabled(() => drainGhlOutboundStatuses(paused.repo, deps));
  assert.equal(sendCalls.length, 0);
  assert.equal(row.sendState, "refused");
});

test("drainGhlOutboundStatuses: a pending_send retry that succeeds transitions the row to accepted", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: "resend me please", sendAttempts: 1 });
  const { deps } = makeDeps();

  await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(row.sendState, "accepted");
  assert.equal(row.pendingText, "resend me please", "0013: kept until reported");
});

test("drainGhlOutboundStatuses: the 6th attempt (sendAttempts already at 5) gives up without calling the bridge again — reports the fixed exhaustion reason", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: "resend me please", sendAttempts: 5 });
  const { deps, sendCalls, statusCalls } = makeDeps();

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(sendCalls.length, 0, "the bridge must not be called a 6th time");
  assert.equal(result.failed, 1);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.bridgeUnreachableExhausted);
  assert.equal(row.sendState, "refused");
});

test("drainGhlOutboundStatuses: the GHL status PUT itself failing leaves the row unreported for the next pass, report_error stamped", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  const { deps } = makeDeps({
    updateStatus: async () => ({ ok: false, error: "GHL status update rejected: HTTP 500" }),
  });

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.reportFailed, 1);
  assert.equal(row.reportedStatus, null, "must remain unreported so the next pass retries");
  assert.equal(row.reportError, "GHL status update rejected: HTTP 500");

  // A second pass, with a now-healthy PUT, picks the SAME row back up.
  const { deps: healthyDeps, statusCalls } = makeDeps();
  const secondResult = await drainGhlOutboundStatuses(repoBundle.repo, healthyDeps);
  assert.equal(secondResult.delivered, 1);
  assert.equal(statusCalls.length, 1);
  assert.equal(row.reportedStatus, "delivered");
});

// ---------------------------------------------------------------------------
// 6b. Adversarial-review fixes: findings 1, 4, 5, 8 (test-quality gaps,
// finding 14).
// ---------------------------------------------------------------------------

test("drainGhlOutboundStatuses: unreported rows tied to a non-active account never crowd out a healthy row from the batch (finding 1 — drain starvation)", async () => {
  const healthyAccount = makeAccount({ locationId: "loc-healthy", tenantId: "22222222-2222-4222-8222-222222222222" });
  const stuckAccount = makeAccount({ locationId: "loc-stuck", tenantId: "33333333-3333-4333-8333-333333333333", status: "needs_reauth" });
  const repoBundle = createFakeRepo([healthyAccount, stuckAccount]);

  // A location stuck in needs_reauth with a big pile of refused,
  // still-unreported rows (each webhook-time inline report attempt failed
  // with "no access token"), all OLDER than the healthy row below — this is
  // exactly the shape finding 1 demonstrated: more than the drain's own
  // batch cap, oldest-first.
  for (let i = 0; i < 60; i++) {
    repoBundle.rows.set(`stuck-${i}`, {
      id: `stuck-${i}`,
      locationId: stuckAccount.locationId,
      tenantId: stuckAccount.tenantId,
      ghlMessageId: `stuck-msg-${i}`,
      ghlContactId: "ghl-contact-stuck",
      idempotencyKey: `stuck-key-${i}`,
      toPhone: "+447700900123",
      hadAttachments: false,
      sendState: "refused",
      sendAttempts: 0,
      pendingText: null,
      refusalReason: GHL_PROVIDER_REASONS.needsReauth,
      reportedStatus: null,
      reportedAt: null,
      reportError: GHL_PROVIDER_REASONS.noAccessToken,
      createdAt: new Date(2020, 0, 1, 0, 0, i).toISOString(), // ancient — sorts first, oldest-first
    });
  }

  const row = seedAcceptedRow(repoBundle, { locationId: healthyAccount.locationId, tenantId: healthyAccount.tenantId, createdAt: new Date().toISOString() });
  repoBundle.bridgeLedger.set(`${healthyAccount.tenantId}:${row.idempotencyKey}`, { status: "sent", error: null });

  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);

  assert.equal(result.delivered, 1, "the healthy row must still be reported even with 60 stuck rows created ahead of it");
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "delivered");
});

test("drainGhlOutboundStatuses: pending_send exhaustion with a ledger row present resolves via the ledger, not a blind exhaustion failure (finding 4)", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: "did this already go out?", sendAttempts: 5 });
  // The webhook-time (or an earlier retry) send call actually reached the
  // bridge — the bridge's own ledger says 'sent' — even though every
  // response back to US timed out (why sendAttempts reached the bound).
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  const { deps, sendCalls, statusCalls } = makeDeps();

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(sendCalls.length, 0, "must not blindly retry the bridge a 6th time");
  assert.equal(result.delivered, 1, "resolved via the ledger, not the exhaustion-failure path");
  assert.equal(result.failed, 0);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "delivered", "the message actually delivered — reporting 'failed' here would have been FALSE");
  assert.equal(row.sendState, "accepted");
});

test("drainGhlOutboundStatuses: a pending_send row with pendingText raced to null is rescued via the ledger, not blindly reported failed (final cross-phase review finding 2)", async () => {
  // Simulates the overlapping-drains race finding 2 describes: a FASTER
  // concurrent pass already moved this row to 'accepted' (which clears
  // pendingText) and the bridge ledger already shows 'sent' — but this row
  // is fed to the drain in a state that could only exist after a SLOWER
  // pass's own transient retry blindly demoted send_state back to
  // 'pending_send' without restoring pendingText (which the finding-2
  // supabase.ts guard now prevents at the write layer; this test pins the
  // ghl-provider.ts-level defensive check that gives the SAME row a second
  // chance to resolve correctly even if it ever gets here). sendAttempts is
  // deliberately BELOW the exhaustion bound (5) — this exercises the
  // DEFENSIVE branch (`!row.toPhone || row.pendingText === null`), not the
  // exhaustion branch a few lines above (already covered by finding 4).
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: null, sendAttempts: 1 });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  const { deps, sendCalls, statusCalls } = makeDeps();

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(sendCalls.length, 0, "must never call the bridge with a null pendingText");
  assert.equal(result.delivered, 1, "resolved via the ledger, not the defensive-refusal path");
  assert.equal(result.failed, 0);
  assert.equal(statusCalls.length, 1);
  assert.equal(
    statusCalls[0].status,
    "delivered",
    "the message actually delivered — reporting 'failed' here would have been FALSE (finding 2)"
  );
  assert.equal(row.sendState, "accepted");
});

test("handleProviderOutboundMessage: an unknown/internal/unauthorized bridge failure code is TRANSIENT, not a terminal refusal (finding 5)", async () => {
  for (const code of ["internal", "unauthorized", "some_future_code_this_build_has_never_seen"]) {
    const { repo, rows } = createFakeRepo([makeAccount()]);
    const { deps, statusCalls } = makeDeps({
      sendWhatsapp: async () => ({ ok: false, code, message: "bridge responded oddly" }),
    });
    const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: `msg-${code}` }), deps);
    assert.deepEqual(outcome, { kind: "pending_retry" }, code);
    assert.equal(statusCalls.length, 0, `no status call yet for code=${code}`);
    const row = [...rows.values()][0];
    assert.equal(row.sendState, "pending_send", code);
  }
});

test("handleProviderOutboundMessage: bridge lease_unavailable stays transient (unchanged by finding 5's fix)", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()]);
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: async () => ({ ok: false, code: "lease_unavailable", message: "mid-redeploy handoff" }),
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-lease" }), deps);
  assert.deepEqual(outcome, { kind: "pending_retry" });
  assert.equal(statusCalls.length, 0);
  assert.equal([...rows.values()][0].sendState, "pending_send");
});

test("drainGhlOutboundStatuses: a pending_send retry that again returns an unknown/internal code stays bounded by the attempt count, never misclassified as terminal (finding 5)", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: "retry me", sendAttempts: 2 });
  const sendCalls: SendWhatsappInput[] = [];
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: false, code: "internal", message: "bridge behind a broken edge proxy" };
    },
  });

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(sendCalls.length, 1);
  assert.equal(statusCalls.length, 0);
  assert.equal(row.sendState, "pending_send");
  assert.equal(row.sendAttempts, 3);
  assert.equal(result.stillPending, 1);
});

test("drainGhlOutboundStatuses: two concurrent drains over the SAME pending_send row both call the bridge under the same key — safe via the bridge's own replay (finding 8, accepted)", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { sendState: "pending_send", pendingText: "resend", sendAttempts: 0 });
  const sendCalls: SendWhatsappInput[] = [];
  const { deps } = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: false, code: "unreachable", message: "still down" };
    },
  });

  await Promise.all([drainGhlOutboundStatuses(repoBundle.repo, deps), drainGhlOutboundStatuses(repoBundle.repo, deps)]);

  // The property finding 8 actually needs held: BOTH overlapping passes call
  // the bridge for the SAME row, under the SAME idempotency key — the bridge
  // sees two send calls for one message, never a double send, because its
  // own replay path (not this counter) is what makes that safe.
  assert.equal(sendCalls.length, 2, "both overlapping drains independently retried this row");
  assert.ok(sendCalls.every((c) => c.idempotencyKey === row.idempotencyKey), "both retries used the SAME idempotency key");
  // NOTE on send_attempts: this fake repo mutates one shared row object in
  // place, so it does not reproduce the exact "both readers see the SAME
  // stale snapshot" shape a real Postgres round trip would (two real
  // concurrent SELECTs each capture their own copy of the row BEFORE either
  // UPDATE lands, so both compute `0 + 1` and the second write clobbers the
  // first with the SAME value 1 — an undercount). What both this fake and a
  // real database agree on regardless of exact interleaving: the counter is
  // NOT double-booked to 2× the number of real dispatch attempts made
  // safe-by-idempotency-key above, which is the only property
  // `PENDING_SEND_MAX_ATTEMPTS` actually depends on (see `drainPendingSend`'s
  // finding-8 comment) — a bound, not a precise count.
  assert.ok(row.sendAttempts >= 1 && row.sendAttempts <= 2, `expected a bounded, non-exploding counter, got ${row.sendAttempts}`);
});

test("handleProviderOutboundMessage: a repo failure BEFORE the intake row exists resolves to {kind:'error', recorded:false}, never an uncaught rejection (finding 6)", async () => {
  const repo: GhlProviderRepo = {
    async getGhlAccountByLocationId() {
      throw new Error("simulated transient Supabase error");
    },
    async recordGhlOutboundMessage() {
      throw new Error("unreachable in this test");
    },
    async updateGhlOutboundSendState() { return 1; },
    async listHeldGhlOutboundMessages() { return []; },
    async listUnreportedGhlOutboundMessages() {
      return [];
    },
    async getWhatsappMessagesByTenantKeys() {
      return [];
    },
    async markGhlOutboundReported() {},
    async claimGhlTokenRefresh() {
      return false;
    },
    async saveGhlTokens() {},
    async markGhlNeedsReauth() {},
    async listLocationNumbers() {
      return [];
    },
    async getStickyTenant() {
      return null;
    },
  };
  const { deps } = makeDeps();
  // If this rejects, the `await` throws and the test fails with that error —
  // the assertion below only runs once we've proven it resolved instead.
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor(), deps);
  assert.deepEqual(outcome, { kind: "error", recorded: false });
});

test("handleProviderOutboundMessage: a repo failure AFTER the intake row exists resolves to {kind:'error', recorded:true} — the drain owns it from here (finding 6)", async () => {
  const { repo: baseRepo } = createFakeRepo([makeAccount()]);
  const repo: GhlProviderRepo = {
    ...baseRepo,
    async updateGhlOutboundSendState(): Promise<number> {
      throw new Error("simulated transient Supabase error, mid-handler");
    },
  };
  const { deps } = makeDeps({
    // Force the "refused" path so updateGhlOutboundSendState is reached.
    sendWhatsapp: async () => ({ ok: false, code: "session_not_connected", message: "not connected" }),
  });
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-post-row-error" }), deps);
  assert.deepEqual(outcome, { kind: "error", recorded: true });
});

// ---------------------------------------------------------------------------
// 7. Token refresh single-flight (plan's D2)
// ---------------------------------------------------------------------------

test("token refresh: two concurrent reporters against the same stale-token account trigger exactly ONE refresh call — the loser reads the winner's token", async () => {
  const staleAccount = makeAccount({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const repoBundle = createFakeRepo([staleAccount]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });

  let refreshCalls = 0;
  const { deps, statusCalls } = makeDeps({
    // The loser's wait must comfortably outlast the winner's simulated
    // refresh latency below, so the loser's re-read always observes the
    // winner's fresh token rather than a stale in-flight one — a real
    // 30-second wait against a sub-second refresh call has the same margin.
    refreshWaitMs: 40,
    refreshToken: async (refreshToken) => {
      refreshCalls++;
      assert.equal(refreshToken, "refresh-token-1");
      // Simulate real network latency so both concurrent callers are
      // genuinely racing the claim, not serialised by coincidence.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        tokens: { accessToken: "fresh-access-token", refreshToken: "refresh-token-1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), locationId: null, companyId: null },
      };
    },
  });

  // Both calls race to report the SAME unreported row — see this file's own
  // comment on why this exercises the claim exactly like two overlapping
  // poke/cron passes would.
  await Promise.all([drainGhlOutboundStatuses(repoBundle.repo, deps), drainGhlOutboundStatuses(repoBundle.repo, deps)]);

  assert.equal(refreshCalls, 1, "exactly one caller should have won the refresh claim");
  assert.ok(statusCalls.length >= 1);
  for (const call of statusCalls) {
    assert.equal(call.accessToken, "fresh-access-token", "every reporter must end up using the WINNER's fresh token");
  }
});

test("token refresh: a TRANSIENT failure (timeout/network/non-invalid_grant status) does NOT mark needs_reauth — status stays active, self-heals next call (final cross-phase review finding 1)", async () => {
  const staleAccount = makeAccount({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const repoBundle = createFakeRepo([staleAccount]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });

  // A slow/5xx/network-error token-endpoint response — GHL said NOTHING
  // about the refresh token itself being bad, so this must be treated
  // completely differently from `invalid_grant` (the test right below).
  const { deps, statusCalls } = makeDeps({ refreshToken: async () => ({ ok: false, kind: "transient" }) });
  await drainGhlOutboundStatuses(repoBundle.repo, deps);

  const account = repoBundle.accountsByLocation.get(LOCATION_ID)!;
  assert.equal(account.status, "active", "a transient refresh failure must NEVER flip the account to needs_reauth — this is the one-slow-response-strands-the-location bug");
  assert.equal(account.lastError, null, "no needs_reauth reason should ever be stamped for a transient failure");
  assert.equal(statusCalls.length, 0, "no usable token this pass — nothing was attempted against GHL");
  assert.equal(row.reportedStatus, null, "left unreported so the very next pass (once GHL recovers) retries the refresh automatically, no manual reinstall needed");
});

test("token refresh: the claim-loser only returns the re-read token if it is ACTUALLY fresh — never a token the winner hasn't written yet (final cross-phase review finding 6)", async () => {
  const staleAccount = makeAccount({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const repoBundle = createFakeRepo([staleAccount]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });

  // Force the loser branch deterministically ("someone else already holds
  // the claim") and never let a winner actually refresh anything — the
  // re-read account the loser sees back is therefore STILL genuinely
  // expired, exactly the "winner's refresh hasn't landed yet" scenario.
  const repo: GhlProviderRepo = { ...repoBundle.repo, claimGhlTokenRefresh: async () => false };
  const { deps, statusCalls } = makeDeps({ refreshWaitMs: 1 });

  const result = await drainGhlOutboundStatuses(repo, deps);
  assert.equal(statusCalls.length, 0, "must never report status using a token that was never verified fresh — the old code returned it the instant status === 'active', with no freshness check at all");
  assert.equal(result.reportFailed, 1, "left unreported (no access token available) rather than falsely reported using a stale token");
  assert.equal(result.delivered, 0);
});

test("token refresh: invalid_grant -> needs_reauth, no token overwrite", async () => {
  const staleAccount = makeAccount({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const repoBundle = createFakeRepo([staleAccount]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });

  const { deps, statusCalls } = makeDeps({ refreshToken: async () => ({ ok: false, kind: "invalid_grant" }) });
  await drainGhlOutboundStatuses(repoBundle.repo, deps);

  const account = repoBundle.accountsByLocation.get(LOCATION_ID)!;
  assert.equal(account.status, "needs_reauth");
  assert.equal(account.accessToken, "access-token-fresh", "the old (now-expired) token must never be silently kept as if it were still valid, but also never overwritten with garbage");
  assert.equal(statusCalls.length, 0, "no token was ever obtained — the PUT must never be attempted");
  assert.equal(row.reportedStatus, null);
});

test("token refresh: a refresh response omitting refresh_token carries the OLD refresh token through (never overwritten with null)", async () => {
  const staleAccount = makeAccount({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(), refreshToken: "original-refresh-token" });
  const repoBundle = createFakeRepo([staleAccount]);
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });

  const { deps } = makeDeps({
    refreshToken: async () => ({
      ok: true,
      tokens: {
        accessToken: "new-access-token",
        refreshToken: null, // GHL omitted it on this refresh — assumed possible, plan §0.
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        locationId: null,
        companyId: null,
      },
    }),
  });
  await drainGhlOutboundStatuses(repoBundle.repo, deps);

  const account = repoBundle.accountsByLocation.get(LOCATION_ID)!;
  assert.equal(account.refreshToken, "original-refresh-token");
  assert.equal(account.accessToken, "new-access-token");
  assert.equal(account.status, "active");
});

// ---------------------------------------------------------------------------
// 8. Media plan (docs/MEDIA-PLAN.md §5, build-order steps 8-9) — the
// outbound attachment PART-SPLITTING path: `handleMediaSplitOutbound` and
// `drainMultipartRow`/`resolveTextPartOutcome`/`resolveAttachmentPartOutcome`
// in src/lib/ghl-provider.ts. Every test that needs the flag ON wraps itself
// in `withMediaOutboundEnabled` and restores `process.env` afterwards —
// nothing here ever leaks the flag into an unrelated test.
// ---------------------------------------------------------------------------

async function withMediaOutboundEnabled<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.WA_MEDIA_OUTBOUND_ENABLED;
  process.env.WA_MEDIA_OUTBOUND_ENABLED = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.WA_MEDIA_OUTBOUND_ENABLED;
    else process.env.WA_MEDIA_OUTBOUND_ENABLED = previous;
  }
}

/** Belt-and-braces: every test in this whole suite runs with the flag OFF unless it explicitly opts in via `withMediaOutboundEnabled` — pins the "dark by default" contract even if some future test elsewhere in this file forgets to restore it. */
test("sanity: WA_MEDIA_OUTBOUND_ENABLED is unset entering the media-plan test section", () => {
  assert.equal(process.env.WA_MEDIA_OUTBOUND_ENABLED, undefined);
});

// ---------------------------------------------------------------------------
// 8a. FLAGS-OFF REGRESSION — the single most important test in this section
// (per the build instructions). With the portal's own switch off, a webhook
// payload carrying attachments must produce BYTE-IDENTICAL behaviour to the
// pre-media-plan code: one buildOutboundText call with the URLs folded in as
// link lines, exactly one bridge send, zero attachment-part machinery
// touched at all.
// ---------------------------------------------------------------------------

test("FLAGS-OFF REGRESSION: WA_MEDIA_OUTBOUND_ENABLED unset + a payload WITH attachments — old single-send link-line shape, unchanged", async () => {
  assert.equal(process.env.WA_MEDIA_OUTBOUND_ENABLED, undefined, "test bug — this must run with the flag genuinely unset");
  const { repo, rows } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(
    repo,
    samplePayloadFor({ messageId: "msg-flags-off", message: "check these out", attachments: ["https://x/a.jpg", "https://x/b.jpg"] }),
    deps
  );
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(sendCalls.length, 1, "exactly ONE bridge send — never N+1 — with the flag off");
  assert.equal(sendAttachmentCalls.length, 0, "the attachment send path must never be touched with the flag off");
  assert.equal(sendCalls[0].text, "check these out\nhttps://x/a.jpg\nhttps://x/b.jpg", "the exact pre-media-plan buildOutboundText link-line shape");
  assert.equal(sendCalls[0].idempotencyKey, deriveIdempotencyKey("msg-flags-off"));
  const row = [...rows.values()][0];
  assert.equal(row.hadAttachments, true);
  assert.equal(row.sendState, "accepted");
});

test("FLAGS-OFF REGRESSION: WA_MEDIA_OUTBOUND_ENABLED=false explicitly (not just unset) — same single-send behaviour", async () => {
  const previous = process.env.WA_MEDIA_OUTBOUND_ENABLED;
  process.env.WA_MEDIA_OUTBOUND_ENABLED = "false";
  try {
    const { repo } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(
      repo,
      samplePayloadFor({ messageId: "msg-flags-explicit-false", message: "hi", attachments: ["https://x/a.jpg"] }),
      deps
    );
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendAttachmentCalls.length, 0);
    assert.equal(sendCalls[0].text, "hi\nhttps://x/a.jpg");
  } finally {
    if (previous === undefined) delete process.env.WA_MEDIA_OUTBOUND_ENABLED;
    else process.env.WA_MEDIA_OUTBOUND_ENABLED = previous;
  }
});

test("FLAGS-OFF REGRESSION: flag ON but NO attachments in the payload — still the legacy single-send path (mediaSplit requires BOTH)", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-flag-on-no-attachments", message: "just text", attachments: [] }), deps);
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendAttachmentCalls.length, 0);
    assert.equal(sendCalls[0].text, "just text");
  });
});

// ---------------------------------------------------------------------------
// 8b. Part-splitting arithmetic and derived idempotency keys.
// ---------------------------------------------------------------------------

test("deriveAttachmentIdempotencyKey: always the sha256 digest, distinct per seq, distinct from the text part's own key, regex-valid", () => {
  const messageId = "ghl-msg-plain-id"; // itself already regex-valid — deriveIdempotencyKey would pass it through VERBATIM.
  const textKey = deriveIdempotencyKey(messageId);
  assert.equal(textKey, messageId, "test fixture sanity — this id must be the verbatim-passthrough case");

  const key0 = deriveAttachmentIdempotencyKey(messageId, 0);
  const key1 = deriveAttachmentIdempotencyKey(messageId, 1);
  assert.notEqual(key0, key1, "distinct seq must produce distinct keys");
  assert.notEqual(key0, textKey, "an attachment key must never collide with the text part's own key");
  assert.match(key0, /^[a-f0-9]{64}$/, "always the sha256 hex digest — never a verbatim passthrough, unlike deriveIdempotencyKey");
  assert.equal(key0, deriveAttachmentIdempotencyKey(messageId, 0), "deterministic across calls");
  // QA Minor 8 fix — domain-separated hash input ("A|" + seq + "|" + id),
  // no longer the bare "${id}:a${seq}" the collision report was about.
  assert.equal(key0, createHash("sha256").update(`A|0|${messageId}`, "utf8").digest("hex"));
});

test("QA Minor 8: the collision the old (non-domain-separated) derivation had is now closed — a messageId shaped like the OLD attachment hash input no longer collides with that attachment's key", () => {
  // The bug this closes: deriveIdempotencyKey's hash branch used to hash
  // `ghlMessageId` bare, and deriveAttachmentIdempotencyKey used to hash
  // `${ghlMessageId}:a${seq}` bare — the SAME string space, no separator.
  // A messageId literally equal to "X:a0" (which fails the verbatim regex,
  // so it hashes) used to produce the exact same digest as attachment 0 of
  // messageId "X". Prove that's no longer true.
  const collidingMessageId = "X:a0"; // shaped exactly like the old attachment-key hash input for id="X", seq=0.
  const textKeyForCollidingId = deriveIdempotencyKey(collidingMessageId);
  const attachmentKeyForOtherMessage = deriveAttachmentIdempotencyKey("X", 0);
  assert.notEqual(
    textKeyForCollidingId,
    attachmentKeyForOtherMessage,
    "domain separation ('T|' vs 'A|' prefixes) must keep these two unrelated messages' keys apart"
  );
});

test("deriveMediaFallbackIdempotencyKey: deterministic, regex-valid, and distinct from BOTH the text and every attachment key for the same messageId", () => {
  const messageId = "ghl-msg-fallback-id";
  const fallbackKey = deriveMediaFallbackIdempotencyKey(messageId);
  assert.equal(fallbackKey, deriveMediaFallbackIdempotencyKey(messageId), "deterministic across calls");
  assert.match(fallbackKey, /^[a-f0-9]{64}$/);
  assert.match(fallbackKey, BRIDGE_KEY_RE);
  assert.notEqual(fallbackKey, deriveIdempotencyKey(messageId));
  assert.notEqual(fallbackKey, deriveAttachmentIdempotencyKey(messageId, 0));
  assert.notEqual(fallbackKey, deriveAttachmentIdempotencyKey(messageId, 1));
});

test("deriveAttachmentIdempotencyKey: matches the bridge's own idempotency-key regex", () => {
  for (const [id, seq] of [["a", 0], ["msg.with.dots", 3], ["x".repeat(300), 12]] as [string, number][]) {
    assert.match(deriveAttachmentIdempotencyKey(id, seq), BRIDGE_KEY_RE);
  }
});

test("handleMediaSplitOutbound (via handleProviderOutboundMessage): text + N attachments dispatches exactly 1 + N bridge sends, one text send then N attachment sends in seq order, each with its own derived key", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, attachments } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const messageId = "msg-split-1";
    const urls = ["https://cdn.example.com/a.pdf", "https://cdn.example.com/b.pdf", "https://cdn.example.com/c.pdf"];
    const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId, message: "here are your docs", attachments: urls }), deps);

    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 1, "exactly one text part");
    // The text part must be PURE — no attachment URLs folded in (unlike the
    // legacy buildOutboundText(message, attachments) shape).
    assert.equal(sendCalls[0].text, "here are your docs");
    assert.equal(sendCalls[0].idempotencyKey, deriveIdempotencyKey(messageId));

    assert.equal(sendAttachmentCalls.length, 3, "text + 3 attachments = 1 text send + 3 attachment sends (the N+1 part model)");
    for (let seq = 0; seq < 3; seq++) {
      assert.equal(sendAttachmentCalls[seq].attachment.url, urls[seq], `part ${seq} dispatched in seq order`);
      assert.equal(sendAttachmentCalls[seq].idempotencyKey, deriveAttachmentIdempotencyKey(messageId, seq));
    }

    const row = [...rows.values()][0];
    assert.equal(row.sendState, "accepted");
    const parts = [...attachments.values()].sort((a, b) => a.seq - b.seq);
    assert.equal(parts.length, 3);
    assert.deepEqual(
      parts.map((p) => p.sendState),
      ["accepted", "accepted", "accepted"]
    );
  });
});

test("handleMediaSplitOutbound: an attachments-only message (empty text) sends ZERO text parts and N attachment parts — not a refusal", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(
      repo,
      samplePayloadFor({ messageId: "msg-attachments-only", message: "", attachments: ["https://cdn.example.com/x.jpg"] }),
      deps
    );
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 0, "no text to send — must never send an empty/blank text message");
    assert.equal(sendAttachmentCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 8c. Accept-time budget check (plan §5.6, decision O3) — refuses the WHOLE
// message up front when its parts don't all fit the remaining daily budget,
// BEFORE any part is dispatched (never partial dispatch then a stall).
// ---------------------------------------------------------------------------

test("accept-time budget check: text + 2 attachments (3 units) exceeding the remaining budget refuses the WHOLE message before ANY part is dispatched", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, attachments } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, sendAttachmentCalls, statusCalls } = makeDeps({
      getSession: async () => ({
        ok: true,
        session: { coachId: TENANT_ID, status: "connected", phoneNumber: "+447700900000", qr: null, sentToday: 148, dailyCap: 150, queueLength: 0 }, // only 2 remaining
      }),
    });
    const outcome = await handleProviderOutboundMessage(
      repo,
      samplePayloadFor({ messageId: "msg-cap-3-units", message: "docs", attachments: ["https://x/a.pdf", "https://x/b.pdf"] }),
      deps
    );
    assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.capReached });
    assert.equal(sendCalls.length, 0, "must never dispatch the text part when the budget check fails");
    assert.equal(sendAttachmentCalls.length, 0, "must never dispatch ANY attachment part when the budget check fails");
    assert.equal(attachments.size, 0, "no ghl_outbound_attachments rows are ever written for a message refused before dispatch");
    const row = [...rows.values()][0];
    assert.equal(row.sendState, "refused");
    assert.equal(row.refusalReason, GHL_PROVIDER_REASONS.capReached);
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].status, "failed");
    assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.capReached);
  });
});

test("accept-time budget check: text + 3 attachments (4 units) fitting EXACTLY the remaining budget proceeds and dispatches all 4 parts (the N+1 arithmetic, pinned)", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps({
      getSession: async () => ({
        ok: true,
        session: { coachId: TENANT_ID, status: "connected", phoneNumber: "+447700900000", qr: null, sentToday: 146, dailyCap: 150, queueLength: 0 }, // exactly 4 remaining
      }),
    });
    const outcome = await handleProviderOutboundMessage(
      repo,
      samplePayloadFor({ messageId: "msg-cap-exact-fit", message: "three files", attachments: ["https://x/a.pdf", "https://x/b.pdf", "https://x/c.pdf"] }),
      deps
    );
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendAttachmentCalls.length, 3, "text(1) + 3 attachments = 4 units, exactly the remaining budget — must proceed, not refuse");
  });
});

test("accept-time budget check: when the session snapshot itself is unavailable (bridge unconfigured/unreachable), the check does not block — the bridge's own per-part cap remains the backstop", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo } = createFakeRepo([makeAccount()]);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps({
      getSession: async () => ({ ok: false, code: "unreachable", message: "WhatsApp bridge unreachable or timed out." }),
    });
    const outcome = await handleProviderOutboundMessage(
      repo,
      samplePayloadFor({ messageId: "msg-cap-unverifiable", message: "hi", attachments: ["https://x/a.pdf", "https://x/b.pdf", "https://x/c.pdf"] }),
      deps
    );
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendAttachmentCalls.length, 3, "an unreadable session snapshot must never itself refuse the message");
  });
});

// ---------------------------------------------------------------------------
// QA Major 6 — portal=true/bridge=false (the split runs, but the BRIDGE's own
// WA_MEDIA_OUTBOUND_ENABLED is off): the text part goes out WITHOUT the URLs
// (mediaSplit builds it text-only) and every attachment part hits the
// bridge's terminal media_outbound_disabled refusal — content-preserving
// fallback must fold those URLs into one extra text send rather than losing
// them.
// ---------------------------------------------------------------------------

/**
 * `makeDeps`'s own `sendCalls`/`sendAttachmentCalls` trackers only populate
 * when its DEFAULT `sendWhatsapp`/`sendAttachment` implementations run — an
 * `overrides.sendWhatsapp`/`overrides.sendAttachment` here REPLACES those
 * defaults entirely, so this wraps both in its own tracking regardless of
 * whether a test further overrides one of them, and delegates to the
 * caller's override (if any) for the actual return value.
 */
function makeMediaDisabledDeps(overrides: Partial<GhlProviderDeps> = {}) {
  const sendCalls: SendWhatsappInput[] = [];
  const sendAttachmentCalls: SendWhatsappAttachmentInput[] = [];
  const { sendWhatsapp: sendWhatsappOverride, sendAttachment: sendAttachmentOverride, ...rest } = overrides;
  const bundle = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return sendWhatsappOverride ? sendWhatsappOverride(input) : makeSendResult({ idempotencyKey: input.idempotencyKey, toPhone: input.to });
    },
    sendAttachment: async (input) => {
      sendAttachmentCalls.push(input);
      return sendAttachmentOverride
        ? sendAttachmentOverride(input)
        : ({ ok: false, code: "media_outbound_disabled", message: "attachment sends are not enabled on this bridge" } as const);
    },
    ...rest,
  });
  return { ...bundle, sendCalls, sendAttachmentCalls };
}

test("QA Major 6: portal=true/bridge=false — the fallback send carries every disabled attachment URL as link lines, and the aggregate reports 'delivered' rather than the misleading partial-delivery sentence", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls, sendAttachmentCalls } = makeMediaDisabledDeps();

  const outcome = await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-media-disabled-1", message: "here you go", attachments: ["https://x/a.pdf", "https://x/b.pdf"] }), deps)
  );

  // Text part + the ONE fallback text send — two sendWhatsapp calls total,
  // zero successful sendAttachment calls (every one was refused).
  assert.equal(sendCalls.length, 2);
  assert.equal(sendCalls[0].text, "here you go", "the row's own text part is unchanged — no URLs folded into it");
  assert.equal(sendCalls[1].text, "https://x/a.pdf\nhttps://x/b.pdf", "the fallback carries every disabled URL as its own link line, same shape buildOutboundText always used");
  assert.notEqual(sendCalls[1].idempotencyKey, sendCalls[0].idempotencyKey, "the fallback must use its OWN derived key, never collide with the text part's");
  assert.equal(sendAttachmentCalls.length, 2, "the bridge's sendAttachment endpoint is still called once per attachment — the fallback doesn't skip the attempt, it recovers from its failure");

  assert.deepEqual(outcome, { kind: "accepted" });
});

test("QA Major 6: the fallback idempotency key is deterministic and derived from the ghlMessageId — a webhook redelivery would replay it, not double-send", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls } = makeMediaDisabledDeps();

  await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-media-disabled-key", message: "hi", attachments: ["https://x/a.pdf"] }), deps)
  );

  const fallbackCall = sendCalls.find((c) => c.text === "https://x/a.pdf");
  assert.ok(fallbackCall);
  assert.equal(fallbackCall!.idempotencyKey, deriveMediaFallbackIdempotencyKey("msg-media-disabled-key"));
});

test("QA Major 6: an attachments-only message (no text part) with the bridge's media switch off — the fallback IS the only content sent, and it is not lost", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls, sendAttachmentCalls } = makeMediaDisabledDeps();

  const outcome = await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-media-disabled-no-text", message: "", attachments: ["https://x/a.pdf", "https://x/b.pdf"] }), deps)
  );

  assert.equal(sendCalls.length, 1, "no text part existed to send — only the fallback");
  assert.equal(sendCalls[0].text, "https://x/a.pdf\nhttps://x/b.pdf");
  assert.equal(sendAttachmentCalls.length, 2);
  assert.deepEqual(outcome, { kind: "accepted" }, "content was fully recovered via the fallback — must not report as refused/failed");
});

test("QA Major 6: a genuine attachment refusal (NOT media_outbound_disabled, e.g. invalid_attachment) is never folded into the fallback — only the config-mismatch reason triggers it", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls } = makeDeps({
    sendAttachment: async () => ({ ok: false, code: "invalid_attachment", message: "bad url" }),
  });

  await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-genuinely-bad-attachment", message: "hi", attachments: ["https://x/a.pdf"] }), deps)
  );

  // Only the text part sent — no fallback attempt for a genuinely-bad
  // attachment (that content loss is correct: the URL itself is the problem).
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].text, "hi");
});

test("QA Major 6: if the fallback send itself fails (attachments-only message, so the ONE sendWhatsapp call IS the fallback), the original media_outbound_disabled outcome is left untouched — no worse than before the fix", async () => {
  const { repo } = createFakeRepo([makeAccount()]);
  const { deps, statusCalls, sendCalls } = makeMediaDisabledDeps({
    sendWhatsapp: async () => ({ ok: false, code: "unreachable", message: "bridge unreachable" }),
  });

  const outcome = await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-media-disabled-fallback-fails", message: "", attachments: ["https://x/a.pdf"] }), deps)
  );

  assert.equal(sendCalls.length, 1, "no separate text part existed (attachments-only) — the one sendWhatsapp call is the fallback attempt itself");
  // The attachment is terminally refused AND the fallback failed to send —
  // nothing was delivered, so the ORIGINAL shared media-disabled reason is
  // reported (the vacuous text stand-in never counts toward 'anySent',
  // QA Minor 7) rather than the generic partial-delivery sentence.
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.mediaDisabledOnBridge });
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "failed");
});

// ---------------------------------------------------------------------------
// 8d. Status-drain part aggregation (plan §5.7, decision O4) — delivered
// only once EVERY part resolves 'sent'; a partial failure reports 'failed'
// with the fixed partial-delivery reason; still-pending parts leave the row
// unresolved.
// ---------------------------------------------------------------------------

/** Runs the webhook handler with the flag on to seed a genuine multipart row + its attachment rows, returning everything a drain-aggregation test needs. */
async function seedMultipartRow(
  overrides: { message?: string; attachments?: string[]; messageId?: string } = {}
): Promise<{ repoBundle: ReturnType<typeof createFakeRepo>; row: GhlOutboundMessage; parts: GhlOutboundAttachment[] }> {
  const repoBundle = createFakeRepo([makeAccount()]);
  const { deps } = makeDeps();
  const messageId = overrides.messageId ?? "msg-multipart-seed";
  const message = overrides.message ?? "here you go";
  const attachmentUrls = overrides.attachments ?? ["https://x/a.pdf", "https://x/b.pdf"];
  const outcome = await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(repoBundle.repo, samplePayloadFor({ messageId, message, attachments: attachmentUrls }), deps)
  );
  assert.deepEqual(outcome, { kind: "accepted" }, "seedMultipartRow fixture bug — expected every part to dispatch cleanly");
  const row = [...repoBundle.rows.values()].find((r) => r.ghlMessageId === messageId)!;
  const parts = [...repoBundle.attachments.values()].filter((a) => a.outboundMessageId === row.id).sort((a, b) => a.seq - b.seq);
  return { repoBundle, row, parts };
}

test("drainMultipartRow: every part 'sent' in the bridge ledger -> delivered PUT exactly once, ONLY once every part has resolved", async () => {
  const { repoBundle, row, parts } = await seedMultipartRow({ messageId: "msg-mp-all-sent", attachments: ["https://x/a.pdf", "https://x/b.pdf"] });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  // Only ONE of the two attachments resolved so far — the row must stay unresolved.
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[0].idempotencyKey}`, { status: "sent", error: null });

  const { deps, statusCalls } = makeDeps();
  const partial = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(partial.unresolved, 1, "the second attachment hasn't resolved bridge-side yet — must not report anything");
  assert.equal(statusCalls.length, 0);

  // Now the last part resolves too.
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[1].idempotencyKey}`, { status: "sent", error: null });
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.delivered, 1);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "delivered");
});

test("drainMultipartRow: one attachment 'failed' while the text and the other attachment 'sent' -> failed PUT with the fixed partial-delivery reason", async () => {
  const { repoBundle, row, parts } = await seedMultipartRow({ messageId: "msg-mp-partial", attachments: ["https://x/a.pdf", "https://x/b.pdf"] });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[0].idempotencyKey}`, { status: "sent", error: null });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[1].idempotencyKey}`, {
    status: "failed",
    error: "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key",
  });

  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(result.delivered, 0);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.partialDelivery, "must use the FIXED partial-delivery sentence, never an invented status string or the raw per-part reason");
});

test("drainMultipartRow: EVERY part fails with the SAME reason (e.g. the whole number has no WhatsApp account) -> that single shared reason is forwarded, not the generic partial-delivery sentence", async () => {
  const { repoBundle, row, parts } = await seedMultipartRow({ messageId: "msg-mp-all-not-on-whatsapp", attachments: ["https://x/a.pdf"] });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[0].idempotencyKey}`, { status: "not_on_whatsapp", error: null });

  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.notOnWhatsapp, "nothing sent, one shared reason across every part -> forward that exact reason, not the partial-delivery sentence");
});

test("drainMultipartRow: an attachments-only message (no text part) reports delivered once every attachment is sent — the vacuous text part never blocks or fails it", async () => {
  const { repoBundle, row, parts } = await seedMultipartRow({ messageId: "msg-mp-no-text", message: "", attachments: ["https://x/a.pdf"] });
  assert.equal(row.sendState, "refused", "internal bookkeeping only — see resolveTextPartOutcome's JSDoc; must NOT have been reported to GHL");
  const { statusCalls: inlineStatusCalls } = makeDeps();
  assert.equal(inlineStatusCalls.length, 0);

  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[0].idempotencyKey}`, { status: "sent", error: null });
  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.delivered, 1);
  assert.equal(statusCalls[0].status, "delivered");
});

test("QA Minor 7: an attachments-only message whose SOLE attachment fails reports the real shared reason, not the misleading partial-delivery sentence (the vacuous text stand-in must never count toward anySent)", async () => {
  const { repoBundle, row, parts } = await seedMultipartRow({ messageId: "msg-mp-vacuous-not-anysent", message: "", attachments: ["https://x/a.pdf"] });
  assert.equal(row.sendState, "refused", "vacuous internal bookkeeping — never reported to GHL directly");

  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[0].idempotencyKey}`, {
    status: "failed",
    error: "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key",
  });

  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "failed");
  // Before the fix: the vacuous text part's trivial `sent: true` counted
  // toward `anySent`, so this reported GHL_PROVIDER_REASONS.partialDelivery
  // ("message partially delivered...") even though ZERO real content ever
  // sent. After the fix: the vacuous part is excluded, so the real shared
  // reason (the ledger's own fixed failure string) is forwarded.
  assert.equal(
    statusCalls[0].errorMessage,
    "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key",
    "must be the real shared reason, not GHL_PROVIDER_REASONS.partialDelivery"
  );
  assert.notEqual(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.partialDelivery);
});

test("drainMultipartRow: a transiently-failing attachment part stays pending_send and is retried by the drain with the SAME url and idempotency key", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const messageId = "msg-mp-attachment-transient";
  const outcome = await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(
      repoBundle.repo,
      samplePayloadFor({ messageId, message: "resend the second one", attachments: ["https://x/a.pdf", "https://x/b.pdf"] }),
      makeDeps({
        sendAttachment: async (input) => {
          if (input.attachment.url === "https://x/b.pdf") return { ok: false, code: "unreachable", message: "bridge unreachable" };
          return makeSendResult({ idempotencyKey: input.idempotencyKey, toPhone: input.to });
        },
      }).deps
    )
  );
  assert.deepEqual(outcome, { kind: "pending_retry" }, "at least one part is transiently pending -> pending_retry, not accepted");

  const row = [...repoBundle.rows.values()].find((r) => r.ghlMessageId === messageId)!;
  const parts = [...repoBundle.attachments.values()].filter((a) => a.outboundMessageId === row.id).sort((a, b) => a.seq - b.seq);
  assert.equal(parts[0].sendState, "accepted");
  assert.equal(parts[1].sendState, "pending_send", "the transiently-failed part stays pending_send, ready for the drain to retry");
  const secondUrlKey = parts[1].idempotencyKey;

  // Resolve the first part in the bridge ledger so only the retried second
  // part is what's still outstanding.
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[0].idempotencyKey}`, { status: "sent", error: null });

  const { deps, sendAttachmentCalls, statusCalls } = makeDeps(); // healthy bridge this pass.
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.retried, 1);
  assert.equal(sendAttachmentCalls.length, 1);
  assert.equal(sendAttachmentCalls[0].idempotencyKey, secondUrlKey, "the SAME derived key, never a new one");
  assert.equal(sendAttachmentCalls[0].attachment.url, "https://x/b.pdf", "the SAME url, retained via pending_url until it leaves pending_send");
  // The retry only just got accepted this pass — not yet resolved bridge-side
  // (the bridge ledger has no entry for it yet), so the row as a WHOLE stays
  // unresolved this pass too, exactly like a fresh accept would.
  assert.equal(result.unresolved, 1, "the just-retried part isn't confirmed sent yet — the row must not be reported this pass");
  assert.equal(statusCalls.length, 0);
});

test("retry gate: a pending_send attachment part of a multipart row for a paused account is not sent, marked refused and reported failed", async () => {
  const seeded = createFakeRepo([makeAccount()]);
  const messageId = "msg-mp-attachment-gate";
  await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(
      seeded.repo,
      samplePayloadFor({ messageId, message: "text part", attachments: ["https://x/a.pdf"] }),
      makeDeps({
        sendAttachment: async () => ({ ok: false, code: "unreachable", message: "bridge unreachable" }),
      }).deps
    )
  );
  const row = [...seeded.rows.values()].find((r) => r.ghlMessageId === messageId)!;
  const part = [...seeded.attachments.values()].find((a) => a.outboundMessageId === row.id)!;
  assert.equal(part.sendState, "pending_send");
  // The text part already went out; billing then lapsed.
  seeded.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });
  const paused = createFakeRepo([makeAccount()], { status: "cancelled" });
  for (const [k, v] of seeded.rows) paused.rows.set(k, v);
  for (const [k, v] of seeded.attachments) paused.attachments.set(k, v);
  for (const [k, v] of seeded.bridgeLedger) paused.bridgeLedger.set(k, v);

  const { deps, sendAttachmentCalls, statusCalls } = makeDeps();
  const result = await withMediaOutboundEnabled(() => drainGhlOutboundStatuses(paused.repo, deps));
  assert.equal(sendAttachmentCalls.length, 0);
  assert.equal(part.sendState, "refused");
  assert.equal(result.failed, 1);
  assert.equal(statusCalls[0].status, "failed");
  assert.match(statusCalls[0].errorMessage ?? "", /partially delivered/, "text part already sent, attachment refused -> the partial-delivery failure");
  assert.match(part.refusalReason ?? "", /subscription inactive/);
});

// ---------------------------------------------------------------------------
// QA Major 5 — an attachment part's `pending_send` retries must be bounded
// by its OWN `send_attempts` (migration 0074, WRITTEN NOT APPLIED), exactly
// like the text part's `PENDING_SEND_MAX_ATTEMPTS` bound, so a permanently-
// unreachable bridge can't retry a stuck part forever and starve the drain.
// ---------------------------------------------------------------------------

/**
 * seedMultipartRow's own initial dispatch uses a HEALTHY bridge by default,
 * so a freshly-seeded attachment part is already `sendState: 'accepted'`
 * (the send succeeded at accept time), not `'pending_send'`. These tests are
 * about the DRAIN's retry-exhaustion behaviour, which only applies to a part
 * genuinely sitting `pending_send` — so reset the part back to that state by
 * direct fixture mutation, the same pattern `seedAcceptedRow` already uses
 * for the text-row equivalent tests above. An attachments-only message
 * (empty `message`) is used throughout so the row's TEXT part resolves
 * vacuously (see `resolveTextPartOutcome`'s JSDoc) without needing its own
 * bridge-ledger entry — isolating these assertions to the attachment part.
 */
function resetToPendingSend(part: GhlOutboundAttachment, url: string, attempts: number): void {
  part.sendState = "pending_send";
  part.pendingUrl = url;
  part.sendAttempts = attempts;
  part.refusalReason = null;
}

test("resolveAttachmentPartOutcome: an attachment part already at PENDING_SEND_MAX_ATTEMPTS (5) with NO bridge ledger entry gives up — refuses with the fixed exhaustion reason, never calls the bridge again", async () => {
  const { repoBundle, parts } = await seedMultipartRow({ messageId: "msg-mp-attachment-exhausted", message: "", attachments: ["https://x/a.pdf"] });
  const part = parts[0];
  resetToPendingSend(part, "https://x/a.pdf", 5); // already at the bound.

  const { deps, sendAttachmentCalls, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);

  assert.equal(sendAttachmentCalls.length, 0, "must not call the bridge again once the bound is reached");
  assert.equal(result.failed, 1);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "failed");
  const persistedPart = repoBundle.attachments.get(part.id)!;
  assert.equal(persistedPart.sendState, "refused");
  assert.equal(persistedPart.refusalReason, GHL_PROVIDER_REASONS.bridgeUnreachableExhausted, "the fixed exhaustion reason, never a raw/invented string");
});

test("resolveAttachmentPartOutcome: an attachment part at PENDING_SEND_MAX_ATTEMPTS whose bridge ledger entry HAS resolved (e.g. 'sent') is rescued via the ledger, not blindly exhaustion-failed (mirrors finding 4 for the text part)", async () => {
  const { repoBundle, parts } = await seedMultipartRow({ messageId: "msg-mp-attachment-exhausted-rescued", message: "", attachments: ["https://x/a.pdf"] });
  const part = parts[0];
  resetToPendingSend(part, "https://x/a.pdf", 5);
  // The send DID reach the bridge (every response back to us just timed
  // out) — the ledger says so.
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${part.idempotencyKey}`, { status: "sent", error: null });

  const { deps, sendAttachmentCalls, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);

  assert.equal(sendAttachmentCalls.length, 0, "the ledger already has the answer — no need to call the bridge again");
  assert.equal(result.delivered, 1, "resolved via the ledger, not misclassified as a blind exhaustion failure");
  assert.equal(statusCalls[0].status, "delivered");
  assert.equal(repoBundle.attachments.get(part.id)!.sendState, "accepted", "flipped to accepted via the ledger rescue, exactly like retryTextPart's own rescue path");
});

test("resolveAttachmentPartOutcome: an attachment part's sendAttempts increments on every transient failure and is BOUNDED — never retries forever (the drain starvation this fix closes)", async () => {
  const { repoBundle, parts } = await seedMultipartRow({ messageId: "msg-mp-attachment-bounded-retry", message: "", attachments: ["https://x/a.pdf"] });
  const part = parts[0];
  resetToPendingSend(part, "https://x/a.pdf", 0);

  const { deps, sendAttachmentCalls } = makeDeps({
    sendAttachment: async () => ({ ok: false, code: "unreachable", message: "bridge unreachable" }),
  });

  // Drive the drain across enough passes to exceed the bound — a BEFORE-fix
  // implementation would call the bridge once per pass forever; the fix
  // must stop calling it once sendAttempts reaches PENDING_SEND_MAX_ATTEMPTS.
  for (let i = 0; i < 8; i++) {
    await drainGhlOutboundStatuses(repoBundle.repo, deps);
  }

  const persistedPart = repoBundle.attachments.get(part.id)!;
  assert.ok(persistedPart.sendAttempts <= 5, `sendAttempts must be bounded at PENDING_SEND_MAX_ATTEMPTS (5), got ${persistedPart.sendAttempts}`);
  assert.equal(persistedPart.sendState, "refused", "eventually gives up rather than sitting pending_send forever");
  assert.equal(persistedPart.refusalReason, GHL_PROVIDER_REASONS.bridgeUnreachableExhausted);
  // At most 5 real bridge calls (one per pass until the bound is hit), never
  // one per pass across all 8 — that unbounded growth IS the bug this fix
  // closes.
  assert.ok(sendAttachmentCalls.length <= 5, `expected bridge calls bounded at 5, got ${sendAttachmentCalls.length}`);
});

// ---------------------------------------------------------------------------
// 8e. QA Blocker 1 — a transient failure reading ghl_outbound_attachments
// must never let a `hadAttachments` row fall through to the legacy
// single-part branches. Worst case: an attachments-only row sits `refused`
// with the internal TEXT_PART_NOT_APPLICABLE sentinel as its refusalReason
// (see resolveTextPartOutcome's JSDoc) — that sentinel must never reach GHL
// as a reported failure, and the row must never be terminally failed while
// its attachments may still be sending.
// ---------------------------------------------------------------------------

test("drainGhlOutboundStatuses: a listing failure mid-flight leaves an attachments-only (TEXT_PART_NOT_APPLICABLE) row unreported rather than terminally failed", async () => {
  const { repoBundle, row } = await seedMultipartRow({ messageId: "msg-mp-listing-fail-no-text", message: "", attachments: ["https://x/a.pdf"] });
  assert.equal(row.sendState, "refused", "internal bookkeeping only — see resolveTextPartOutcome's JSDoc; must NOT have been reported to GHL");

  // Simulate the drain's listGhlOutboundAttachmentsForMessages read failing
  // mid-flight (e.g. a transient Supabase blip) on this pass.
  repoBundle.repo.listGhlOutboundAttachmentsForMessages = async () => {
    throw new Error("simulated transient listing failure");
  };

  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);

  assert.equal(statusCalls.length, 0, "GHL must never be told anything this pass — least of all the internal sentinel string as a failure reason");
  assert.equal(result.failed, 0);
  assert.equal(result.delivered, 0);
  assert.equal(result.unresolved, 1, "the row is left unresolved so a later, healthy pass can resolve it correctly");
  const persisted = repoBundle.rows.get(row.id)!;
  assert.equal(persisted.reportedStatus, null, "reported_status must stay unstamped — a stamped row would be excluded from every future pass and the true outcome would never be reported");
});

test("drainGhlOutboundStatuses: a listing failure mid-flight leaves a genuine multipart row (real text + attachments) unresolved rather than resolved via the legacy single-part branches", async () => {
  const { repoBundle, row } = await seedMultipartRow({
    messageId: "msg-mp-listing-fail-with-text",
    message: "here you go",
    attachments: ["https://x/a.pdf", "https://x/b.pdf"],
  });
  // The TEXT part alone has already resolved 'sent' in the bridge ledger —
  // if this row wrongly fell through to the legacy 'accepted' branch
  // (`drainAcceptedRow`), it would report 'delivered' on the strength of the
  // text part alone, ignoring both attachments entirely.
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "sent", error: null });

  repoBundle.repo.listGhlOutboundAttachmentsForMessages = async () => {
    throw new Error("simulated transient listing failure");
  };

  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);

  assert.equal(statusCalls.length, 0, "must not report 'delivered' on the text part alone while the attachments' fate is unknown this pass");
  assert.equal(result.unresolved, 1);
  const persisted = repoBundle.rows.get(row.id)!;
  assert.equal(persisted.reportedStatus, null);
});

// ---------------------------------------------------------------------------
// 9. Bulk-install exchange (4 Aug 2026 fix) — `src/lib/ghl.ts`'s
// `GhlExchangeResult` / `getGhlLocationTokenFromAgency` /
// `listGhlInstalledLocations` / `parseGhlInstalledLocations` / `ghlAppId`.
// See that file's own header and `GhlExchangeResult`'s own JSDoc for the
// full production-log diagnosis these tests pin: a Company-scoped exchange
// (agency "bulk install" marketplace setting) must be recognised as a
// NORMAL outcome, never collapsed into the same failure path as a genuinely
// broken exchange.
// ---------------------------------------------------------------------------

// `exchangeGhlCode` reads GHL_CLIENT_ID/SECRET/WEBHOOK_PUBLIC_KEY via
// `ghlEnv()` (all-or-nothing — see that function's own JSDoc) before ever
// calling fetch; no earlier test in this file exercises an env-gated
// export, so setting these here is safe — node:test runs each test FILE in
// its own process, so this can never leak into another file's run. Client
// id deliberately shaped `<appId>-<suffix>` (no dash inside the appId
// part), matching `appVersionIdFromClientId`'s own documented contract, so
// `ghlAppId()` below has something realistic to split.
process.env.GHL_CLIENT_ID = "app1234567890-suffixabc";
process.env.GHL_CLIENT_SECRET = "test-client-secret";
process.env.GHL_WEBHOOK_PUBLIC_KEY = "test-webhook-public-key-pem";

/** The exact key list from the production log this fix was diagnosed against (see `GhlExchangeResult`'s own JSDoc) — deliberately not a hand-trimmed subset. */
const COMPANY_SCOPED_EXCHANGE_BODY = {
  access_token: "agency-access-token-1",
  token_type: "Bearer",
  expires_in: 86400,
  refresh_token: "agency-refresh-token-1",
  scope: "conversations/message.write conversations.readonly",
  refreshTokenId: "rt-id-1",
  userType: "Company",
  companyId: "company-1",
  isBulkInstallation: true,
  userId: "user-1",
  installToFutureLocations: true,
  approveAllLocations: true,
};

const LOCATION_SCOPED_EXCHANGE_BODY = {
  access_token: "location-access-token-1",
  token_type: "Bearer",
  expires_in: 86400,
  refresh_token: "location-refresh-token-1",
  scope: "conversations/message.write",
  userType: "Location",
  locationId: "loc-1",
  companyId: "company-1",
  userId: "user-1",
};

test("exchangeGhlCode: a Company-scoped exchange response (production log's exact key list) parses as kind 'company', never as a failure", async () => {
  const result = await withStubbedFetch(
    async () => new Response(JSON.stringify(COMPANY_SCOPED_EXCHANGE_BODY), { status: 200 }),
    () => exchangeGhlCode("auth-code-1")
  );
  assert.ok(result, "a Company-scoped exchange must not be treated as a failure");
  assert.equal(result?.kind, "company");
  if (result?.kind === "company") {
    assert.equal(result.companyId, "company-1");
    assert.equal(result.accessToken, "agency-access-token-1");
    assert.equal(result.refreshToken, "agency-refresh-token-1");
    assert.equal(result.isBulkInstall, true, "isBulkInstallation: true on the raw body must surface as isBulkInstall");
  }
});

test("exchangeGhlCode: a Location-scoped exchange response still parses as kind 'location', GhlTokens unchanged", async () => {
  const result = await withStubbedFetch(
    async () => new Response(JSON.stringify(LOCATION_SCOPED_EXCHANGE_BODY), { status: 200 }),
    () => exchangeGhlCode("auth-code-2")
  );
  assert.ok(result);
  assert.equal(result?.kind, "location");
  if (result?.kind === "location") {
    assert.equal(result.tokens.locationId, "loc-1");
    assert.equal(result.tokens.accessToken, "location-access-token-1");
    assert.equal(result.tokens.refreshToken, "location-refresh-token-1");
    assert.equal(result.tokens.companyId, "company-1");
  }
});

test("exchangeGhlCode: a non-2xx token endpoint response returns null, same as before this fix", async () => {
  const result = await withStubbedFetch(
    async () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }),
    () => exchangeGhlCode("bad-code")
  );
  assert.equal(result, null);
});

test("ghlAppId: derives the app id from GHL_CLIENT_ID's <appId>-<suffix> shape, the same value listGhlInstalledLocations needs as its appId param", () => {
  assert.equal(ghlAppId(), "app1234567890");
});

// ---------------------------------------------------------------------------
// 9a. getGhlLocationTokenFromAgency — POST /oauth/locationToken
// ---------------------------------------------------------------------------

test("getGhlLocationTokenFromAgency: a normal Location-scoped response yields a usable GhlTokens", async () => {
  const body = {
    access_token: "location-access-token-2",
    token_type: "Bearer",
    expires_in: 86400,
    refresh_token: "location-refresh-token-2",
    scope: "conversations/message.write",
    userType: "Location",
    locationId: "loc-2",
    companyId: "company-1",
    userId: "user-2",
  };
  const tokens = await withStubbedFetch(
    async () => new Response(JSON.stringify(body), { status: 200 }),
    () => getGhlLocationTokenFromAgency("agency-token", "company-1", "loc-2")
  );
  assert.ok(tokens);
  assert.equal(tokens?.locationId, "loc-2");
  assert.equal(tokens?.accessToken, "location-access-token-2");
  assert.equal(tokens?.refreshToken, "location-refresh-token-2");
  assert.equal(tokens?.companyId, "company-1");
});

test("getGhlLocationTokenFromAgency: a response missing locationId returns null", async () => {
  const body = { access_token: "x", refresh_token: "y", expires_in: 3600, companyId: "company-1" }; // no locationId anywhere in the body
  const tokens = await withStubbedFetch(
    async () => new Response(JSON.stringify(body), { status: 200 }),
    () => getGhlLocationTokenFromAgency("agency-token", "company-1", "loc-3")
  );
  assert.equal(tokens, null);
});

test("getGhlLocationTokenFromAgency: a non-2xx response returns null, never throws", async () => {
  const tokens = await withStubbedFetch(
    async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
    () => getGhlLocationTokenFromAgency("agency-token", "company-1", "loc-4")
  );
  assert.equal(tokens, null);
});

test("getGhlLocationTokenFromAgency: a thrown network error returns null, never throws", async () => {
  await assert.doesNotReject(async () => {
    const tokens = await withStubbedFetch(
      async () => {
        throw new TypeError("fetch failed");
      },
      () => getGhlLocationTokenFromAgency("agency-token", "company-1", "loc-5")
    );
    assert.equal(tokens, null);
  });
});

// ---------------------------------------------------------------------------
// 9b. parseGhlInstalledLocations — pure parse for GET /oauth/installedLocations
// ---------------------------------------------------------------------------

test("parseGhlInstalledLocations: a { locations: [...] } envelope parses each entry", () => {
  const result = parseGhlInstalledLocations({
    locations: [
      { _id: "loc-1", name: "Loc One" },
      { _id: "loc-2", name: "Loc Two" },
    ],
  });
  assert.deepEqual(result, [
    { locationId: "loc-1", name: "Loc One" },
    { locationId: "loc-2", name: "Loc Two" },
  ]);
});

test("parseGhlInstalledLocations: a bare array at the response root parses identically to the { locations: [...] } envelope", () => {
  const result = parseGhlInstalledLocations([{ _id: "loc-1", name: "Loc One" }]);
  assert.deepEqual(result, [{ locationId: "loc-1", name: "Loc One" }]);
});

test("parseGhlInstalledLocations: accepts 'id' as well as '_id'", () => {
  const result = parseGhlInstalledLocations({ locations: [{ id: "loc-9", name: "Nine" }] });
  assert.deepEqual(result, [{ locationId: "loc-9", name: "Nine" }]);
});

test("parseGhlInstalledLocations: isInstalled: false filters the entry out", () => {
  const result = parseGhlInstalledLocations({
    locations: [
      { _id: "loc-1", isInstalled: true },
      { _id: "loc-2", isInstalled: false },
    ],
  });
  assert.deepEqual(result, [{ locationId: "loc-1", name: null }]);
});

test("parseGhlInstalledLocations: isInstalled absent is treated as installed, not excluded (this thinner-documented endpoint might simply not send it)", () => {
  const result = parseGhlInstalledLocations({ locations: [{ _id: "loc-1" }] });
  assert.deepEqual(result, [{ locationId: "loc-1", name: null }]);
});

test("parseGhlInstalledLocations: a malformed individual entry is skipped, not fatal to the whole batch", () => {
  const result = parseGhlInstalledLocations({
    locations: [{ _id: "loc-1" }, "garbage-not-an-object", { name: "no id anywhere on this one" }, null],
  });
  assert.deepEqual(result, [{ locationId: "loc-1", name: null }]);
});

test("parseGhlInstalledLocations: an unrecognised top-level shape returns null, never throws", () => {
  for (const garbage of ["a string", 42, null, {}, { foo: "bar" }]) {
    assert.doesNotThrow(() => parseGhlInstalledLocations(garbage));
    assert.equal(parseGhlInstalledLocations(garbage), null, JSON.stringify(garbage));
  }
});

// ---------------------------------------------------------------------------
// 9c. listGhlInstalledLocations — GET /oauth/installedLocations network wrapper
// ---------------------------------------------------------------------------

test("listGhlInstalledLocations: a successful fetch is parsed via parseGhlInstalledLocations", async () => {
  const result = await withStubbedFetch(
    async () => new Response(JSON.stringify({ locations: [{ _id: "loc-1", name: "One" }] }), { status: 200 }),
    () => listGhlInstalledLocations("agency-token", "company-1", "app-1")
  );
  assert.deepEqual(result, [{ locationId: "loc-1", name: "One" }]);
});

test("listGhlInstalledLocations: a non-2xx response returns null", async () => {
  const result = await withStubbedFetch(
    async () => new Response("", { status: 500 }),
    () => listGhlInstalledLocations("agency-token", "company-1", "app-1")
  );
  assert.equal(result, null);
});

test("listGhlInstalledLocations: an unreachable endpoint returns null, never throws", async () => {
  await assert.doesNotReject(async () => {
    const result = await withStubbedFetch(
      async () => {
        throw new TypeError("fetch failed");
      },
      () => listGhlInstalledLocations("agency-token", "company-1", "app-1")
    );
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Multiple numbers (Task 3, review fix 1) — the drain's retry sites pick the
// same refusal string as the webhook: a row sent from a NON-default number
// (row.tenantId !== account.tenantId) that the bridge refuses with
// session_not_connected reports the sticky string; a default-number row
// keeps today's string.
// ---------------------------------------------------------------------------

const notConnectedSendFn: GhlProviderDeps["sendWhatsapp"] = async () => ({ ok: false, code: "session_not_connected", message: "session status is 'disconnected'" });

test("drainGhlOutboundStatuses: a pending_send row from a NON-default number, retried into session_not_connected -> the sticky string", async () => {
  const repoBundle = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS });
  const row = seedAcceptedRow(repoBundle, { tenantId: SECOND_TENANT_ID, sendState: "pending_send", pendingText: "retry me", sendAttempts: 1 });
  const { deps, statusCalls } = makeDeps({ sendWhatsapp: notConnectedSendFn });

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);

  assert.equal(result.failed, 1);
  assert.equal(repoBundle.rows.get(row.id)!.refusalReason, STICKY_DISCONNECTED_REASON);
  assert.equal(statusCalls[0].errorMessage, STICKY_DISCONNECTED_REASON);
});

test("drainGhlOutboundStatuses: a pending_send row from the DEFAULT number, retried into session_not_connected -> today's string, unchanged", async () => {
  const repoBundle = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS });
  const row = seedAcceptedRow(repoBundle, { tenantId: TENANT_ID, sendState: "pending_send", pendingText: "retry me", sendAttempts: 1 });
  const { deps, statusCalls } = makeDeps({ sendWhatsapp: notConnectedSendFn });

  await drainGhlOutboundStatuses(repoBundle.repo, deps);

  assert.equal(repoBundle.rows.get(row.id)!.refusalReason, GHL_PROVIDER_REASONS.notConnected);
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.notConnected);
});

/** A multipart row whose text AND attachment parts all went transient at webhook time, so both are pending_send for the drain. */
async function seedPendingMultipartRow(sticky: Record<string, string>) {
  const repoBundle = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky });
  const unreachable = async () => ({ ok: false as const, code: "unreachable", message: "WhatsApp bridge unreachable or timed out." });
  const { deps } = makeDeps({ sendWhatsapp: unreachable, sendAttachment: unreachable });
  const outcome = await withMediaOutboundEnabled(() =>
    handleProviderOutboundMessage(repoBundle.repo, samplePayloadFor({ messageId: "msg-mp-pending", message: "docs", attachments: ["https://x/a.pdf"] }), deps)
  );
  assert.deepEqual(outcome, { kind: "pending_retry" }, "fixture bug — expected every part to be left pending_send");
  const row = [...repoBundle.rows.values()][0];
  const part = [...repoBundle.attachments.values()][0];
  return { repoBundle, row, part };
}

test("drainMultipartRow: text and attachment retries from a NON-default number into session_not_connected -> the sticky string on both parts and in the report", async () => {
  const { repoBundle, row, part } = await seedPendingMultipartRow(STICKY_TO_SECOND);
  assert.equal(row.tenantId, SECOND_TENANT_ID);
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: notConnectedSendFn,
    sendAttachment: notConnectedSendFn as GhlProviderDeps["sendAttachment"],
  });

  await withMediaOutboundEnabled(() => drainGhlOutboundStatuses(repoBundle.repo, deps));

  assert.equal(repoBundle.rows.get(row.id)!.refusalReason, STICKY_DISCONNECTED_REASON);
  assert.equal(repoBundle.attachments.get(part.id)!.refusalReason, STICKY_DISCONNECTED_REASON);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].errorMessage, STICKY_DISCONNECTED_REASON);
});

test("drainMultipartRow: the same retries from the DEFAULT number -> today's string, unchanged", async () => {
  const { repoBundle, row, part } = await seedPendingMultipartRow({});
  assert.equal(row.tenantId, TENANT_ID);
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: notConnectedSendFn,
    sendAttachment: notConnectedSendFn as GhlProviderDeps["sendAttachment"],
  });

  await withMediaOutboundEnabled(() => drainGhlOutboundStatuses(repoBundle.repo, deps));

  assert.equal(repoBundle.rows.get(row.id)!.refusalReason, GHL_PROVIDER_REASONS.notConnected);
  assert.equal(repoBundle.attachments.get(part.id)!.refusalReason, GHL_PROVIDER_REASONS.notConnected);
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.notConnected);
});

// ---------------------------------------------------------------------------
// Opt-in WhatsApp groups (Task 8) — `upsertGhlGroupContact` (src/lib/ghl.ts)
// and the bridge client's group calls (src/lib/whatsapp-bridge.ts), against a
// stubbed `fetch` that records each request.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

async function withCapturedFetch<T>(
  respond: (req: CapturedRequest) => Promise<Response>,
  run: () => Promise<T>
): Promise<{ result: T; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    return respond(req);
  }) as typeof fetch;
  try {
    return { result: await run(), requests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("upsertGhlGroupContact: posts name '<group> (WhatsApp group)', the whatsapp-group tag and the placeholder email — never a phone", async () => {
  const { result, requests } = await withCapturedFetch(
    async () => jsonResponse(200, { new: true, contact: { id: "group-contact-1" } }),
    () => upsertGhlGroupContact("token", "loc-1", { name: "  Run Club  ", groupKey: "120363012345678901-0a1b2c3d" })
  );
  assert.deepEqual(result, { ok: true, contactId: "group-contact-1", isNew: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://services.leadconnectorhq.com/contacts/upsert");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.authorization, "Bearer token");
  assert.equal(requests[0].headers.version, "2021-07-28");
  assert.deepEqual(requests[0].body, {
    locationId: "loc-1",
    name: "Run Club (WhatsApp group)",
    email: "group-120363012345678901-0a1b2c3d@groups.pingwren.invalid",
    tags: ["whatsapp-group"],
  });
  assert.equal("phone" in (requests[0].body as Record<string, unknown>), false);
});

test("upsertGhlGroupContact: a long group name is trimmed so the whole contact name is at most 100 characters", async () => {
  const longName = "😀".repeat(150);
  const { requests } = await withCapturedFetch(
    async () => jsonResponse(200, { contact: { id: "c" } }),
    () => upsertGhlGroupContact("token", "loc-1", { name: longName, groupKey: "447700900123-1600000000-0a1b2c3d" })
  );
  const name = (requests[0].body as { name: string }).name;
  assert.equal([...name].length, 100);
  assert.ok(name.endsWith("😀 (WhatsApp group)"), "trimmed by whole characters, never mid-emoji");
});

test("upsertGhlGroupContact: same fixed error strings as upsertGhlContact — never the raw body", async () => {
  const rejected = await withCapturedFetch(
    async () => jsonResponse(422, { message: "secret upstream detail" }),
    () => upsertGhlGroupContact("token", "loc-1", { name: "G", groupKey: "1-0a1b2c3d" })
  );
  assert.deepEqual(rejected.result, { ok: false, kind: "rejected", error: "GHL contact upsert rejected (HTTP 422)" });

  const limited = await withCapturedFetch(async () => jsonResponse(429, {}), () => upsertGhlGroupContact("token", "loc-1", { name: "G", groupKey: "1-0a1b2c3d" }));
  assert.deepEqual(limited.result, { ok: false, kind: "rate_limited", error: "GHL contact upsert rejected (HTTP 429)" });

  const noId = await withCapturedFetch(async () => jsonResponse(200, { contact: {} }), () => upsertGhlGroupContact("token", "loc-1", { name: "G", groupKey: "1-0a1b2c3d" }));
  assert.deepEqual(noId.result, { ok: false, kind: "rejected", error: "GHL contact upsert response had no contact id" });

  const thrown = await withCapturedFetch(
    async () => {
      throw new Error("ECONNRESET");
    },
    () => upsertGhlGroupContact("token", "loc-1", { name: "G", groupKey: "1-0a1b2c3d" })
  );
  assert.deepEqual(thrown.result, { ok: false, kind: "unreachable", error: "GHL contact upsert request failed" });
});

test("upsertGhlGroupContact: a groupKey not shaped like ghlGroupContactKey's output is refused without a request", async () => {
  for (const groupKey of ["1203@evil.example", "120363012345678901", "1-0A1B2C3D", "1-0a1b2c3", "-0a1b2c3d"]) {
    const { result, requests } = await withCapturedFetch(
      async () => jsonResponse(200, { contact: { id: "c" } }),
      () => upsertGhlGroupContact("token", "loc-1", { name: "G", groupKey })
    );
    assert.equal(requests.length, 0, groupKey);
    assert.equal(!result.ok && result.kind, "rejected", groupKey);
  }
});

test("ghlGroupContactKey: JID digits with '-' kept, plus 8 hex of sha256(tenantId) — per number, never the raw tenant id", () => {
  const tenantA = "22222222-2222-4222-8222-222222222222";
  const tenantB = "33333333-3333-4333-8333-333333333333";
  const jid = "120363012345678901@g.us";
  const hashA = createHash("sha256").update(tenantA).digest("hex").slice(0, 8);

  const keyA = ghlGroupContactKey(jid, tenantA);
  const keyB = ghlGroupContactKey(jid, tenantB);
  assert.equal(keyA, `120363012345678901-${hashA}`);
  assert.notEqual(keyA, keyB, "the same group on two numbers gets two GHL contacts");
  assert.notEqual(`group-${keyA}@groups.pingwren.invalid`, `group-${keyB}@groups.pingwren.invalid`);
  for (const [key, tenant] of [[keyA, tenantA], [keyB, tenantB]]) {
    assert.ok(!key.includes(tenant), "the raw tenant id never appears in the key");
    assert.ok(!key.includes(tenant.slice(0, 8)), "nor any recognisable piece of it");
  }

  // '-' kept: old-style JIDs that differ only in where the '-' falls stay distinct.
  assert.notEqual(ghlGroupContactKey("12-345@g.us", tenantA), ghlGroupContactKey("123-45@g.us", tenantA));
  assert.equal(ghlGroupContactKey("447700900123-1600000000@g.us", tenantA), `447700900123-1600000000-${hashA}`);
});

const BRIDGE_COACH = "33333333-3333-4333-8333-333333333333";

async function withBridgeEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.WHATSAPP_BRIDGE_URL, secret: process.env.WHATSAPP_BRIDGE_SECRET };
  process.env.WHATSAPP_BRIDGE_URL = "https://bridge.example.test";
  process.env.WHATSAPP_BRIDGE_SECRET = "bridge-secret";
  try {
    return await run();
  } finally {
    if (saved.url === undefined) delete process.env.WHATSAPP_BRIDGE_URL;
    else process.env.WHATSAPP_BRIDGE_URL = saved.url;
    if (saved.secret === undefined) delete process.env.WHATSAPP_BRIDGE_SECRET;
    else process.env.WHATSAPP_BRIDGE_SECRET = saved.secret;
  }
}

test("listWhatsappGroups: GET /sessions/:id/groups -> the groups; malformed entries make the whole body 'internal'", async () => {
  const groups = [{ jid: "120363012345678901@g.us", name: "Run Club", size: 12 }];
  const ok = await withBridgeEnv(() => withCapturedFetch(async () => jsonResponse(200, { ok: true, groups }), () => listWhatsappGroups(BRIDGE_COACH)));
  assert.deepEqual(ok.result, { ok: true, groups });
  assert.equal(ok.requests[0].url, `https://bridge.example.test/sessions/${BRIDGE_COACH}/groups`);
  assert.equal(ok.requests[0].method, "GET");
  assert.equal(ok.requests[0].headers.authorization, "Bearer bridge-secret");

  const malformed = await withBridgeEnv(() =>
    withCapturedFetch(async () => jsonResponse(200, { ok: true, groups: [{ jid: 1 }] }), () => listWhatsappGroups(BRIDGE_COACH))
  );
  assert.equal(malformed.result.ok, false);
  assert.equal(!malformed.result.ok && malformed.result.code, "internal");

  const notConnected = await withBridgeEnv(() =>
    withCapturedFetch(
      async () => jsonResponse(409, { ok: false, error: { code: "session_not_connected", message: "session status is 'disconnected'" } }),
      () => listWhatsappGroups(BRIDGE_COACH)
    )
  );
  assert.equal(!notConnected.result.ok && notConnected.result.code, "session_not_connected");
});

test("listWhatsappGroups / refreshWhatsappGroups: unconfigured -> 'unconfigured' with no request", async () => {
  const saved = { url: process.env.WHATSAPP_BRIDGE_URL, secret: process.env.WHATSAPP_BRIDGE_SECRET };
  delete process.env.WHATSAPP_BRIDGE_URL;
  delete process.env.WHATSAPP_BRIDGE_SECRET;
  try {
    const { result, requests } = await withCapturedFetch(async () => jsonResponse(200, {}), async () => [
      await listWhatsappGroups(BRIDGE_COACH),
      await refreshWhatsappGroups(BRIDGE_COACH),
    ]);
    assert.equal(requests.length, 0);
    for (const r of result) assert.equal(!r.ok && r.code, "unconfigured");
  } finally {
    if (saved.url !== undefined) process.env.WHATSAPP_BRIDGE_URL = saved.url;
    if (saved.secret !== undefined) process.env.WHATSAPP_BRIDGE_SECRET = saved.secret;
  }
});

test("refreshWhatsappGroups: POST /sessions/:id/groups/refresh -> ok; a 502 surfaces the bridge's code", async () => {
  const ok = await withBridgeEnv(() => withCapturedFetch(async () => jsonResponse(200, { ok: true }), () => refreshWhatsappGroups(BRIDGE_COACH)));
  assert.deepEqual(ok.result, { ok: true });
  assert.equal(ok.requests[0].url, `https://bridge.example.test/sessions/${BRIDGE_COACH}/groups/refresh`);
  assert.equal(ok.requests[0].method, "POST");

  const failed = await withBridgeEnv(() =>
    withCapturedFetch(
      async () => jsonResponse(502, { ok: false, error: { code: "groups_refresh_failed", message: "could not reload" } }),
      () => refreshWhatsappGroups(BRIDGE_COACH)
    )
  );
  assert.equal(!failed.result.ok && failed.result.code, "groups_refresh_failed");
});

test("sendWhatsappMessage: a groupJid input sends { groupJid } and no 'to'; a phone input is unchanged", async () => {
  const message = {
    id: "m1",
    idempotencyKey: "key-1",
    toPhone: null,
    groupJid: "120363012345678901@g.us",
    status: "accepted",
    waMessageId: null,
    error: null,
    createdAt: "2026-10-17T00:00:00.000Z",
    sentAt: null,
  };
  const group = await withBridgeEnv(() =>
    withCapturedFetch(
      async () => jsonResponse(202, { ok: true, replay: false, message }),
      () => sendWhatsappMessage({ coachId: BRIDGE_COACH, groupJid: "120363012345678901@g.us", text: "hi all", idempotencyKey: "key-1" })
    )
  );
  assert.deepEqual(group.requests[0].body, { groupJid: "120363012345678901@g.us", text: "hi all", idempotencyKey: "key-1" });
  assert.deepEqual(group.result, { ok: true, replay: false, message });

  const phone = await withBridgeEnv(() =>
    withCapturedFetch(
      async () => jsonResponse(202, { ok: true, replay: false, message: { ...message, toPhone: "+447700900123", groupJid: null } }),
      () => sendWhatsappMessage({ coachId: BRIDGE_COACH, to: "+447700900123", text: "hi", idempotencyKey: "key-2" })
    )
  );
  assert.deepEqual(phone.requests[0].body, { to: "+447700900123", text: "hi", idempotencyKey: "key-2" });
});

test("sendWhatsappAttachment: a groupJid input sends { groupJid, attachment } and no 'to'; a phone input is unchanged", async () => {
  const message = {
    id: "m1",
    idempotencyKey: "att-1",
    toPhone: null,
    groupJid: "120363012345678901@g.us",
    status: "accepted",
    waMessageId: null,
    error: null,
    createdAt: "2026-10-17T00:00:00.000Z",
    sentAt: null,
  };
  const group = await withBridgeEnv(() =>
    withCapturedFetch(
      async () => jsonResponse(202, { ok: true, replay: false, message }),
      () =>
        sendWhatsappAttachment({
          coachId: BRIDGE_COACH,
          groupJid: "120363012345678901@g.us",
          attachment: { url: "https://x/a.pdf" },
          idempotencyKey: "att-1",
        })
    )
  );
  assert.deepEqual(group.requests[0].body, { groupJid: "120363012345678901@g.us", attachment: { url: "https://x/a.pdf" }, idempotencyKey: "att-1" });
  assert.deepEqual(group.result, { ok: true, replay: false, message });

  const phone = await withBridgeEnv(() =>
    withCapturedFetch(
      async () => jsonResponse(202, { ok: true, replay: false, message: { ...message, toPhone: "+447700900123", groupJid: null } }),
      () => sendWhatsappAttachment({ coachId: BRIDGE_COACH, to: "+447700900123", attachment: { url: "https://x/a.pdf" }, idempotencyKey: "att-2" })
    )
  );
  assert.deepEqual(phone.requests[0].body, { to: "+447700900123", attachment: { url: "https://x/a.pdf" }, idempotencyKey: "att-2" });
});

// ---------------------------------------------------------------------------
// Opt-in groups (Task 9) — outbound to a group contact. The group check runs
// FIRST: before sticky/default number routing and before phone
// normalisation. A group contact is sent to its group (`groupJid`) from the
// group's OWN number; a switched-off group is refused with a fixed string.
// ---------------------------------------------------------------------------

const GROUP_JID = "120363012345678901@g.us";
const GROUP_CONTACT = "ghl-group-contact-1";
const GROUP_OFF_REASON = "WhatsApp group sync is turned off for this group";
const GROUP_LEFT_REASON = "This WhatsApp number is no longer in that group";

/** The group lives on the SECOND (non-default) number, while the contact's sticky row points at the default — the group's number must win. */
function groupRepo(enabled = true, left = false) {
  return createFakeRepo([makeAccount()], {
    numbers: TWO_NUMBERS,
    sticky: { [`${LOCATION_ID}:${GROUP_CONTACT}`]: TENANT_ID },
    groups: { [`${LOCATION_ID}:${GROUP_CONTACT}`]: { tenantId: SECOND_TENANT_ID, groupJid: GROUP_JID, enabled, left } },
  });
}

function groupPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // A group contact has no phone — GHL sends whatever it has (often nothing).
  return samplePayloadFor({ contactId: GROUP_CONTACT, phone: "", messageId: "msg-group", message: "hello group", ...overrides });
}

test("groups outbound: an enabled group contact sends to the groupJid from the GROUP's number — not the sticky or default number — and the row carries that tenant", async () => {
  const bundle = groupRepo();
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload(), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0], { coachId: SECOND_TENANT_ID, groupJid: GROUP_JID, text: "hello group", idempotencyKey: "msg-group" });
  assert.equal("to" in sendCalls[0], false, "a group send never carries a phone");
  const row = [...bundle.rows.values()][0];
  assert.equal(row.tenantId, SECOND_TENANT_ID);
  assert.equal(row.toPhone, null);
  assert.equal(row.sendState, "accepted");
});

test("groups outbound: the group lookup runs FIRST — sticky/default routing is never consulted for a group contact", async () => {
  const bundle = groupRepo();
  const { deps } = makeDeps();
  await handleProviderOutboundMessage(bundle.repo, groupPayload(), deps);
  const methods = bundle.calls.map((c) => c.method);
  assert.ok(methods.includes("getWhatsappGroupByContact"));
  assert.ok(!methods.includes("getStickyTenant"), methods.join(", "));
  assert.ok(!methods.includes("listLocationNumbers"), methods.join(", "));
  assert.ok(methods.indexOf("getWhatsappGroupByContact") < methods.indexOf("recordGhlOutboundMessage"));
});

test("groups outbound: a switched-off group refuses with the fixed string — no send, failed reported inline", async () => {
  const bundle = groupRepo(false);
  const { deps, sendCalls, sendAttachmentCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload(), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GROUP_OFF_REASON });
  assert.equal(GHL_PROVIDER_REASONS.groupSyncOff, GROUP_OFF_REASON);
  assert.equal(sendCalls.length, 0);
  assert.equal(sendAttachmentCalls.length, 0);
  const row = [...bundle.rows.values()][0];
  assert.equal(row.sendState, "refused");
  assert.equal(row.refusalReason, GROUP_OFF_REASON);
  assert.equal(row.tenantId, SECOND_TENANT_ID);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GROUP_OFF_REASON);
});

test("groups outbound: a group contact of a number that was removed from the location refuses as turned off — never the phone path, and the row is on a current number", async () => {
  const REMOVED_TENANT_ID = "tenant-removed";
  const bundle = createFakeRepo([makeAccount()], {
    numbers: TWO_NUMBERS,
    // Even an enabled row: a removed number's group must never send.
    groups: { [`${LOCATION_ID}:${GROUP_CONTACT}`]: { tenantId: REMOVED_TENANT_ID, groupJid: GROUP_JID, enabled: true, numberRemoved: true } },
  });
  const { deps, sendCalls, sendAttachmentCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ phone: "+447700900123" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GROUP_OFF_REASON });
  assert.equal(sendCalls.length + sendAttachmentCalls.length, 0);
  const row = [...bundle.rows.values()][0];
  assert.equal(row.refusalReason, GROUP_OFF_REASON);
  assert.equal(row.toPhone, null, "never falls into the phone path");
  assert.equal(row.tenantId, TENANT_ID, "recorded on the location's default number, not the removed one");
  assert.equal(statusCalls[0].errorMessage, GROUP_OFF_REASON);
});

test("groups outbound: a switched-off group refuses even with attachments and the media split on — nothing dispatched, no part rows", async () => {
  await withMediaOutboundEnabled(async () => {
    const bundle = groupRepo(false);
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ attachments: ["https://x/a.pdf"] }), deps);
    assert.deepEqual(outcome, { kind: "refused", reason: GROUP_OFF_REASON });
    assert.equal(sendCalls.length + sendAttachmentCalls.length, 0);
    assert.equal(bundle.attachments.size, 0);
  });
});

test("groups outbound: the bridge refusing with group_not_enabled (switched off mid-flight) is terminal, reported with the group-off string", async () => {
  const bundle = groupRepo();
  const { deps, statusCalls } = makeDeps({
    sendWhatsapp: async () => ({ ok: false, code: "group_not_enabled", message: "'groupJid' is not an enabled WhatsApp group for this session" }),
  });
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload(), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GROUP_OFF_REASON });
  assert.equal(statusCalls[0].errorMessage, GROUP_OFF_REASON);
});

test("groups outbound: not a group contact -> today's path unchanged (phone normalised, sticky routing)", async () => {
  const bundle = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, samplePayloadFor({ messageId: "msg-not-group", phone: "07700 900123" }), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.deepEqual(sendCalls[0], { coachId: SECOND_TENANT_ID, to: "+447700900123", text: "hi there", idempotencyKey: "msg-not-group" });
  assert.ok(bundle.calls.some((c) => c.method === "getStickyTenant"));
});

test("groups outbound (media split): text and every attachment go to the groupJid from the group's number", async () => {
  await withMediaOutboundEnabled(async () => {
    const bundle = groupRepo();
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ attachments: ["https://x/a.pdf", "https://x/b.png"] }), deps);
    assert.deepEqual(outcome, { kind: "accepted" });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].groupJid, GROUP_JID);
    assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
    assert.equal(sendAttachmentCalls.length, 2);
    for (const call of sendAttachmentCalls) {
      assert.equal(call.groupJid, GROUP_JID);
      assert.equal(call.coachId, SECOND_TENANT_ID);
      assert.equal("to" in call, false);
    }
  });
});

test("groups drain: a pending_send group row is retried to the groupJid on the row's own tenant", async () => {
  const bundle = groupRepo();
  const row = seedAcceptedRow(bundle, {
    tenantId: SECOND_TENANT_ID,
    ghlContactId: GROUP_CONTACT,
    toPhone: null,
    sendState: "pending_send",
    pendingText: "hello group",
    idempotencyKey: "idem-group-retry",
  });
  const { deps, sendCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(result.retried, 1);
  assert.deepEqual(sendCalls, [{ coachId: SECOND_TENANT_ID, groupJid: GROUP_JID, text: "hello group", idempotencyKey: "idem-group-retry" }]);
  assert.equal(row.sendState, "accepted");
});

test("groups drain: a pending_send group row whose group was switched off meanwhile is retried (the bridge's replay check may still own it) and its group_not_enabled refusal reports the group-off string", async () => {
  const bundle = groupRepo(false);
  const row = seedAcceptedRow(bundle, {
    tenantId: SECOND_TENANT_ID,
    ghlContactId: GROUP_CONTACT,
    toPhone: null,
    sendState: "pending_send",
    pendingText: "hello group",
  });
  const { deps, sendCalls, statusCalls } = makeDeps({
    sendWhatsapp: async (input) => {
      sendCalls.push(input);
      return { ok: false, code: "group_not_enabled", message: "'groupJid' is not an enabled WhatsApp group for this session" };
    },
  });
  await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].groupJid, GROUP_JID);
  assert.equal(row.refusalReason, GROUP_OFF_REASON);
  assert.equal(statusCalls[0].errorMessage, GROUP_OFF_REASON);
});

test("groups drain: a pending_send row with no phone and no group contact keeps today's defensive give-up (no send)", async () => {
  const bundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(bundle, { toPhone: null, sendState: "pending_send", pendingText: "hi" });
  const { deps, sendCalls } = makeDeps();
  await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(sendCalls.length, 0);
  assert.equal(row.refusalReason, GHL_PROVIDER_REASONS.bridgeUnreachableExhausted);
});

test("groups outbound (media split): the up-front budget check counts a group part as 5 units, like the bridge", async () => {
  await withMediaOutboundEnabled(async () => {
    const bundle = groupRepo();
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps({
      // 9 units left: enough for 2 one-to-one parts, not for 2 group parts (10).
      getSession: async (coachId) => ({
        ok: true,
        session: { coachId, status: "connected", phoneNumber: "+447700900000", qr: null, sentToday: 141, dailyCap: 150, queueLength: 0 },
      }),
    });
    const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ attachments: ["https://x/a.pdf"] }), deps);
    assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.capReached });
    assert.equal(sendCalls.length + sendAttachmentCalls.length, 0);
  });
});

test("groups outbound (media split): the up-front budget check counts the bridge's queued and in-flight UNITS, not queued items", async () => {
  await withMediaOutboundEnabled(async () => {
    const bundle = groupRepo();
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps({
      // One queued group (5 units) plus one group in flight (5): 150 - 135 - 5 - 5 = 5 left,
      // too few for 2 group parts (10). Counting queueLength (1 item) would leave 14.
      getSession: async (coachId) => ({
        ok: true,
        session: { coachId, status: "connected", phoneNumber: "+447700900000", qr: null, sentToday: 135, dailyCap: 150, queueLength: 1, queuedUnits: 5, inFlightUnits: 5 },
      }),
    });
    const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ attachments: ["https://x/a.pdf"] }), deps);
    assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.capReached });
    assert.equal(sendCalls.length + sendAttachmentCalls.length, 0);
  });
});

test("groups outbound (media split): a bridge build without unit fields falls back to queueLength", async () => {
  await withMediaOutboundEnabled(async () => {
    const bundle = groupRepo();
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps({
      // 150 - 139 - 2 queued items = 9 left, too few for 2 group parts (10).
      getSession: async (coachId) => ({
        ok: true,
        session: { coachId, status: "connected", phoneNumber: "+447700900000", qr: null, sentToday: 139, dailyCap: 150, queueLength: 2 },
      }),
    });
    const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ attachments: ["https://x/a.pdf"] }), deps);
    assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.capReached });
    assert.equal(sendCalls.length + sendAttachmentCalls.length, 0);
  });
});

test("groups drain: a group send that failed with 'no longer in that group' marks the group left on its number, and reports the bridge's string", async () => {
  const bundle = groupRepo();
  const row = seedAcceptedRow(bundle, { tenantId: SECOND_TENANT_ID, ghlContactId: GROUP_CONTACT, toPhone: null, idempotencyKey: "idem-left" });
  bundle.bridgeLedger.set(`${SECOND_TENANT_ID}:idem-left`, { status: "failed", error: GROUP_LEFT_REASON });
  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.deepEqual(bundle.groupsLeft, [{ tenantId: SECOND_TENANT_ID, groupJid: GROUP_JID }]);
  assert.equal(statusCalls[0].errorMessage, GROUP_LEFT_REASON);
  assert.equal(row.reportedStatus, "failed");
});

test("groups drain: any OTHER failure never marks a group left", async () => {
  const bundle = groupRepo();
  seedAcceptedRow(bundle, { tenantId: SECOND_TENANT_ID, ghlContactId: GROUP_CONTACT, toPhone: null, idempotencyKey: "idem-other" });
  bundle.bridgeLedger.set(`${SECOND_TENANT_ID}:idem-other`, { status: "failed", error: "WhatsApp delivery failed" });
  const { deps } = makeDeps();
  await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.deepEqual(bundle.groupsLeft, []);
});

test("groups drain: marking the group left is best effort — a repo failure there never stops the report", async (t) => {
  t.mock.method(console, "error", () => {});
  const bundle = groupRepo();
  bundle.repo.markWhatsappGroupLeft = async () => {
    throw new Error("db down");
  };
  const row = seedAcceptedRow(bundle, { tenantId: SECOND_TENANT_ID, ghlContactId: GROUP_CONTACT, toPhone: null, idempotencyKey: "idem-left-2" });
  bundle.bridgeLedger.set(`${SECOND_TENANT_ID}:idem-left-2`, { status: "failed", error: GROUP_LEFT_REASON });
  const { deps, statusCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(statusCalls[0].errorMessage, GROUP_LEFT_REASON);
  assert.equal(row.reportedStatus, "failed");
});

test("groups drain (multipart): an attachment part failing with 'no longer in that group' marks the group left too", async () => {
  await withMediaOutboundEnabled(async () => {
    const bundle = groupRepo();
    const { deps } = makeDeps();
    await handleProviderOutboundMessage(bundle.repo, groupPayload({ messageId: "msg-group-mp", attachments: ["https://x/a.pdf"] }), deps);
    const row = [...bundle.rows.values()][0];
    const part = [...bundle.attachments.values()][0];
    bundle.bridgeLedger.set(`${SECOND_TENANT_ID}:${row.idempotencyKey}`, { status: "failed", error: GROUP_LEFT_REASON });
    bundle.bridgeLedger.set(`${SECOND_TENANT_ID}:${part.idempotencyKey}`, { status: "failed", error: GROUP_LEFT_REASON });
    await drainGhlOutboundStatuses(bundle.repo, deps);
    assert.deepEqual(bundle.groupsLeft, [{ tenantId: SECOND_TENANT_ID, groupJid: GROUP_JID }]);
    assert.equal(row.reportedStatus, "failed");
  });
});

test("groups outbound: an enabled group the number has LEFT refuses up front with the bridge's 'no longer in that group' string — no send", async () => {
  const bundle = groupRepo(true, true);
  const { deps, sendCalls, sendAttachmentCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ messageId: "msg-group-left" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GROUP_LEFT_REASON });
  assert.equal(sendCalls.length + sendAttachmentCalls.length, 0);
  const row = [...bundle.rows.values()][0];
  assert.equal(row.refusalReason, GROUP_LEFT_REASON);
  assert.equal(row.pendingText, null);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GROUP_LEFT_REASON);
});

test("groups outbound: a switched-off group the number has also left still says 'turned off' (the switch wins)", async () => {
  const bundle = groupRepo(false, true);
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ messageId: "msg-group-off-left" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GROUP_OFF_REASON });
  assert.equal(sendCalls.length, 0);
});

test("groups: the provider's mirrored bridge constants match services/whatsapp-bridge/src/groups.ts byte for byte", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../services/whatsapp-bridge/src/groups.ts", import.meta.url), "utf8");
  const units = /export const GROUP_SEND_CAP_UNITS = (\d+);/.exec(source);
  const reason = /export const NOT_IN_GROUP_REASON = "([^"]*)";/.exec(source);
  assert.ok(units && reason, "both constants must still be declared in the bridge's groups.ts");
  assert.equal(GROUP_SEND_CAP_UNITS, Number(units[1]));
  assert.equal(GHL_PROVIDER_REASONS.groupLeft, reason[1]);
});

// ---------------------------------------------------------------------------
// Reliability final review I3: a new message never overtakes rows already held for the tenant.
test("webhook: tenant already has a held row -> new message is held behind it, bridge not called", async () => {
  const { repo, rows, sessionsByTenant } = createFakeRepo([makeAccount()]);
  sessionsByTenant.set(TENANT_ID, sessionSummary());
  await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "older" }), makeDeps(notConnectedSend).deps);
  assert.equal([...rows.values()][0].sendState, "held");
  const { deps, sendCalls, statusCalls } = makeDeps();
  const out = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "newer" }), deps);
  assert.deepEqual(out, { kind: "held" });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 0);
  const newer = [...rows.values()].find((r) => r.ghlMessageId === "newer")!;
  assert.equal(newer.sendState, "held");
  assert.equal(newer.pendingText, "hi there");
});

test("drain pending_send: tenant already has a held row -> pending row is held behind it, bridge not called", async () => {
  const bundle = createFakeRepo([makeAccount()]);
  await handleProviderOutboundMessage(bundle.repo, samplePayloadFor({ messageId: "pend" }), makeDeps({ sendWhatsapp: async () => ({ ok: false, code: "unreachable", message: "x" }) }).deps);
  const pending = [...bundle.rows.values()][0];
  assert.equal(pending.sendState, "pending_send");
  bundle.rows.set("older-held", { ...pending, id: "older-held", ghlMessageId: "old", idempotencyKey: "old-key", sendState: "held" });
  const { deps, sendCalls } = makeDeps();
  const result = await drainGhlOutboundStatuses(bundle.repo, deps);
  assert.equal(sendCalls.length, 0);
  assert.equal(pending.sendState, "held");
  assert.equal(result.held, 1);
});

// ---------------------------------------------------------------------------
// F2 — picture/file (media) messages are held while a phone is offline,
// exactly like text. The parent row owns the hold; attachment rows stay
// `pending_send` until the release pass sends them.
// ---------------------------------------------------------------------------

const offlineAttachment: Partial<GhlProviderDeps> = {
  sendAttachment: async () => ({ ok: false, code: "session_not_connected", message: "not connected" }),
};
const MEDIA_URLS = ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"];

test("F2 media: offline linked number -> whole text+attachments message held, parts untouched, nothing reported", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, attachments, sessionsByTenant } = createFakeRepo([makeAccount()]);
    sessionsByTenant.set(TENANT_ID, sessionSummary());
    const { deps, statusCalls } = makeDeps({ ...notConnectedSend, ...offlineAttachment });
    const out = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "f2-a", message: "look", attachments: MEDIA_URLS }), deps);
    assert.deepEqual(out, { kind: "held" });
    const row = [...rows.values()][0];
    assert.equal(row.sendState, "held");
    assert.equal(row.pendingText, "look");
    assert.deepEqual([...attachments.values()].map((a) => [a.seq, a.sendState, a.pendingUrl]), [[0, "pending_send", MEDIA_URLS[0]], [1, "pending_send", MEDIA_URLS[1]]]);
    assert.equal(statusCalls.length, 0);
  });
});

test("F2 media: attachments-only message to an offline linked number is held with no text", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, attachments, sessionsByTenant } = createFakeRepo([makeAccount()]);
    sessionsByTenant.set(TENANT_ID, sessionSummary());
    const { deps, statusCalls } = makeDeps(offlineAttachment);
    const out = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "f2-b", message: "", attachments: MEDIA_URLS }), deps);
    assert.deepEqual(out, { kind: "held" });
    const row = [...rows.values()][0];
    assert.equal(row.sendState, "held");
    assert.equal(row.pendingText, null);
    assert.equal(attachments.size, 2);
    assert.equal(statusCalls.length, 0);
  });
});

test("F2 media: text accepted then the phone drops on attachment 1 -> parent held (text kept), remaining parts pending, no double state", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, attachments, sessionsByTenant } = createFakeRepo([makeAccount()]);
    sessionsByTenant.set(TENANT_ID, sessionSummary());
    let n = 0;
    const { deps, statusCalls } = makeDeps({
      sendAttachment: async (input) => (++n === 2 ? { ok: false, code: "session_not_connected", message: "x" } : makeSendResult({ idempotencyKey: input.idempotencyKey, toPhone: input.to })),
    });
    const out = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "f2-c", message: "look", attachments: MEDIA_URLS }), deps);
    assert.deepEqual(out, { kind: "held" });
    const row = [...rows.values()][0];
    assert.equal(row.sendState, "held");
    assert.equal(row.pendingText, "look");
    assert.deepEqual([...attachments.values()].map((a) => a.sendState), ["accepted", "pending_send"]);
    assert.equal(statusCalls.length, 0);
  });
});

test("F2 media: never-linked and banned numbers still refuse media messages", async () => {
  await withMediaOutboundEnabled(async () => {
    for (const [summary, reason] of [
      [sessionSummary({ lastConnectedAt: null, status: "waiting_qr" }), GHL_PROVIDER_REASONS.notConnected],
      [sessionSummary({ status: "banned" }), GHL_PROVIDER_REASONS.numberBanned],
    ] as const) {
      const { repo, rows, sessionsByTenant } = createFakeRepo([makeAccount()]);
      sessionsByTenant.set(TENANT_ID, summary);
      const { deps, statusCalls } = makeDeps({ ...notConnectedSend, ...offlineAttachment });
      const out = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "f2-d", message: "look", attachments: MEDIA_URLS }), deps);
      assert.deepEqual(out, { kind: "refused", reason });
      assert.equal([...rows.values()][0].sendState, "refused");
      assert.equal(statusCalls[0].status, "failed");
    }
  });
});

test("F2 media: an opted-out contact is refused, never held", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, sessionsByTenant, optOuts } = createFakeRepo([makeAccount()]);
    sessionsByTenant.set(TENANT_ID, sessionSummary());
    optOuts.add(`${TENANT_ID}:+447700900123`);
    const { deps, sendAttachmentCalls } = makeDeps(offlineAttachment);
    const out = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "f2-e", attachments: MEDIA_URLS }), deps);
    assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.optedOut });
    assert.equal([...rows.values()][0].sendState, "refused");
    assert.equal(sendAttachmentCalls.length, 0);
  });
});

test("F2 media: a new media message waits behind an older held row (hold-behind ordering), sends nothing", async () => {
  await withMediaOutboundEnabled(async () => {
    const bundle = createFakeRepo([makeAccount()]);
    bundle.sessionsByTenant.set(TENANT_ID, sessionSummary());
    bundle.repo.listHeldGhlOutboundMessages = async () => [{ id: "older" } as GhlOutboundMessage];
    const { deps, sendCalls, sendAttachmentCalls } = makeDeps();
    const out = await handleProviderOutboundMessage(bundle.repo, samplePayloadFor({ messageId: "f2-f", message: "look", attachments: MEDIA_URLS }), deps);
    assert.deepEqual(out, { kind: "held" });
    assert.equal(sendCalls.length + sendAttachmentCalls.length, 0);
    assert.equal([...bundle.rows.values()][0].sendState, "held");
  });
});

test("F2 media drain: a pending_send multipart row whose attachment now says session_not_connected is held, not refused", async () => {
  await withMediaOutboundEnabled(async () => {
    const { repo, rows, attachments, sessionsByTenant } = createFakeRepo([makeAccount()]);
    sessionsByTenant.set(TENANT_ID, sessionSummary());
    // Intake: bridge unreachable on the text part -> row and parts stay pending_send.
    const intake = makeDeps({ sendWhatsapp: async () => ({ ok: false, code: "unreachable", message: "x" }), sendAttachment: async () => ({ ok: false, code: "unreachable", message: "x" }) });
    await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "f2-g", message: "look", attachments: MEDIA_URLS }), intake.deps);
    const { deps, statusCalls } = makeDeps({ ...notConnectedSend, ...offlineAttachment });
    const res = await drainGhlOutboundStatuses(repo, deps);
    assert.equal(res.held, 1);
    assert.equal([...rows.values()][0].sendState, "held");
    assert.ok([...attachments.values()].every((a) => a.sendState === "pending_send"));
    assert.equal(statusCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Merge: STOP opt-outs across a location's numbers, and groups
// ---------------------------------------------------------------------------

test("merge STOP: a contact opted out on the DEFAULT number is refused from their sticky number too, with the other-number string", async () => {
  const { repo, optOuts, rows } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  optOuts.add(`${TENANT_ID}:+447700900123`);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-stop-other" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.optedOutOtherNumber });
  assert.equal(sendCalls.length, 0);
  assert.equal([...rows.values()][0].tenantId, SECOND_TENANT_ID);
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.optedOutOtherNumber);
  assert.equal(GHL_PROVIDER_REASONS.optedOutOtherNumber, "Contact opted out (STOP) on this sub-account — not sent");
});

test("merge STOP: a contact opted out on the number it is sent from keeps the original W10 string", async () => {
  const { repo, optOuts } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: STICKY_TO_SECOND });
  optOuts.add(`${SECOND_TENANT_ID}:+447700900123`);
  const { deps } = makeDeps();
  const outcome = await handleProviderOutboundMessage(repo, samplePayloadFor({ messageId: "msg-stop-same" }), deps);
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.optedOut });
});

test("merge STOP: a group send is never blocked by a member's STOP (the group is opt-in by the owner)", async () => {
  const bundle = groupRepo();
  bundle.optOuts.add(`${SECOND_TENANT_ID}:+447700900123`);
  bundle.optOuts.add(`${TENANT_ID}:+447700900123`);
  const { deps, sendCalls } = makeDeps();
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ phone: "+447700900123", messageId: "msg-group-stop" }), deps);
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
  assert.equal(bundle.calls.some((c) => c.method === "isOptedOut"), false);
});

test("merge hold: an enabled group whose number was linked before and is offline -> HELD on the group's number", async () => {
  const bundle = groupRepo();
  bundle.sessionsByTenant.set(SECOND_TENANT_ID, sessionSummary({ coachId: SECOND_TENANT_ID }));
  const { deps } = makeDeps(notConnectedSend);
  const outcome = await handleProviderOutboundMessage(bundle.repo, groupPayload({ messageId: "msg-group-held" }), deps);
  assert.deepEqual(outcome, { kind: "held" });
  const row = [...bundle.rows.values()][0];
  assert.equal(row.tenantId, SECOND_TENANT_ID);
  assert.equal(row.toPhone, null);
  assert.equal(row.sendState, "held");
  assert.equal(row.pendingText, "hello group");
});

// ---------------------------------------------------------------------------
// App-originated sends (group invites) — the normal outbound path, with STOP,
// billing gate, hold and no GHL status PUT.
// ---------------------------------------------------------------------------

const APP_INPUT = { tenantId: TENANT_ID, ghlContactId: "ghl-contact-app", toPhone: "+447700900123", text: "Hi Sam, join us: https://chat.whatsapp.com/x" };

test("app-originated: ids carry the pwapp_ prefix and are recognised", () => {
  assert.equal(APP_MESSAGE_ID_PREFIX, "pwapp_");
  assert.equal(isAppOriginatedMessageId("pwapp_0123456789abcdef0123456789abcdef"), true);
  assert.equal(isAppOriginatedMessageId("ghl-msg-1"), false);
  assert.equal(isAppOriginatedMessageId("pwapp_" + "a".repeat(32)), true);
  assert.equal(isAppOriginatedMessageId("pwapp_x"), false);
  assert.equal(isAppOriginatedMessageId("pwapp_" + "A".repeat(32)), false);
});

test("app-originated: a STOP on another of the location's numbers refuses the invite", async () => {
  const { repo, optOuts, rows } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS });
  optOuts.add(`${SECOND_TENANT_ID}:+447700900123`);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await sendAppOriginatedText(repo, deps, { account: makeAccount(), ...APP_INPUT });
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.optedOutOtherNumber });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 0);
  const row = [...rows.values()][0];
  assert.equal(row.sendState, "refused");
  assert.equal(row.reportedStatus, "failed");
});

test("app-originated: sent from the given tenant, not the sticky or default number", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()], { numbers: TWO_NUMBERS, sticky: { [`${LOCATION_ID}:ghl-contact-app`]: TENANT_ID } });
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await sendAppOriginatedText(repo, deps, { account: makeAccount(), ...APP_INPUT, tenantId: SECOND_TENANT_ID });
  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].coachId, SECOND_TENANT_ID);
  assert.equal(sendCalls[0].text, APP_INPUT.text);
  const row = [...rows.values()][0];
  assert.equal(row.tenantId, SECOND_TENANT_ID);
  assert.ok(isAppOriginatedMessageId(row.ghlMessageId));
  assert.equal(statusCalls.length, 0);
});

test("app-originated: number offline (linked before) -> held", async () => {
  const { repo, rows, sessionsByTenant } = createFakeRepo([makeAccount()]);
  sessionsByTenant.set(TENANT_ID, sessionSummary());
  const { deps, statusCalls } = makeDeps(notConnectedSend);
  const outcome = await sendAppOriginatedText(repo, deps, { account: makeAccount(), ...APP_INPUT });
  assert.deepEqual(outcome, { kind: "held" });
  assert.equal([...rows.values()][0].sendState, "held");
  assert.equal(statusCalls.length, 0);
});

test("app-originated: billing gate applies and nothing is PUT to GHL", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()], { status: "cancelled" });
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await sendAppOriginatedText(repo, deps, { account: makeAccount(), ...APP_INPUT });
  assert.deepEqual(outcome, { kind: "refused", reason: sendingGate(makeAccount(), "cancelled", brandConfig().name) });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 0);
  assert.equal([...rows.values()][0].reportedStatus, "failed");
});

test("app-originated: the status drain marks an accepted row reported without calling GHL", async () => {
  const bundle = createFakeRepo([makeAccount()]);
  const { deps, statusCalls } = makeDeps();
  await sendAppOriginatedText(bundle.repo, deps, { account: makeAccount(), ...APP_INPUT });
  const row = [...bundle.rows.values()][0];
  const outcome = await reportGhlOutcome(bundle.repo, deps, makeAccount(), row, "delivered", null);
  assert.equal(outcome, "reported");
  assert.equal(statusCalls.length, 0);
  assert.equal(bundle.rows.get(row.id)!.reportedStatus, "delivered");
});

test("app-originated: a tenant that is not one of the location's numbers is refused, nothing recorded or sent", async () => {
  const { repo, rows } = createFakeRepo([makeAccount()]);
  const { deps, sendCalls, statusCalls } = makeDeps();
  const outcome = await sendAppOriginatedText(repo, deps, { account: makeAccount(), ...APP_INPUT, tenantId: SECOND_TENANT_ID });
  assert.deepEqual(outcome, { kind: "refused", reason: "Sending number isn't on this sub-account — not sent" });
  assert.equal(rows.size, 0);
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Group invites (Task 7) — getGhlContact / searchGhlContacts
// ---------------------------------------------------------------------------

test("searchGhlContacts: sends the tag filter and maps the GHL response", async () => {
  const { result, requests } = await withCapturedFetch(
    async () =>
      jsonResponse(200, {
        contacts: [
          { id: "c1", firstName: "Sam", lastName: "Lee", contactName: "Sam Lee", phone: "+447700900123", tags: ["Cohort", "vip"] },
          { id: "c2", firstName: null, phone: null, tags: ["other"] },
          { id: "c3", name: "Pat", tags: ["COHORT"] },
        ],
        total: 3,
      }),
    () => searchGhlContacts("token", "loc-1", { tag: "Cohort" }, 100)
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://services.leadconnectorhq.com/contacts/search");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.authorization, "Bearer token");
  assert.equal(requests[0].headers.version, "2021-07-28");
  const body = requests[0].body as { locationId: string; filters: { field: string; value: string[] }[] };
  assert.equal(body.locationId, "loc-1");
  assert.equal(body.filters[0].field, "tags");
  assert.deepEqual(body.filters[0].value, ["cohort"]);
  assert.deepEqual(result, {
    ok: true,
    truncated: false,
    contacts: [
      { id: "c1", firstName: "Sam", name: "Sam Lee", phone: "+447700900123", tags: ["Cohort", "vip"] },
      { id: "c3", firstName: null, name: "Pat", phone: null, tags: ["COHORT"] },
    ],
  });
});

test("searchGhlContacts: more matches than the limit sets truncated", async () => {
  const { result } = await withCapturedFetch(
    async () => jsonResponse(200, { contacts: [{ id: "a", tags: [] }, { id: "b", tags: [] }, { id: "c", tags: [] }] }),
    () => searchGhlContacts("token", "loc-1", { text: "x" }, 2)
  );
  assert.ok(result.ok);
  assert.equal(result.contacts.length, 2);
  assert.equal(result.truncated, true);
});

test("searchGhlContacts: a non-2xx is { ok: false } without the response body", async () => {
  const { result } = await withCapturedFetch(
    async () => jsonResponse(422, { message: "secret upstream detail" }),
    () => searchGhlContacts("token", "loc-1", { tag: "t" }, 10)
  );
  assert.deepEqual(result, { ok: false, error: "GHL contact search rejected (HTTP 422)" });
});

test("getGhlContact: maps a contact; a non-2xx is { ok: false } without the body", async () => {
  const ok = await withCapturedFetch(
    async () => jsonResponse(200, { contact: { id: "c1", firstName: "Sam", phone: "+447700900123", tags: ["a"] } }),
    () => getGhlContact("token", "c1")
  );
  assert.equal(ok.requests[0].url, "https://services.leadconnectorhq.com/contacts/c1");
  assert.deepEqual(ok.result, { ok: true, contact: { id: "c1", firstName: "Sam", name: "Sam", phone: "+447700900123", tags: ["a"] } });
  const bad = await withCapturedFetch(async () => jsonResponse(404, { message: "secret" }), () => getGhlContact("token", "c1"));
  assert.deepEqual(bad.result, { ok: false, error: "GHL contact read rejected (HTTP 404)", notFound: true });
});

test("searchGhlContacts: stops at 20 pages when GHL ignores `page` and sets truncated", async () => {
  const full = Array.from({ length: 100 }, (_, n) => ({ id: `c${n}`, tags: [] }));
  const { result, requests } = await withCapturedFetch(async () => jsonResponse(200, { contacts: full }), () => searchGhlContacts("token", "loc-1", { text: "x" }, 100000));
  assert.equal(requests.length, 20);
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
});

test("getGhlContact: a 404 is flagged notFound", async () => {
  const { result } = await withCapturedFetch(async () => jsonResponse(404, {}), () => getGhlContact("token", "c1"));
  assert.deepEqual(result, { ok: false, error: "GHL contact read rejected (HTTP 404)", notFound: true });
});

// ---------------------------------------------------------------------------
// Workflow triggers: whatsapp_not_on_whatsapp from the status drain.
// ---------------------------------------------------------------------------

const triggerFlagBefore = process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
afterEach(() => {
  if (triggerFlagBefore === undefined) delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
  else process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = triggerFlagBefore;
});

function triggerFake(behaviour: "ok" | "throw" = "ok") {
  process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = "true";
  const fired: { locationId: string; key: string; payload: unknown }[] = [];
  const fireTrigger: GhlProviderDeps["fireTrigger"] = async (_repo, locationId, key, payload) => {
    fired.push({ locationId, key, payload });
    if (behaviour === "throw") throw new Error("boom");
    return { fired: 1, failed: 0 };
  };
  return { fired, fireTrigger };
}

test("triggers: an accepted row keeps its text until reported, then it is cleared", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  const row = seedAcceptedRow(repoBundle, { pendingText: "hello there" });
  await repoBundle.repo.updateGhlOutboundSendState(row.id, { sendState: "accepted" });
  assert.equal(row.pendingText, "hello there");
  await repoBundle.repo.markGhlOutboundReported(row.id, { reportedStatus: null, reportError: "down" });
  assert.equal(row.pendingText, "hello there", "a failed PUT leaves it for the retry");
  await repoBundle.repo.markGhlOutboundReported(row.id, { reportedStatus: "delivered", reportError: null });
  assert.equal(row.pendingText, null);
});

test("triggers: not_on_whatsapp reported to GHL fires whatsapp_not_on_whatsapp carrying the unsent text", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary({ phoneNumber: "+447700900999" }));
  const row = seedAcceptedRow(repoBundle, { pendingText: "Hi, your booking is tomorrow" });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  const { fired, fireTrigger } = triggerFake();
  const { deps } = makeDeps({ fireTrigger });

  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(row.pendingText, null, "cleared once reported");
  assert.deepEqual(fired, [
    { locationId: LOCATION_ID, key: "whatsapp_not_on_whatsapp", payload: { number: "+447700900999", numberLabel: null, contactId: "ghl-contact-1", message: "Hi, your booking is tomorrow" } },
  ]);
});

test("triggers: a stored pending_text is sent capped at 500 code points", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary({ phoneNumber: "+447700900999" }));
  const row = seedAcceptedRow(repoBundle, { pendingText: "😀".repeat(600) });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  const { fired, fireTrigger } = triggerFake();
  await drainGhlOutboundStatuses(repoBundle.repo, makeDeps({ fireTrigger }).deps);
  assert.equal(Array.from((fired[0].payload as { message: string }).message).length, 500);
});

test("triggers: delivered, other failures and an unreported not_on_whatsapp fire nothing", async () => {
  const delivered = createFakeRepo([makeAccount()]);
  delivered.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const d = seedAcceptedRow(delivered);
  delivered.bridgeLedger.set(`${TENANT_ID}:${d.idempotencyKey}`, { status: "sent", error: null });
  const failed = createFakeRepo([makeAccount()]);
  failed.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const f = seedAcceptedRow(failed);
  failed.bridgeLedger.set(`${TENANT_ID}:${f.idempotencyKey}`, { status: "failed", error: "send failed" });
  const unreported = createFakeRepo([makeAccount()]);
  unreported.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const u = seedAcceptedRow(unreported);
  unreported.bridgeLedger.set(`${TENANT_ID}:${u.idempotencyKey}`, { status: "not_on_whatsapp", error: null });

  const fakeOne = triggerFake();
  await drainGhlOutboundStatuses(delivered.repo, makeDeps({ fireTrigger: fakeOne.fireTrigger }).deps);
  await drainGhlOutboundStatuses(failed.repo, makeDeps({ fireTrigger: fakeOne.fireTrigger }).deps);
  const putFails = makeDeps({ fireTrigger: fakeOne.fireTrigger, updateStatus: async () => ({ ok: false, error: "down", status: 503 }) });
  const r = await drainGhlOutboundStatuses(unreported.repo, putFails.deps);
  assert.equal(r.reportFailed, 1);
  assert.deepEqual(fakeOne.fired, []);
});

test("triggers: a multipart message that fails as not on WhatsApp fires once", async () => {
  const { repoBundle, row, parts } = await seedMultipartRow({ messageId: "msg-mp-trigger", attachments: ["https://x/a.pdf"] });
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary({ phoneNumber: "+447700900999" }));
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${parts[0].idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  const { fired, fireTrigger } = triggerFake();
  const result = await drainGhlOutboundStatuses(repoBundle.repo, makeDeps({ fireTrigger }).deps);
  assert.equal(result.failed, 1);
  assert.deepEqual(fired.map((f) => f.key), ["whatsapp_not_on_whatsapp"]);
});

test("triggers: a throwing fire never changes the status drain result", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const row = seedAcceptedRow(repoBundle);
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  const { fired, fireTrigger } = triggerFake("throw");
  const { deps, statusCalls } = makeDeps({ fireTrigger });
  const result = await drainGhlOutboundStatuses(repoBundle.repo, deps);
  assert.equal(result.failed, 1);
  assert.equal(result.reportFailed, 0);
  assert.equal(fired.length, 1);
  assert.equal(statusCalls.length, 1);
});

test("triggers: with the flag off the real helper posts nothing anywhere", async () => {
  const saved = process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("unexpected fetch"); }) as typeof fetch;
  try {
    const repoBundle = createFakeRepo([makeAccount()]);
    repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary());
    const row = seedAcceptedRow(repoBundle);
    repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
    const result = await drainGhlOutboundStatuses(repoBundle.repo, makeDeps().deps); // no fireTrigger: the real helper
    assert.equal(result.failed, 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
    else process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = saved;
  }
});

test("triggers: flag off means no phone read and no fire for the status drain", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const row = seedAcceptedRow(repoBundle, { pendingText: "x" });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
  const fired: unknown[] = [];
  const result = await drainGhlOutboundStatuses(repoBundle.repo, makeDeps({ fireTrigger: async (...a) => { fired.push(a); } }).deps);
  assert.equal(result.failed, 1);
  assert.deepEqual(fired, []);
  assert.equal(repoBundle.calls.filter((c) => c.method === "getTenantPhone").length, 0);
});

test("triggers: a failed fire in the status drain is contained and later fires are skipped", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary({ phoneNumber: "+447700900999" }));
  for (let i = 0; i < 3; i++) {
    const row = seedAcceptedRow(repoBundle, { pendingText: `t${i}` });
    repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  }
  const { fired, fireTrigger } = triggerFake("throw");
  const result = await drainGhlOutboundStatuses(repoBundle.repo, makeDeps({ fireTrigger }).deps);
  assert.equal(result.failed, 3);
  assert.equal(fired.length + result.triggersSkipped, 3);
  assert.ok(result.triggersSkipped >= 1);
});

test("triggers: number lookups are memoised per pass in the status drain", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary({ phoneNumber: "+447700900999" }));
  for (let i = 0; i < 3; i++) {
    const row = seedAcceptedRow(repoBundle);
    repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  }
  const { fired, fireTrigger } = triggerFake();
  await drainGhlOutboundStatuses(repoBundle.repo, makeDeps({ fireTrigger }).deps);
  assert.equal(fired.length, 3);
  assert.equal(repoBundle.calls.filter((c) => c.method === "getTenantPhone").length, 1);
});

// ---------------------------------------------------------------------------
// SMS fallback A: remember contacts who aren't on WhatsApp.
// ---------------------------------------------------------------------------

const MEMORY_KEY = `${LOCATION_ID}:+447700900123`;
const DAY_MS = 24 * 60 * 60 * 1000;

test("fallback: not_on_whatsapp is remembered for 30 days", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const row = seedAcceptedRow(repoBundle, { pendingText: "hi" });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  const before = Date.now();
  await drainGhlOutboundStatuses(repoBundle.repo, makeDeps().deps);
  const until = Date.parse(repoBundle.notOnWhatsapp.get(MEMORY_KEY) ?? "");
  assert.ok(until >= before + 30 * DAY_MS && until <= Date.now() + 30 * DAY_MS);
});

test("fallback: a group row's not_on_whatsapp is not remembered", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary());
  const row = seedAcceptedRow(repoBundle, { toPhone: null });
  repoBundle.bridgeLedger.set(`${TENANT_ID}:${row.idempotencyKey}`, { status: "not_on_whatsapp", error: null });
  await drainGhlOutboundStatuses(repoBundle.repo, makeDeps().deps);
  assert.equal(repoBundle.notOnWhatsapp.size, 0);
});

test("fallback: remembered contact is refused fast without a bridge call and fires the trigger", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary({ phoneNumber: "+447700900999" }));
  repoBundle.notOnWhatsapp.set(MEMORY_KEY, new Date(Date.now() + DAY_MS).toISOString());
  const { fired, fireTrigger } = triggerFake();
  const { deps, deferred, sendCalls, statusCalls } = makeDeps({ fireTrigger });
  const out = await handleProviderOutboundMessage(repoBundle.repo, samplePayloadFor({ message: "see you at 3" }), deps);
  assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.notOnWhatsapp });
  assert.equal(sendCalls.length, 0);
  assert.equal(statusCalls[0].status, "failed");
  assert.equal(statusCalls[0].errorMessage, GHL_PROVIDER_REASONS.notOnWhatsapp);
  assert.equal([...repoBundle.rows.values()][0].sendState, "refused");
  assert.equal(deferred.length, 1, "the fire is handed to defer, not dropped");
  await Promise.all(deferred.map((fn) => fn()));
  assert.deepEqual(fired, [
    { locationId: LOCATION_ID, key: "whatsapp_not_on_whatsapp", payload: { number: "+447700900999", numberLabel: null, contactId: "ghl-contact-1", message: "see you at 3" } },
  ]);
});

test("fallback: a remembered contact is refused fast even with attachments", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.sessionsByTenant.set(TENANT_ID, sessionSummary({ phoneNumber: "+447700900999" }));
  repoBundle.notOnWhatsapp.set(MEMORY_KEY, new Date(Date.now() + DAY_MS).toISOString());
  const { fired, fireTrigger } = triggerFake();
  const { deps, deferred, sendCalls, sendAttachmentCalls } = makeDeps({ fireTrigger });
  const out = await handleProviderOutboundMessage(repoBundle.repo, samplePayloadFor({ message: "pic", attachments: ["https://x/a.pdf"] }), deps);
  assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.notOnWhatsapp });
  assert.equal(sendCalls.length, 0);
  assert.equal(sendAttachmentCalls.length, 0);
  await Promise.all(deferred.map((fn) => fn()));
  assert.equal(fired.length, 1);
});

test("fallback: an expired memory sends normally", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.notOnWhatsapp.set(MEMORY_KEY, new Date(Date.now() - 1000).toISOString());
  const { deps, sendCalls } = makeDeps();
  const out = await handleProviderOutboundMessage(repoBundle.repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
});

test("fallback: opted-out contact: STOP refusal wins, no fallback trigger", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.notOnWhatsapp.set(MEMORY_KEY, new Date(Date.now() + DAY_MS).toISOString());
  repoBundle.optOuts.add(`${TENANT_ID}:+447700900123`);
  const { fired, fireTrigger } = triggerFake();
  const { deps, deferred, sendCalls } = makeDeps({ fireTrigger });
  const out = await handleProviderOutboundMessage(repoBundle.repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "refused", reason: GHL_PROVIDER_REASONS.optedOut });
  assert.equal(sendCalls.length, 0);
  await Promise.all(deferred.map((fn) => fn()));
  assert.deepEqual(fired, []);
});

test("fallback: memory read error fails open", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.memory.readFails = true;
  const { deps, sendCalls } = makeDeps();
  const out = await handleProviderOutboundMessage(repoBundle.repo, samplePayloadFor(), deps);
  assert.deepEqual(out, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
});

test("fallback: group sends ignore the memory", async () => {
  const bundle = groupRepo();
  bundle.notOnWhatsapp.set(MEMORY_KEY, new Date(Date.now() + DAY_MS).toISOString());
  const { deps, sendCalls } = makeDeps();
  const out = await handleProviderOutboundMessage(bundle.repo, groupPayload(), deps);
  assert.deepEqual(out, { kind: "accepted" });
  assert.equal(sendCalls.length, 1);
  assert.equal(bundle.calls.some((c) => c.method === "isRememberedNotOnWhatsapp"), false);
});

test("fallback: an app-originated send to a remembered contact is refused too", async () => {
  const repoBundle = createFakeRepo([makeAccount()]);
  repoBundle.notOnWhatsapp.set(MEMORY_KEY, new Date(Date.now() + DAY_MS).toISOString());
  const { deps, sendCalls } = makeDeps();
  const outcome = await sendAppOriginatedText(repoBundle.repo, deps, { account: makeAccount(), ...APP_INPUT });
  assert.deepEqual(outcome, { kind: "refused", reason: GHL_PROVIDER_REASONS.notOnWhatsapp });
  assert.equal(sendCalls.length, 0);
});
