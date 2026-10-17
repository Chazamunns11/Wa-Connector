/**
 * GHL custom conversation provider, Phase 3 — inbound (docs/GHL-PROVIDER-PLAN.md's
 * Phase 3 follow-on §4 item 15, §5 tests 1-11). Covers `src/lib/ghl-inbound.ts`'s
 * `drainGhlInboundReplies` against a fake repo (modelled on
 * `scripts/test/ghl.test.ts`'s `createFakeRepo`, honouring the claim/
 * un-claim/resolve contracts) and fake GHL deps. Entirely offline: no
 * network, no real GHL account, no Supabase, no bridge. `describeInboundMediaPlaceholder`
 * (a pure function, `src/lib/ghl.ts`) gets direct unit tests, same convention
 * as that file's other pure helpers (`buildOutboundText`, `deriveIdempotencyKey`);
 * `upsertGhlContact` and `addGhlInboundMessage` are exercised via fakes AT
 * THIS DRAIN LEVEL — this file only ever tests `drainGhlInboundReplies`'s own
 * branching, never the real network calls' own catch-block classification.
 * `addGhlInboundMessage`'s own failure-classification logic (adversarial-
 * review finding 1 — pre-flight `"unreachable"` vs. everything-else
 * `"timeout_uncertain"`) is instead unit-tested directly in
 * `scripts/test/ghl.test.ts`, which stubs `globalThis.fetch` (the same
 * pattern `scripts/test/stripe.test.ts` already established) — that bug
 * lives inside `addGhlInboundMessage`'s own catch block, which a fake dep at
 * this drain level can never exercise.
 */
import test, { beforeEach, afterEach } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeInboundMediaPlaceholder, describeMissedCall, MISSED_VIDEO_CALL_TEXT, MISSED_VOICE_CALL_TEXT } from "@/lib/ghl";
import type { AddGhlInboundMessageResult, UpsertGhlContactResult } from "@/lib/ghl";
import {
  drainGhlInboundReplies,
  MISSED_CALL_STALE_MS,
  MISSED_CALL_STALE_RESOLUTION,
  GHL_INBOUND_REASONS,
  type GhlInboundDeps,
  type GhlInboundRepo,
} from "@/lib/ghl-inbound";
import { shouldReplaceSticky } from "@/lib/location-numbers";
import type { GhlAccount, LocationNumber, WhatsappGroup, WhatsappInboundMessage } from "@/lib/types";

// ---------------------------------------------------------------------------
// describeInboundMediaPlaceholder — pure, direct tests (plan §Q6 / test 6).
// ---------------------------------------------------------------------------

test("describeInboundMediaPlaceholder: every known messageType maps to its own fixed string", () => {
  const cases: Record<string, string> = {
    imageMessage: "[Photo received on WhatsApp — view it on the connected phone]",
    audioMessage: "[Voice note received on WhatsApp — view it on the connected phone]",
    pttMessage: "[Voice note received on WhatsApp — view it on the connected phone]",
    videoMessage: "[Video received on WhatsApp — view it on the connected phone]",
    stickerMessage: "[Sticker received on WhatsApp — view it on the connected phone]",
    documentMessage: "[Document received on WhatsApp — view it on the connected phone]",
  };
  for (const [messageType, expected] of Object.entries(cases)) {
    assert.equal(describeInboundMediaPlaceholder(messageType), expected, messageType);
  }
});

test("describeInboundMediaPlaceholder: an unknown/future messageType falls through to the generic default", () => {
  assert.equal(
    describeInboundMediaPlaceholder("someFutureBaileysType"),
    "[WhatsApp message received — view it on the connected phone]"
  );
  assert.equal(
    describeInboundMediaPlaceholder("conversation"), // a TEXT type — never actually called with body=null in practice, but must still resolve to the default rather than throw
    "[WhatsApp message received — view it on the connected phone]"
  );
});

// ---------------------------------------------------------------------------
// Fixtures + fake repo/deps for drainGhlInboundReplies.
// ---------------------------------------------------------------------------

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const LOCATION_ID = "loc-ghl-1";
const ENV_PROVIDER_ID = "env-provider-id";

let savedProviderIdEnv: string | undefined;
beforeEach(() => {
  savedProviderIdEnv = process.env.GHL_CONVERSATION_PROVIDER_ID;
  process.env.GHL_CONVERSATION_PROVIDER_ID = ENV_PROVIDER_ID;
});
afterEach(() => {
  if (savedProviderIdEnv === undefined) delete process.env.GHL_CONVERSATION_PROVIDER_ID;
  else process.env.GHL_CONVERSATION_PROVIDER_ID = savedProviderIdEnv;
});

function makeAccount(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: LOCATION_ID,
    tenantId: TENANT_ID,
    label: "Test GHL Location",
    companyId: null,
    conversationProviderId: null,
    accessToken: "access-token-fresh",
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshToken: "refresh-token-1",
    status: "active",
    lastError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

let nextRowSeq = 1;
function makeRow(overrides: Partial<WhatsappInboundMessage> = {}): WhatsappInboundMessage {
  const seq = nextRowSeq++;
  return {
    id: `row-${seq}`,
    coachId: TENANT_ID,
    fromPhone: "+447700900123",
    body: "hi, got your message",
    messageType: "conversation",
    receivedAt: new Date(2026, 6, 1, 10, 0, seq).toISOString(),
    processedAt: null,
    resolution: null,
    pushAttempts: 0,
    pushError: null,
    createdAt: new Date(2026, 6, 1, 10, 0, seq).toISOString(),
    // Media plan (docs/MEDIA-PLAN.md §6) — absent/null by default, matching
    // every row this suite exercised before the media plan touched this
    // file: a plain text reply, media capture never applicable.
    mediaStatus: null,
    mediaPath: null,
    mediaMime: null,
    mediaSizeBytes: null,
    eventKind: null,
    ...overrides,
  };
}

interface FakeCall {
  method: string;
  args: unknown[];
}

/**
 * In-memory `GhlInboundRepo` — mirrors `src/lib/data/supabase.ts`'s actual
 * semantics closely enough to exercise every branch: the active-account
 * fence (`getUnprocessedGhlInboundMessages`), the atomic claim
 * (`claimWhatsappInboundMessage`, the SAME shape the coach drain uses), the
 * un-claim-on-retry contract (`recordGhlInboundPushFailure`'s `unclaim`
 * flag), and an atomic-ish `claimGhlTokenRefresh`.
 *
 * Multiple numbers (Task 3): `numbers` seeds a location's
 * `ghl_location_numbers` rows (default: the one slot-1 row install creates for
 * the account's tenant). `getGhlAccountByTenantId` resolves through them like
 * supabase.ts does, so a second number's row finds its location's account
 * (whose `tenantId` stays the DEFAULT number). `sticky` is the in-memory
 * `ghl_contact_numbers`, written with the same strictly-newer rule
 * (`shouldReplaceSticky`) the real repository applies.
 */
function createFakeRepo(
  accounts: GhlAccount[] = [],
  rows: WhatsappInboundMessage[] = [],
  numbers: Record<string, LocationNumber[]> = {},
  groups: WhatsappGroup[] = []
) {
  const groupsByKey = new Map(groups.map((g) => [`${g.tenantId}:${g.groupJid}`, { ...g }]));
  const accountsByLocation = new Map(accounts.map((a) => [a.locationId, a]));
  const rowsById = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls: FakeCall[] = [];
  const sticky = new Map<string, { tenantId: string; lastInboundAt: string }>();
  let claimedAt: number | null = null;
  /** Opt-out store keyed `tenant:phone` — mirrors the (tenant_id, phone) upsert/delete contract. */
  const optOuts = new Map<string, { keyword: string; ghlContactId: string | null }>();

  function numbersFor(locationId: string): LocationNumber[] {
    const seeded = numbers[locationId];
    if (seeded) return seeded;
    const account = accountsByLocation.get(locationId);
    return account ? [{ tenantId: account.tenantId, slot: 1, isDefault: true, label: null }] : [];
  }

  function accountForTenant(tenantId: string): GhlAccount | undefined {
    return [...accountsByLocation.values()].find((a) => numbersFor(a.locationId).some((n) => n.tenantId === tenantId));
  }

  const repo: GhlInboundRepo = {
    async getGhlAccountByLocationId(locationId: string) {
      calls.push({ method: "getGhlAccountByLocationId", args: [locationId] });
      return accountsByLocation.get(locationId) ?? null;
    },
    async getGhlAccountByTenantId(tenantId: string) {
      calls.push({ method: "getGhlAccountByTenantId", args: [tenantId] });
      return accountForTenant(tenantId) ?? null;
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
    /** Mirrors supabase.ts's active-account fence — a needs_reauth/disabled location's rows are EXCLUDED here, never merely skipped later. */
    async getUnprocessedGhlInboundMessages(limit = 50) {
      calls.push({ method: "getUnprocessedGhlInboundMessages", args: [limit] });
      return [...rowsById.values()]
        .filter((r) => r.processedAt === null)
        .filter((r) => accountForTenant(r.coachId)?.status === "active")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    },
    async claimWhatsappInboundMessage(id: string) {
      calls.push({ method: "claimWhatsappInboundMessage", args: [id] });
      const row = rowsById.get(id);
      if (!row || row.processedAt !== null) return false;
      row.processedAt = new Date().toISOString();
      return true;
    },
    async recordGhlInboundPushFailure(id: string, patch: { attempts: number; pushError: string; unclaim: boolean }) {
      calls.push({ method: "recordGhlInboundPushFailure", args: [id, patch] });
      const row = rowsById.get(id);
      if (!row) throw new Error(`no such row ${id}`);
      row.pushAttempts = patch.attempts;
      row.pushError = patch.pushError;
      if (patch.unclaim) row.processedAt = null;
    },
    async resolveGhlInboundMessage(id: string, patch: { resolution: string; pushError: string | null }) {
      calls.push({ method: "resolveGhlInboundMessage", args: [id, patch] });
      const row = rowsById.get(id);
      if (!row) throw new Error(`no such row ${id}`);
      row.resolution = patch.resolution;
      row.pushError = patch.pushError;
    },
    async recordOptOut(input: { tenantId: string; phone: string; keyword: string; ghlContactId: string | null }) {
      calls.push({ method: "recordOptOut", args: [input] });
      optOuts.set(`${input.tenantId}:${input.phone}`, { keyword: input.keyword, ghlContactId: input.ghlContactId });
    },
    async clearOptOut(tenantId: string, phone: string) {
      calls.push({ method: "clearOptOut", args: [tenantId, phone] });
      optOuts.delete(`${tenantId}:${phone}`);
    },
    /** Media plan (docs/MEDIA-PLAN.md §6.2) — deterministic fake: "signs" any path into a fixed-shape URL, unless the path starts with FAIL_SIGN_PREFIX (a per-test opt-in for the signing-failure branch). */
    async createWhatsappMediaSignedUrl(path: string) {
      calls.push({ method: "createWhatsappMediaSignedUrl", args: [path] });
      if (path.startsWith(FAIL_SIGN_PREFIX)) return null;
      return `https://storage.example.supabase.co/object/sign/wa-media/${path}?token=fake`;
    },
    async listLocationNumbers(locationId: string) {
      calls.push({ method: "listLocationNumbers", args: [locationId] });
      return numbersFor(locationId);
    },
    async recordInboundForStickiness(locationId: string, ghlContactId: string, tenantId: string, receivedAtIso: string) {
      calls.push({ method: "recordInboundForStickiness", args: [locationId, ghlContactId, tenantId, receivedAtIso] });
      const key = `${locationId}:${ghlContactId}`;
      if (!shouldReplaceSticky(sticky.get(key)?.lastInboundAt ?? null, receivedAtIso)) return;
      sticky.set(key, { tenantId, lastInboundAt: receivedAtIso });
    },
    async listWhatsappGroups(tenantId: string) {
      calls.push({ method: "listWhatsappGroups", args: [tenantId] });
      return [...groupsByKey.values()].filter((g) => g.tenantId === tenantId).map((g) => ({ ...g }));
    },
    async setWhatsappGroupContact(tenantId: string, groupJid: string, ghlContactId: string) {
      calls.push({ method: "setWhatsappGroupContact", args: [tenantId, groupJid, ghlContactId] });
      const group = groupsByKey.get(`${tenantId}:${groupJid}`);
      if (!group) throw new Error(`no such group ${groupJid}`);
      group.ghlContactId = ghlContactId;
    },
  };

  return { repo, accountsByLocation, rowsById, calls, sticky, groupsByKey, optOuts };
}

/** Media plan test fixture marker — see `createFakeRepo`'s `createWhatsappMediaSignedUrl` fake above. */
const FAIL_SIGN_PREFIX = "SIGN-FAILS/";

function makeUpsertResult(overrides: Partial<Extract<UpsertGhlContactResult, { ok: true }>> = {}): UpsertGhlContactResult {
  return { ok: true, contactId: "contact-1", isNew: true, ...overrides };
}

function makeDeps(overrides: Partial<GhlInboundDeps> = {}): {
  deps: GhlInboundDeps;
  upsertCalls: { accessToken: string; locationId: string; phoneE164: string }[];
  groupUpsertCalls: { accessToken: string; locationId: string; name: string; groupKey: string }[];
  postCalls: { accessToken: string; contactId: string; conversationProviderId: string; body: string; timestampIso?: string }[];
  notifyCalls: string[];
} {
  const upsertCalls: { accessToken: string; locationId: string; phoneE164: string }[] = [];
  const groupUpsertCalls: { accessToken: string; locationId: string; name: string; groupKey: string }[] = [];
  const postCalls: { accessToken: string; contactId: string; conversationProviderId: string; body: string; timestampIso?: string }[] = [];
  const notifyCalls: string[] = [];
  const deps: GhlInboundDeps = {
    upsertContact: async (accessToken, locationId, phoneE164) => {
      upsertCalls.push({ accessToken, locationId, phoneE164 });
      return makeUpsertResult();
    },
    upsertGroupContact: async (accessToken, locationId, input) => {
      groupUpsertCalls.push({ accessToken, locationId, ...input });
      return makeUpsertResult({ contactId: "group-contact-1" });
    },
    addInboundMessage: async (accessToken, input) => {
      postCalls.push({ accessToken, ...input });
      return { ok: true };
    },
    refreshToken: async () => ({ ok: false, kind: "invalid_grant" }),
    refreshWaitMs: 5,
    notify: (text) => {
      notifyCalls.push(text);
    },
    ...overrides,
  };
  return { deps, upsertCalls, groupUpsertCalls, postCalls, notifyCalls };
}

// ---------------------------------------------------------------------------
// 1. Provider id unset
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: GHL_CONVERSATION_PROVIDER_ID unset -> zero repo reads, zero GHL calls, blockedUnconfigured set", async () => {
  delete process.env.GHL_CONVERSATION_PROVIDER_ID;
  const { repo, calls } = createFakeRepo([makeAccount()], [makeRow()]);
  const { deps, upsertCalls, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.deepEqual(result, {
    candidates: 0,
    pushed: 0,
    rejected: 0,
    failed: 0,
    uncertain: 0,
    retried: 0,
    claimLost: 0,
    groupNotEnabled: 0,
    staleMissedCalls: 0,
    optedOut: 0,
    optedIn: 0,
    blockedUnconfigured: true,
  });
  assert.equal(calls.length, 0, "no repo method may be called at all when the provider id is unset");
  assert.equal(upsertCalls.length, 0);
  assert.equal(postCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Happy path
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: happy path — upsert with exact E.164 + locationId -> claim -> POST body/timestamp/providerId -> resolution 'ghl_pushed'", async () => {
  const row = makeRow({ body: "hey, still keen for the call", fromPhone: "+447700900999", receivedAt: "2026-08-01T09:00:00.000Z" });
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
  const { deps, upsertCalls, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.candidates, 1);
  assert.equal(result.pushed, 1);
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0]?.locationId, LOCATION_ID);
  assert.equal(upsertCalls[0]?.phoneE164, "+447700900999");
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0]?.body, "hey, still keen for the call");
  assert.equal(postCalls[0]?.timestampIso, "2026-08-01T09:00:00.000Z");
  assert.equal(postCalls[0]?.conversationProviderId, ENV_PROVIDER_ID);
  assert.equal(postCalls[0]?.contactId, "contact-1");

  const stored = rowsById.get(row.id)!;
  assert.equal(stored.resolution, "ghl_pushed");
  assert.equal(stored.pushError, null);
  assert.notEqual(stored.processedAt, null, "row must remain claimed after a successful push");
});

// ---------------------------------------------------------------------------
// 3. Per-account override
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: an account's own conversationProviderId override wins over the env value", async () => {
  const account = makeAccount({ conversationProviderId: "account-override-provider-id" });
  const { repo } = createFakeRepo([account], [makeRow()]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0]?.conversationProviderId, "account-override-provider-id");
  assert.notEqual(postCalls[0]?.conversationProviderId, ENV_PROVIDER_ID);
});

// ---------------------------------------------------------------------------
// 4. Claim race
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: lost claim race -> no POST, no resolve, row left untouched", async () => {
  const row = makeRow();
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();
  // The claim always loses this pass — simulate by wrapping the fake repo.
  const claimAlwaysLoses: GhlInboundRepo = {
    ...repo,
    claimWhatsappInboundMessage: async () => false,
  };

  const result = await drainGhlInboundReplies(claimAlwaysLoses, deps);

  assert.equal(result.claimLost, 1);
  assert.equal(result.pushed, 0);
  assert.equal(postCalls.length, 0, "the message must never be posted if the claim was lost");
  const stored = rowsById.get(row.id)!;
  assert.equal(stored.resolution, null, "an unclaimed row must never be resolved");
  assert.equal(stored.pushAttempts, 0, "an unclaimed row's attempt counter must be untouched");
});

// ---------------------------------------------------------------------------
// 5. Upsert race (same-pass memo)
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: two rows, same new phone, one pass -> exactly one upsert call (memoised), same contactId used for both", async () => {
  const rowA = makeRow({ fromPhone: "+447700900555" });
  const rowB = makeRow({ fromPhone: "+447700900555" });
  const { repo } = createFakeRepo([makeAccount()], [rowA, rowB]);
  const { deps, upsertCalls, postCalls } = makeDeps({
    upsertContact: async (accessToken, locationId, phoneE164) => {
      upsertCalls.push({ accessToken, locationId, phoneE164 });
      // isNew flips between calls to prove the SECOND call never actually happens (memo).
      return { ok: true, contactId: "contact-memo", isNew: upsertCalls.length === 1 };
    },
  });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 2);
  assert.equal(upsertCalls.length, 1, "the SAME phone within one pass must be upserted exactly once");
  assert.equal(postCalls.length, 2);
  assert.equal(postCalls[0]?.contactId, "contact-memo");
  assert.equal(postCalls[1]?.contactId, "contact-memo");
});

// ---------------------------------------------------------------------------
// 6. Media placeholders (integration — see also the direct unit tests above)
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: a non-text reply (body=null) posts the fixed media placeholder, never an empty string", async () => {
  const row = makeRow({ body: null, messageType: "imageMessage" });
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0]?.body, "[Photo received on WhatsApp — view it on the connected phone]");
  assert.notEqual(postCalls[0]?.body, "");
  // The DB row's own body column must stay null — this module never writes it.
  assert.equal(rowsById.get(row.id)!.body, null);
});

// ---------------------------------------------------------------------------
// 7. Retry classification
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: POST 429/503 -> un-claimed, push_attempts incremented, push_error stamped, retried next pass with attempts carried", async () => {
  for (const kind of ["rate_limited", "server_error"] as const) {
    const row = makeRow({ pushAttempts: 1 });
    const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
    const { deps } = makeDeps({
      addInboundMessage: async (): Promise<AddGhlInboundMessageResult> => ({ ok: false, kind, error: `HTTP classified as ${kind}` }),
    });

    const result = await drainGhlInboundReplies(repo, deps);

    assert.equal(result.retried, 1, kind);
    const stored = rowsById.get(row.id)!;
    assert.equal(stored.processedAt, null, `${kind}: row must be UN-claimed so a later pass can retry it`);
    assert.equal(stored.pushAttempts, 2, `${kind}: attempts must carry forward from the row's existing count`);
    assert.equal(stored.pushError, `HTTP classified as ${kind}`);
    assert.equal(stored.resolution, null, `${kind}: never resolved while still retryable`);
  }
});

test("drainGhlInboundReplies: POST 400 (a definite non-429/5xx refusal) -> terminal 'ghl_rejected', row stays claimed", async () => {
  const row = makeRow();
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
  const { deps } = makeDeps({
    addInboundMessage: async (): Promise<AddGhlInboundMessageResult> => ({ ok: false, kind: "rejected", error: "GHL inbound message rejected (HTTP 400)" }),
  });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.rejected, 1);
  const stored = rowsById.get(row.id)!;
  assert.equal(stored.resolution, "ghl_rejected");
  assert.equal(stored.pushError, "GHL inbound message rejected (HTTP 400)");
  assert.notEqual(stored.processedAt, null, "a terminally rejected row stays claimed");
});

test("drainGhlInboundReplies: POST times out -> terminal 'ghl_push_uncertain', notify called exactly once, NEVER retried (at-most-once pin)", async () => {
  const row = makeRow();
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
  const { deps, notifyCalls } = makeDeps({
    addInboundMessage: async (): Promise<AddGhlInboundMessageResult> => ({ ok: false, kind: "timeout_uncertain", error: "GHL inbound message request timed out — delivery uncertain" }),
  });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.uncertain, 1);
  assert.equal(result.retried, 0, "an uncertain outcome must never be classified as retryable");
  assert.equal(notifyCalls.length, 1, "Slack must be notified exactly once");
  const stored = rowsById.get(row.id)!;
  assert.equal(stored.resolution, "ghl_push_uncertain");
  assert.notEqual(stored.processedAt, null, "stays claimed — this row must never be looked at again");

  // A second pass must never retry it — the list query only returns
  // processed_at IS NULL rows, which this row no longer is.
  const secondPass = await drainGhlInboundReplies(repo, deps);
  assert.equal(secondPass.candidates, 0, "a resolved 'ghl_push_uncertain' row must not be listed again");
});

test("drainGhlInboundReplies: a row already at the attempt cap -> terminal 'ghl_push_failed' WITHOUT any upsert or POST call", async () => {
  const row = makeRow({ pushAttempts: 5 });
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
  const { deps, upsertCalls, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.failed, 1);
  assert.equal(upsertCalls.length, 0, "an exhausted row must never attempt another contact upsert");
  assert.equal(postCalls.length, 0, "an exhausted row must never attempt another POST");
  const stored = rowsById.get(row.id)!;
  assert.equal(stored.resolution, "ghl_push_failed");
  assert.equal(stored.pushError, GHL_INBOUND_REASONS.pushExhausted);
  assert.notEqual(stored.processedAt, null, "must be claimed on the way to its terminal stamp");
});

test("drainGhlInboundReplies: a contact-upsert failure is retryable, pre-claim — row never claimed, attempts incremented", async () => {
  const row = makeRow({ pushAttempts: 0 });
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps({
    upsertContact: async (): Promise<UpsertGhlContactResult> => ({ ok: false, kind: "unreachable", error: "GHL contact upsert request failed" }),
  });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.retried, 1);
  assert.equal(postCalls.length, 0, "the message must never be posted if the contact upsert failed");
  const stored = rowsById.get(row.id)!;
  assert.equal(stored.processedAt, null, "an upsert failure happens PRE-claim — the row was never claimed to begin with");
  assert.equal(stored.pushAttempts, 1);
  assert.equal(stored.pushError, "GHL contact upsert request failed");
});

// ---------------------------------------------------------------------------
// 8. Starvation guards
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: a needs_reauth account's rows are excluded at LIST time — never even offered to the drain", async () => {
  const healthyAccount = makeAccount({ locationId: "loc-healthy", tenantId: "33333333-3333-4333-8333-333333333333", label: "Healthy" });
  const stuckAccount = makeAccount({ locationId: "loc-stuck", tenantId: "44444444-4444-4444-8444-444444444444", label: "Stuck", status: "needs_reauth" });
  const healthyRow = makeRow({ coachId: healthyAccount.tenantId });
  const stuckRow = makeRow({ coachId: stuckAccount.tenantId });
  const { repo } = createFakeRepo([healthyAccount, stuckAccount], [stuckRow, healthyRow]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.candidates, 1, "only the healthy account's row may ever be listed");
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0]?.contactId, "contact-1");
  assert.equal(result.pushed, 1);
});

test("drainGhlInboundReplies: 5 consecutive POST failures abort the pass — SAME-PHONE fixture (the contact memo means only row 0's upsert ever actually runs, so this alone does NOT exercise adversarial-review finding 2 — see the distinct-phones variant below for that)", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => makeRow({ id: `circuit-row-${i}`, createdAt: new Date(2026, 6, 1, 10, i).toISOString() }));
  const { repo, rowsById } = createFakeRepo([makeAccount()], rows);
  let postCallCount = 0;
  const { deps } = makeDeps({
    addInboundMessage: async (): Promise<AddGhlInboundMessageResult> => {
      postCallCount++;
      return { ok: false, kind: "server_error", error: "GHL inbound message rejected (HTTP 503)" };
    },
  });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(postCallCount, 5, "the pass must abort after exactly 5 consecutive GHL-call failures");
  assert.equal(result.retried, 5);

  // The remaining 2 rows were never even reached this pass.
  const untouched = rows.slice(5);
  for (const r of untouched) {
    const stored = rowsById.get(r.id)!;
    assert.equal(stored.processedAt, null, `${r.id} must be left completely unclaimed`);
    assert.equal(stored.pushAttempts, 0, `${r.id}'s attempt counter must be untouched`);
    assert.equal(stored.pushError, null, `${r.id} must have no push_error stamped`);
  }
});

test("drainGhlInboundReplies: 5 consecutive POST failures abort the pass EVEN WITH DISTINCT PHONES per row, despite every row's contact upsert succeeding in between (adversarial-review finding 2 — the self-defeating breaker; FAILS against the unfixed code, which shared one counter reset by any upsert success, so the breaker never tripped and all 7 rows got POSTed)", async () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    makeRow({ id: `circuit-distinct-row-${i}`, fromPhone: `+4477009001${String(i).padStart(2, "0")}`, createdAt: new Date(2026, 6, 1, 10, i).toISOString() })
  );
  const { repo, rowsById } = createFakeRepo([makeAccount()], rows);
  let upsertCallCount = 0;
  let postCallCount = 0;
  const { deps } = makeDeps({
    // Every row's contact upsert succeeds — a healthy, unrelated endpoint —
    // which is exactly what used to reset the shared breaker counter before
    // the row's own POST failure had a chance to accumulate against it.
    upsertContact: async (): Promise<UpsertGhlContactResult> => {
      upsertCallCount++;
      return { ok: true, contactId: `contact-${upsertCallCount}`, isNew: true };
    },
    addInboundMessage: async (): Promise<AddGhlInboundMessageResult> => {
      postCallCount++;
      return { ok: false, kind: "server_error", error: "GHL inbound message rejected (HTTP 503)" };
    },
  });

  const result = await drainGhlInboundReplies(repo, deps);

  // Only the 5 rows the pass actually reaches before the breaker trips get
  // an upsert call — each one is its own distinct phone, so none hit the
  // memo (contrast test 8's same-phone memo case above).
  assert.equal(upsertCallCount, 5, "each of the 5 processed rows must attempt its own upsert (no memo hit, distinct phones)");
  assert.equal(postCallCount, 5, "the pass must still abort after 5 consecutive POST failures, regardless of the healthy upserts interleaved with them");
  assert.equal(result.retried, 5);

  const untouched = rows.slice(5);
  for (const r of untouched) {
    const stored = rowsById.get(r.id)!;
    assert.equal(stored.processedAt, null, `${r.id} must be left completely unclaimed`);
    assert.equal(stored.pushAttempts, 0, `${r.id}'s attempt counter must be untouched`);
  }
});

// ---------------------------------------------------------------------------
// 9. Token paths
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: a needs_reauth account's rows never even reach a token-resolution decision — pinning that finding-3's nuance doesn't resurrect here", async () => {
  // Deliberately give the needs_reauth account a STILL-VALID access token
  // (exactly finding 3's fixture shape) — Phase 2's resolveGhlAccessToken
  // would happily use it. Phase 3 never gets the chance: the row is
  // excluded at LIST time (see test 8's first case), so resolveGhlAccessToken
  // is never even called for it.
  const account = makeAccount({ status: "needs_reauth", accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const { repo, calls } = createFakeRepo([account], [makeRow()]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.candidates, 0);
  assert.equal(postCalls.length, 0);
  assert.equal(calls.filter((c) => c.method === "getGhlAccountByTenantId").length, 0, "the row was never listed, so its account is never even looked up");
});

test("drainGhlInboundReplies: an expiring access token is refreshed via the shared single-flight resolveGhlAccessToken before the push", async () => {
  const account = makeAccount({ accessToken: "stale-token", accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const row = makeRow();
  const { repo, rowsById, calls } = createFakeRepo([account], [row]);
  const { deps, postCalls } = makeDeps({
    refreshToken: async () => ({
      ok: true,
      tokens: { accessToken: "fresh-token", refreshToken: "refresh-token-1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), locationId: null, companyId: null },
    }),
  });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  assert.equal(postCalls[0]?.accessToken, "fresh-token");
  assert.ok(calls.some((c) => c.method === "saveGhlTokens"), "the refreshed token must be persisted via the SAME single-flight path Phase 2 uses");
  assert.equal(rowsById.get(row.id)!.resolution, "ghl_pushed");
});

// ---------------------------------------------------------------------------
// 10. Never-throws
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: a repo method throwing mid-row never crashes the batch — the row is counted retried, later rows still process", async () => {
  const rowA = makeRow({ id: "throws-row" });
  const rowB = makeRow({ id: "ok-row", createdAt: new Date(2026, 6, 1, 10, 5).toISOString() });
  const { repo, rowsById } = createFakeRepo([makeAccount()], [rowA, rowB]);
  const throwingRepo: GhlInboundRepo = {
    ...repo,
    claimWhatsappInboundMessage: async (id: string) => {
      if (id === "throws-row") throw new Error("simulated repo failure");
      return repo.claimWhatsappInboundMessage(id);
    },
  };
  const { deps } = makeDeps();

  let result: Awaited<ReturnType<typeof drainGhlInboundReplies>> | undefined;
  await assert.doesNotReject(async () => {
    result = await drainGhlInboundReplies(throwingRepo, deps);
  });
  assert.equal(result!.candidates, 2);
  assert.equal(result!.pushed, 1, "the throwing row must not stop the well-behaved one from succeeding");
  assert.equal(rowsById.get("ok-row")!.resolution, "ghl_pushed");
});

test("drainGhlInboundReplies: the LIST call itself throwing -> an all-zero result, never an uncaught rejection", async () => {
  const { repo } = createFakeRepo([makeAccount()], [makeRow()]);
  const throwingListRepo: GhlInboundRepo = {
    ...repo,
    getUnprocessedGhlInboundMessages: async () => {
      throw new Error("simulated Supabase outage");
    },
  };
  const { deps } = makeDeps();

  let result: Awaited<ReturnType<typeof drainGhlInboundReplies>> | undefined;
  await assert.doesNotReject(async () => {
    result = await drainGhlInboundReplies(throwingListRepo, deps);
  });
  assert.deepEqual(result, {
    candidates: 0,
    pushed: 0,
    rejected: 0,
    failed: 0,
    uncertain: 0,
    retried: 0,
    claimLost: 0,
    groupNotEnabled: 0,
    staleMissedCalls: 0,
    optedOut: 0,
    optedIn: 0,
    blockedUnconfigured: false,
  });
});

// ---------------------------------------------------------------------------
// 11. Ordering
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: three rows, oldest-first fixture -> POST call order matches created_at order", async () => {
  const rowOldest = makeRow({ id: "row-oldest", fromPhone: "+447700900001", body: "first", createdAt: "2026-08-01T09:00:00.000Z" });
  const rowMiddle = makeRow({ id: "row-middle", fromPhone: "+447700900002", body: "second", createdAt: "2026-08-01T09:00:05.000Z" });
  const rowNewest = makeRow({ id: "row-newest", fromPhone: "+447700900003", body: "third", createdAt: "2026-08-01T09:00:10.000Z" });
  // Constructed out of order deliberately — the fake repo's own list method
  // sorts by created_at, exactly mirroring the real SQL `order by created_at
  // asc`.
  const { repo } = createFakeRepo([makeAccount()], [rowNewest, rowOldest, rowMiddle]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.deepEqual(postCalls.map((c) => c.body), ["first", "second", "third"]);
});

// ---------------------------------------------------------------------------
// 12. Media plan (docs/MEDIA-PLAN.md §6.2) — the `resolveMediaAttachment`
// branches inside `processGhlInboundRow`. Every scenario here has
// `body: null` (a non-text reply) so the media path is actually exercised.
// ---------------------------------------------------------------------------

test("drainGhlInboundReplies: a media_status='stored' row -> signed URL minted, attachments passed, fixed short label (no 'view on phone' tail)", async () => {
  const row = makeRow({ body: null, messageType: "imageMessage", mediaStatus: "stored", mediaPath: "tenant-1/WAMSG1.jpg" });
  const { repo, calls } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0]?.body, "Photo received on WhatsApp");
  assert.deepEqual((postCalls[0] as unknown as { attachments?: string[] }).attachments, [
    "https://storage.example.supabase.co/object/sign/wa-media/tenant-1/WAMSG1.jpg?token=fake",
  ]);
  assert.ok(calls.some((c) => c.method === "createWhatsappMediaSignedUrl" && c.args[0] === "tenant-1/WAMSG1.jpg"));
});

test("drainGhlInboundReplies: a media_status='stored' row whose signing FAILS degrades to the ordinary placeholder — never blocks the row", async () => {
  const row = makeRow({ body: null, messageType: "videoMessage", mediaStatus: "stored", mediaPath: "SIGN-FAILS/tenant-1/WAMSG2.mp4" });
  const { repo } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  assert.equal(postCalls[0]?.body, "[Video received on WhatsApp — view it on the connected phone]");
  assert.equal((postCalls[0] as unknown as { attachments?: string[] }).attachments, undefined);
});

test("drainGhlInboundReplies: a media_status='too_large' row posts the specific over-cap wording, no attachments, no signed-URL call", async () => {
  const row = makeRow({ body: null, messageType: "videoMessage", mediaStatus: "too_large" });
  const { repo, calls } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  assert.equal(postCalls[0]?.body, "[Video received on WhatsApp (too large to transfer — view it on the connected phone)]");
  assert.equal(calls.some((c) => c.method === "createWhatsappMediaSignedUrl"), false);
});

test("drainGhlInboundReplies: media_status='rate_limited'/'failed' rows fall back to the ordinary Q6 placeholder, exactly like a media-disabled row", async () => {
  for (const status of ["rate_limited", "failed"] as const) {
    const row = makeRow({ body: null, messageType: "audioMessage", mediaStatus: status });
    const { repo } = createFakeRepo([makeAccount()], [row]);
    const { deps, postCalls } = makeDeps();
    await drainGhlInboundReplies(repo, deps);
    assert.equal(postCalls[0]?.body, "[Voice note received on WhatsApp — view it on the connected phone]", status);
  }
});

test("drainGhlInboundReplies: a STALE 'pending' row (reaching this drain at all implies it's past the list-level freshness fence) is treated exactly like 'failed' — the ordinary placeholder, never left unresolved", async () => {
  const row = makeRow({ body: null, messageType: "documentMessage", mediaStatus: "pending" });
  const { repo } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();
  const result = await drainGhlInboundReplies(repo, deps);
  assert.equal(result.pushed, 1);
  assert.equal(postCalls[0]?.body, "[Document received on WhatsApp — view it on the connected phone]");
});

test("drainGhlInboundReplies: FLAGS-OFF REGRESSION — a row with mediaStatus null/undefined (media capture never applicable) behaves BYTE-IDENTICAL to the pre-media-plan suite: the exact Q6 placeholder, no attachments field at all, no signed-URL call", async () => {
  const row = makeRow({ body: null, messageType: "imageMessage" }); // mediaStatus stays null via makeRow's own default
  const { repo, calls } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  assert.equal(postCalls[0]?.body, "[Photo received on WhatsApp — view it on the connected phone]");
  assert.equal((postCalls[0] as unknown as { attachments?: string[] }).attachments, undefined);
  assert.equal(calls.some((c) => c.method === "createWhatsappMediaSignedUrl"), false, "a media-inapplicable row must never even attempt to mint a signed URL");
});

test("describeStoredMediaLabel / describeTooLargeMediaPlaceholder — pure, direct tests", async () => {
  const { describeStoredMediaLabel, describeTooLargeMediaPlaceholder } = await import("@/lib/ghl");
  assert.equal(describeStoredMediaLabel("imageMessage"), "Photo received on WhatsApp");
  assert.equal(describeStoredMediaLabel("documentMessage"), "Document received on WhatsApp");
  assert.equal(describeStoredMediaLabel("someFutureType"), "File received on WhatsApp");
  assert.equal(describeTooLargeMediaPlaceholder("videoMessage"), "[Video received on WhatsApp (too large to transfer — view it on the connected phone)]");
  assert.equal(
    describeTooLargeMediaPlaceholder("imageMessage"),
    "[Photo received on WhatsApp (too large to transfer — view it on the connected phone)]"
  );
});

// ---------------------------------------------------------------------------
// Multiple numbers per location (Task 3) — stickiness + the inbound prefix.
// ---------------------------------------------------------------------------

const SECOND_TENANT_ID = "33333333-3333-4333-8333-333333333333";

/** Slot 1 (the account's own tenant) is the unlabelled default; slot 2 is labelled "Sales". */
const TWO_NUMBERS: Record<string, LocationNumber[]> = {
  [LOCATION_ID]: [
    { tenantId: TENANT_ID, slot: 1, isDefault: true, label: null },
    { tenantId: SECOND_TENANT_ID, slot: 2, isDefault: false, label: "Sales" },
  ],
};

test("drainGhlInboundReplies: after a successful push, stickiness is recorded with the ROW's tenant (not the account's default) and its received_at", async () => {
  const row = makeRow({ coachId: SECOND_TENANT_ID, receivedAt: "2026-08-01T09:00:00.000Z" });
  const { repo, calls, sticky } = createFakeRepo([makeAccount()], [row], TWO_NUMBERS);
  const { deps } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  const recorded = calls.filter((c) => c.method === "recordInboundForStickiness");
  assert.deepEqual(recorded.map((c) => c.args), [[LOCATION_ID, "contact-1", SECOND_TENANT_ID, "2026-08-01T09:00:00.000Z"]]);
  assert.deepEqual(sticky.get(`${LOCATION_ID}:contact-1`), { tenantId: SECOND_TENANT_ID, lastInboundAt: "2026-08-01T09:00:00.000Z" });
});

test("drainGhlInboundReplies: stickiness is never recorded for a push that did not land", async () => {
  const { repo, calls } = createFakeRepo([makeAccount()], [makeRow()], TWO_NUMBERS);
  const { deps } = makeDeps({ addInboundMessage: async () => ({ ok: false, kind: "rejected", error: "GHL inbound message rejected (HTTP 400)" }) });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.rejected, 1);
  assert.equal(calls.filter((c) => c.method === "recordInboundForStickiness").length, 0);
});

test("drainGhlInboundReplies: an OLDER row drained after a newer one never overwrites the newer sticky number (Review Focus 3)", async () => {
  // Drained oldest-created first, but the second-created row carries the
  // EARLIER received_at — the out-of-order shape a replayed/late row has.
  const newer = makeRow({ coachId: SECOND_TENANT_ID, receivedAt: "2026-08-01T10:00:00.000Z", createdAt: "2026-08-01T10:00:01.000Z" });
  const older = makeRow({ coachId: TENANT_ID, receivedAt: "2026-08-01T09:00:00.000Z", createdAt: "2026-08-01T10:00:02.000Z" });
  const { repo, sticky } = createFakeRepo([makeAccount()], [newer, older], TWO_NUMBERS);
  const { deps } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 2);
  assert.deepEqual(sticky.get(`${LOCATION_ID}:contact-1`), { tenantId: SECOND_TENANT_ID, lastInboundAt: "2026-08-01T10:00:00.000Z" });
});

test("drainGhlInboundReplies: a stickiness write that throws never un-pushes the reply — the row stays 'ghl_pushed'", async () => {
  const row = makeRow({ coachId: SECOND_TENANT_ID });
  const { repo, rowsById } = createFakeRepo([makeAccount()], [row], TWO_NUMBERS);
  const throwingSticky: GhlInboundRepo = {
    ...repo,
    recordInboundForStickiness: async () => {
      throw new Error("simulated Supabase error");
    },
  };
  const { deps, postCalls } = makeDeps();
  // Captured, not printed — keeps the suite output pristine and pins that the
  // failure is logged rather than swallowed silently.
  const errors: unknown[][] = [];
  const realConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  let result: Awaited<ReturnType<typeof drainGhlInboundReplies>>;
  try {
    result = await drainGhlInboundReplies(throwingSticky, deps);
  } finally {
    console.error = realConsoleError;
  }

  assert.equal(result.pushed, 1);
  assert.equal(result.retried, 0);
  assert.equal(postCalls.length, 1);
  assert.equal(rowsById.get(row.id)!.resolution, "ghl_pushed");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /pushed, but recording the contact's sticky number failed/);
});

test("drainGhlInboundReplies: the location's number list is read once per location per pass, not once per row", async () => {
  const rows = [makeRow({ coachId: SECOND_TENANT_ID }), makeRow({ coachId: TENANT_ID }), makeRow({ coachId: SECOND_TENANT_ID })];
  const { repo, calls } = createFakeRepo([makeAccount()], rows, TWO_NUMBERS);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls.length, 3);
  assert.equal(calls.filter((c) => c.method === "listLocationNumbers").length, 1);
});

test("drainGhlInboundReplies: with more than one number, the GHL body is prefixed '[<label>] ' or '[Number <slot>] '", async () => {
  const labelled = makeRow({ coachId: SECOND_TENANT_ID, body: "hi from the sales line" });
  const unlabelled = makeRow({ coachId: TENANT_ID, body: "hi from the main line" });
  const { repo } = createFakeRepo([makeAccount()], [labelled, unlabelled], TWO_NUMBERS);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.deepEqual(postCalls.map((c) => c.body), ["[Sales] hi from the sales line", "[Number 1] hi from the main line"]);
});

test("drainGhlInboundReplies: with more than one number, a media placeholder body is prefixed too", async () => {
  const row = makeRow({ coachId: SECOND_TENANT_ID, body: null, messageType: "imageMessage" });
  const { repo } = createFakeRepo([makeAccount()], [row], TWO_NUMBERS);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls[0]?.body, `[Sales] ${describeInboundMediaPlaceholder("imageMessage")}`);
});

test("drainGhlInboundReplies: with one number, the GHL body is never prefixed (even when that number has a label)", async () => {
  const numbers = { [LOCATION_ID]: [{ tenantId: TENANT_ID, slot: 1 as const, isDefault: true, label: "Main" }] };
  const { repo } = createFakeRepo([makeAccount()], [makeRow({ body: "plain" })], numbers);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls[0]?.body, "plain");
});

// ---------------------------------------------------------------------------
// Opt-in WhatsApp groups (Task 8): a group row posts into ONE GHL contact
// standing for the group, prefixed with the sender; senders are never
// contacts; a group that is unknown or switched off never reaches GHL.
// ---------------------------------------------------------------------------

const GROUP_JID = "120363012345678901@g.us";

function makeGroup(overrides: Partial<WhatsappGroup> = {}): WhatsappGroup {
  return { tenantId: TENANT_ID, groupJid: GROUP_JID, name: "Run Club", enabled: true, ghlContactId: null, leftAt: null, createdByUs: false, ...overrides };
}

function makeGroupRow(overrides: Partial<WhatsappInboundMessage> = {}): WhatsappInboundMessage {
  return makeRow({ groupJid: GROUP_JID, senderName: "Jane", fromPhone: "+447700900555", body: "hello", ...overrides });
}

test("drainGhlInboundReplies (groups): the first row creates the group contact once and stores it before posting; a second row reuses it", async () => {
  const rows = [makeGroupRow({ body: "hello" }), makeGroupRow({ body: "second", senderName: "Sam" })];
  const { repo, calls, groupsByKey, rowsById } = createFakeRepo([makeAccount()], rows, {}, [makeGroup()]);
  const { deps, groupUpsertCalls, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 2);
  assert.deepEqual(groupUpsertCalls, [
    { accessToken: "access-token-fresh", locationId: LOCATION_ID, name: "Run Club", groupKey: `120363012345678901-${createHash("sha256").update(TENANT_ID).digest("hex").slice(0, 8)}` },
  ]);
  assert.equal(groupsByKey.get(`${TENANT_ID}:${GROUP_JID}`)!.ghlContactId, "group-contact-1");
  const storeIndex = calls.findIndex((c) => c.method === "setWhatsappGroupContact");
  const firstClaimIndex = calls.findIndex((c) => c.method === "claimWhatsappInboundMessage");
  assert.ok(storeIndex >= 0 && storeIndex < firstClaimIndex, "the group contact is stored before the row is claimed and posted");
  assert.deepEqual(calls[storeIndex].args, [TENANT_ID, GROUP_JID, "group-contact-1"]);
  assert.deepEqual(postCalls.map((c) => [c.contactId, c.body]), [
    ["group-contact-1", "Jane: hello"],
    ["group-contact-1", "Sam: second"],
  ]);
  assert.ok([...rowsById.values()].every((r) => r.resolution === "ghl_pushed"));
});

test("drainGhlInboundReplies (groups): a group that already has a GHL contact reuses it — no contact call at all", async () => {
  const { repo, calls } = createFakeRepo([makeAccount()], [makeGroupRow()], {}, [makeGroup({ ghlContactId: "stored-group-contact" })]);
  const { deps, upsertCalls, groupUpsertCalls, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(groupUpsertCalls.length, 0);
  assert.equal(upsertCalls.length, 0);
  assert.equal(calls.filter((c) => c.method === "setWhatsappGroupContact").length, 0);
  assert.equal(postCalls[0]?.contactId, "stored-group-contact");
});

test("drainGhlInboundReplies (groups): the sender prefix falls back to the sender's number when the name is null or blank", async () => {
  const rows = [makeGroupRow({ senderName: null, body: "one" }), makeGroupRow({ senderName: "   ", body: "two" }), makeGroupRow({ senderName: "  Jo  ", body: "three" })];
  const { repo } = createFakeRepo([makeAccount()], rows, {}, [makeGroup()]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.deepEqual(postCalls.map((c) => c.body), ["+447700900555: one", "+447700900555: two", "Jo: three"]);
});

test("drainGhlInboundReplies (groups): a group row never upserts the sender as a contact and never records stickiness", async () => {
  const { repo, calls } = createFakeRepo([makeAccount()], [makeGroupRow()], {}, [makeGroup()]);
  const { deps, upsertCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  assert.equal(upsertCalls.length, 0, "senders are not contacts");
  assert.equal(calls.filter((c) => c.method === "recordInboundForStickiness").length, 0);
});

test("drainGhlInboundReplies (groups): media rows use the existing media path with the same sender prefix", async () => {
  const rows = [
    makeGroupRow({ body: null, messageType: "imageMessage" }),
    makeGroupRow({ body: null, messageType: "imageMessage", mediaStatus: "stored", mediaPath: "tenant-1/WAGRP1.jpg" }),
  ];
  const { repo } = createFakeRepo([makeAccount()], rows, {}, [makeGroup()]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls[0]?.body, `Jane: ${describeInboundMediaPlaceholder("imageMessage")}`);
  assert.equal(postCalls[1]?.body, "Jane: Photo received on WhatsApp");
  assert.deepEqual((postCalls[1] as unknown as { attachments?: string[] }).attachments, [
    "https://storage.example.supabase.co/object/sign/wa-media/tenant-1/WAGRP1.jpg?token=fake",
  ]);
});

test("drainGhlInboundReplies (groups): with more than one number, the number prefix comes first — '[Sales] Jane: hello'", async () => {
  const groups = [makeGroup({ tenantId: SECOND_TENANT_ID })];
  const { repo } = createFakeRepo([makeAccount()], [makeGroupRow({ coachId: SECOND_TENANT_ID })], TWO_NUMBERS, groups);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls[0]?.body, "[Sales] Jane: hello");
});

test("drainGhlInboundReplies (groups): a disabled or unknown group never reaches GHL — resolved 'group_not_enabled' with the fixed string", async () => {
  const disabled = makeGroupRow();
  const unknown = makeGroupRow({ groupJid: "999999999999@g.us" });
  // The same JID enabled on ANOTHER tenant must not count for this row's tenant.
  const groups = [makeGroup({ enabled: false }), makeGroup({ tenantId: SECOND_TENANT_ID, groupJid: "999999999999@g.us" })];
  const { repo, rowsById } = createFakeRepo([makeAccount()], [disabled, unknown], {}, groups);
  const { deps, upsertCalls, groupUpsertCalls, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.groupNotEnabled, 2);
  assert.equal(result.pushed, 0);
  assert.equal(upsertCalls.length + groupUpsertCalls.length + postCalls.length, 0);
  for (const row of [disabled, unknown]) {
    const stored = rowsById.get(row.id)!;
    assert.notEqual(stored.processedAt, null, "claimed, so it is never listed again");
    assert.equal(stored.resolution, "group_not_enabled");
    assert.equal(stored.pushError, GHL_INBOUND_REASONS.groupNotEnabled);
  }
  assert.equal(GHL_INBOUND_REASONS.groupNotEnabled, "WhatsApp group sync is turned off for this group");
});

test("drainGhlInboundReplies (groups): a group-contact create failure is retryable pre-claim — nothing stored, nothing posted", async () => {
  const row = makeGroupRow();
  const { repo, rowsById, calls } = createFakeRepo([makeAccount()], [row], {}, [makeGroup()]);
  const { deps, postCalls } = makeDeps({
    upsertGroupContact: async () => ({ ok: false, kind: "rate_limited", error: "GHL contact upsert rejected (HTTP 429)" }),
  });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.retried, 1);
  assert.equal(postCalls.length, 0);
  assert.equal(calls.filter((c) => c.method === "setWhatsappGroupContact").length, 0);
  const stored = rowsById.get(row.id)!;
  assert.equal(stored.processedAt, null);
  assert.equal(stored.pushAttempts, 1);
  assert.equal(stored.pushError, "GHL contact upsert rejected (HTTP 429)");
});

test("drainGhlInboundReplies (groups): the tenant's group list is read once per pass, not once per row", async () => {
  const rows = [makeGroupRow(), makeGroupRow(), makeGroupRow()];
  const { repo, calls } = createFakeRepo([makeAccount()], rows, {}, [makeGroup()]);
  const { deps, groupUpsertCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(calls.filter((c) => c.method === "listWhatsappGroups").length, 1);
  assert.equal(groupUpsertCalls.length, 1);
});

test("drainGhlInboundReplies (groups): the same group on two numbers gets one contact per number — distinct keys, each stored on its own row", async () => {
  const groups = [makeGroup(), makeGroup({ tenantId: SECOND_TENANT_ID })];
  const rows = [makeGroupRow({ body: "via main" }), makeGroupRow({ coachId: SECOND_TENANT_ID, body: "via sales" })];
  const { repo, groupsByKey } = createFakeRepo([makeAccount()], rows, TWO_NUMBERS, groups);
  let n = 0;
  const { deps, groupUpsertCalls, postCalls } = makeDeps({
    upsertGroupContact: async (accessToken, locationId, input) => {
      groupUpsertCalls.push({ accessToken, locationId, ...input });
      return { ok: true, contactId: `group-contact-${++n}`, isNew: true };
    },
  });

  await drainGhlInboundReplies(repo, deps);

  assert.equal(groupUpsertCalls.length, 2);
  assert.notEqual(groupUpsertCalls[0].groupKey, groupUpsertCalls[1].groupKey);
  assert.equal(groupsByKey.get(`${TENANT_ID}:${GROUP_JID}`)!.ghlContactId, "group-contact-1");
  assert.equal(groupsByKey.get(`${SECOND_TENANT_ID}:${GROUP_JID}`)!.ghlContactId, "group-contact-2");
  assert.deepEqual(postCalls.map((c) => c.contactId), ["group-contact-1", "group-contact-2"]);
});

// ---------------------------------------------------------------------------
// 11. STOP / START opt-outs (reliability T9)
// ---------------------------------------------------------------------------

const PHONE = "+447700900123";
const OTHER_TENANT_ID = "33333333-3333-4333-8333-333333333333";

test("STOP reply: opt-out recorded for (tenant, phone) with keyword STOP, reply still pushed to GHL", async () => {
  const row = makeRow({ body: "STOP" });
  const { repo, rowsById, optOuts } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.deepEqual(optOuts.get(`${TENANT_ID}:${PHONE}`), { keyword: "STOP", ghlContactId: null });
  assert.equal(result.optedOut, 1);
  assert.equal(result.optedIn, 0);
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0]?.body, "STOP");
  assert.equal(rowsById.get(row.id)!.resolution, "ghl_pushed");
});

test("START after STOP clears the opt-out; a later 'stop' re-records it (final state opted out), all three rows pushed", async () => {
  const rows = [
    makeRow({ body: "STOP", createdAt: new Date(2026, 6, 1, 10, 0).toISOString() }),
    makeRow({ body: "START", createdAt: new Date(2026, 6, 1, 10, 1).toISOString() }),
    makeRow({ body: "stop", createdAt: new Date(2026, 6, 1, 10, 2).toISOString() }),
  ];
  const { repo, optOuts, calls } = createFakeRepo([makeAccount()], rows);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(optOuts.get(`${TENANT_ID}:${PHONE}`)?.keyword, "STOP");
  assert.deepEqual(
    calls.filter((c) => c.method === "recordOptOut" || c.method === "clearOptOut").map((c) => c.method),
    ["recordOptOut", "clearOptOut", "recordOptOut"]
  );
  assert.equal(result.optedOut, 2);
  assert.equal(result.optedIn, 1);
  assert.equal(result.pushed, 3);
  assert.equal(postCalls.length, 3);
});

test("STOP for tenant A does not opt the phone out on tenant B", async () => {
  const row = makeRow({ body: "STOP" });
  const { repo, optOuts } = createFakeRepo([makeAccount()], [row]);
  const { deps } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(optOuts.has(`${TENANT_ID}:${PHONE}`), true);
  assert.equal(optOuts.has(`${OTHER_TENANT_ID}:${PHONE}`), false);
});

test("non-keyword reply writes nothing to opt-outs", async () => {
  const rows = [makeRow({ body: "please stop calling me" }), makeRow({ body: "cancel" }), makeRow({ body: null, messageType: "imageMessage" })];
  const { repo, calls, optOuts } = createFakeRepo([makeAccount()], rows);
  const { deps } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(optOuts.size, 0);
  assert.equal(calls.some((c) => c.method === "recordOptOut" || c.method === "clearOptOut"), false);
  assert.equal(result.optedOut, 0);
  assert.equal(result.optedIn, 0);
});

test("opt-out is recorded even when the GHL push later fails (ordering: before upsert/claim)", async () => {
  const row = makeRow({ body: "STOP" });
  const { repo, optOuts } = createFakeRepo([makeAccount()], [row]);
  const { deps } = makeDeps({ upsertContact: async () => ({ ok: false, kind: "unreachable", error: "GHL contact upsert failed (HTTP 503)" }) });

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.retried, 1);
  assert.equal(optOuts.get(`${TENANT_ID}:${PHONE}`)?.keyword, "STOP");
});

// ---------------------------------------------------------------------------
// T10 — optional GHL DND sync (GHL_SYNC_DND, off by default)
// ---------------------------------------------------------------------------
type DndCall = { accessToken: string; contactId: string; dnd: boolean };
function withDnd(flag: string | undefined, overrides: Partial<GhlInboundDeps> = {}) {
  const dndCalls: DndCall[] = [];
  const made = makeDeps({
    setContactDnd: async (accessToken, contactId, dnd) => {
      dndCalls.push({ accessToken, contactId, dnd });
      return { ok: true };
    },
    ...overrides,
  });
  if (flag === undefined) delete process.env.GHL_SYNC_DND;
  else process.env.GHL_SYNC_DND = flag;
  return { ...made, dndCalls };
}
const savedDndFlag = process.env.GHL_SYNC_DND;
afterEach(() => {
  if (savedDndFlag === undefined) delete process.env.GHL_SYNC_DND;
  else process.env.GHL_SYNC_DND = savedDndFlag;
});

test("DND sync on: STOP sets DND once with the upserted contact id", async () => {
  const { repo, optOuts } = createFakeRepo([makeAccount()], [makeRow({ body: "STOP" })]);
  const { deps, dndCalls } = withDnd("true");
  await drainGhlInboundReplies(repo, deps);
  assert.equal(dndCalls.length, 1);
  assert.equal(dndCalls[0]!.contactId, "contact-1");
  assert.equal(dndCalls[0]!.dnd, true);
  assert.equal(optOuts.get(`${TENANT_ID}:${PHONE}`)?.ghlContactId, "contact-1");
});

test("DND sync on: START clears DND", async () => {
  const { repo } = createFakeRepo([makeAccount()], [makeRow({ body: "START" })]);
  const { deps, dndCalls } = withDnd("true");
  await drainGhlInboundReplies(repo, deps);
  assert.deepEqual(dndCalls.map((c) => c.dnd), [false]);
});

test("DND sync on: an ordinary message makes no DND call", async () => {
  const { repo } = createFakeRepo([makeAccount()], [makeRow({ body: "hello there" })]);
  const { deps, dndCalls } = withDnd("true");
  await drainGhlInboundReplies(repo, deps);
  assert.equal(dndCalls.length, 0);
});

test("DND sync off (unset, and 'false'): never called", async () => {
  for (const flag of [undefined, "false"]) {
    const { repo } = createFakeRepo([makeAccount()], [makeRow({ body: "STOP" })]);
    const { deps, dndCalls } = withDnd(flag);
    await drainGhlInboundReplies(repo, deps);
    assert.equal(dndCalls.length, 0);
  }
});

test("DND sync on: a failing or throwing DND call does not change resolution and logs once", async () => {
  for (const impl of [
    async () => ({ ok: false as const, error: "dnd update rejected: HTTP 500" }),
    async (): Promise<never> => {
      throw new Error("boom");
    },
  ]) {
    const row = makeRow({ body: "STOP" });
    const { repo, rowsById, optOuts } = createFakeRepo([makeAccount()], [row]);
    const { deps } = withDnd("true", { setContactDnd: impl });
    const logged: unknown[][] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      await drainGhlInboundReplies(repo, deps);
    } finally {
      console.error = realErr;
    }
    assert.equal(rowsById.get(row.id)!.resolution, "ghl_pushed");
    assert.ok(optOuts.has(`${TENANT_ID}:${PHONE}`));
    assert.equal(logged.length, 1);
    assert.equal(JSON.stringify(logged).includes("access-token-fresh"), false);
  }
});

// ---------------------------------------------------------------------------
// Merge: STOP/START with several numbers and groups
// ---------------------------------------------------------------------------

test("merge: a member typing STOP in an enabled group records no opt-out (the group is opt-in by the owner)", async () => {
  const { repo, optOuts, calls } = createFakeRepo([makeAccount()], [makeGroupRow({ body: "STOP" })], {}, [makeGroup()]);
  const { deps } = makeDeps();
  const result = await drainGhlInboundReplies(repo, deps);
  assert.equal(result.optedOut, 0);
  assert.equal(optOuts.size, 0);
  assert.equal(calls.some((c) => c.method === "recordOptOut"), false);
});

test("merge: START on one number clears the contact's opt-out on every number of the location", async () => {
  const { repo, optOuts } = createFakeRepo([makeAccount()], [makeRow({ coachId: SECOND_TENANT_ID, body: "START" })], TWO_NUMBERS);
  optOuts.set(`${TENANT_ID}:${PHONE}`, { keyword: "STOP", ghlContactId: null });
  optOuts.set(`${SECOND_TENANT_ID}:${PHONE}`, { keyword: "STOP", ghlContactId: null });
  const { deps } = makeDeps();
  const result = await drainGhlInboundReplies(repo, deps);
  assert.equal(result.optedIn, 1);
  assert.equal(optOuts.size, 0);
});

// ---------------------------------------------------------------------------
// Missed WhatsApp calls — fixed strings, no media path, no STOP handling.
// ---------------------------------------------------------------------------

/** A receivedAt well inside the 6-hour missed-call window. */
function freshIso(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

test("describeMissedCall: video -> video text, anything else -> voice text", () => {
  assert.equal(MISSED_VOICE_CALL_TEXT, "📞 Missed WhatsApp call");
  assert.equal(MISSED_VIDEO_CALL_TEXT, "📞 Missed WhatsApp video call");
  assert.equal(describeMissedCall("missedVideoCall"), MISSED_VIDEO_CALL_TEXT);
  assert.equal(describeMissedCall("missedVoiceCall"), MISSED_VOICE_CALL_TEXT);
  assert.equal(describeMissedCall("something-else"), MISSED_VOICE_CALL_TEXT);
});

test("missed voice call posts \"📞 Missed WhatsApp call\" (exact body, no attachments)", async () => {
  const row = makeRow({ body: null, messageType: "missedVoiceCall", eventKind: "missed_call", receivedAt: freshIso() });
  const { repo } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.pushed, 1);
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0]?.body, "📞 Missed WhatsApp call");
  assert.equal((postCalls[0] as unknown as { attachments?: string[] }).attachments, undefined);
});

test("missed voice call on a multi-number location keeps the number prefix", async () => {
  const labelled = makeRow({ coachId: SECOND_TENANT_ID, body: null, messageType: "missedVoiceCall", eventKind: "missed_call", receivedAt: freshIso() });
  const unlabelled = makeRow({ coachId: TENANT_ID, body: null, messageType: "missedVoiceCall", eventKind: "missed_call", receivedAt: freshIso() });
  const { repo } = createFakeRepo([makeAccount()], [labelled, unlabelled], TWO_NUMBERS);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.deepEqual(postCalls.map((c) => c.body), ["[Sales] 📞 Missed WhatsApp call", "[Number 1] 📞 Missed WhatsApp call"]);
});

test("missed video call posts the video string", async () => {
  const row = makeRow({ body: null, messageType: "missedVideoCall", eventKind: "missed_call", receivedAt: freshIso() });
  const { repo } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls[0]?.body, "📞 Missed WhatsApp video call");
});

test("missed call skips media resolution", async () => {
  const row = makeRow({
    body: null,
    messageType: "missedVoiceCall",
    eventKind: "missed_call", receivedAt: freshIso(),
    mediaStatus: "stored",
    mediaPath: "tenant-1/WAMSG1.jpg",
  });
  const { repo, calls } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls[0]?.body, "📞 Missed WhatsApp call");
  assert.equal(calls.some((c) => c.method === "createWhatsappMediaSignedUrl"), false);
});

test("missed call is not treated as a STOP keyword", async () => {
  // Even if a body were somehow present, an event row never reaches the opt-out classifier.
  const row = makeRow({ body: "STOP", messageType: "missedVoiceCall", eventKind: "missed_call", receivedAt: freshIso() });
  const { repo, optOuts } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(optOuts.size, 0);
  assert.equal(result.optedOut, 0);
  assert.equal(postCalls[0]?.body, "📞 Missed WhatsApp call");
});

test("a row with eventKind null is unchanged", async () => {
  const row = makeRow({ body: "hello", eventKind: null });
  const { repo } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  await drainGhlInboundReplies(repo, deps);

  assert.equal(postCalls[0]?.body, "hello");
});

test("a missed call older than 6 hours is resolved as missed_call_stale without posting", async () => {
  const stale = makeRow({ body: null, messageType: "missedVoiceCall", eventKind: "missed_call", receivedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() });
  const fresh = makeRow({ body: null, messageType: "missedVoiceCall", eventKind: "missed_call", receivedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() });
  const { repo, calls } = createFakeRepo([makeAccount()], [stale, fresh]);
  const { deps, upsertCalls, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(MISSED_CALL_STALE_MS, 6 * 60 * 60 * 1000);
  assert.equal(MISSED_CALL_STALE_RESOLUTION, "missed_call_stale");
  assert.equal(result.staleMissedCalls, 1);
  assert.equal(result.pushed, 1, "the 5-hour-old call is still posted");
  assert.equal(postCalls.length, 1);
  assert.equal(upsertCalls.length, 1, "no contact upsert for the stale row");
  assert.ok(calls.some((c) => c.method === "claimWhatsappInboundMessage" && c.args[0] === stale.id), "claimed so it is never listed again");
  const resolutions = calls.filter((c) => c.method === "resolveGhlInboundMessage").map((c) => c.args);
  assert.deepEqual(resolutions[0], [stale.id, { resolution: "missed_call_stale", pushError: null }]);
  assert.deepEqual(resolutions[1], [fresh.id, { resolution: "ghl_pushed", pushError: null }]);
});

test("an old ordinary message is still posted (the stale rule is for missed calls only)", async () => {
  const row = makeRow({ body: "hello", eventKind: null, receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
  const { repo } = createFakeRepo([makeAccount()], [row]);
  const { deps, postCalls } = makeDeps();

  const result = await drainGhlInboundReplies(repo, deps);

  assert.equal(result.staleMissedCalls, 0);
  assert.equal(postCalls.length, 1);
});

test("hasInboundFromPhone (portal): a missed call doesn't count as having messaged us", () => {
  const src = readFileSync(new URL("../../src/lib/data/supabase.ts", import.meta.url), "utf8");
  const start = src.indexOf("async hasInboundFromPhone(");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  assert.match(body, /\.is\("group_jid", null\)/);
  assert.match(body, /\.is\("event_kind", null\)/);
});
