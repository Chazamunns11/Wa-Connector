/**
 * Several WhatsApp numbers per GHL location (Task 4): the embed and
 * connect-link routes address a number by SLOT (1-3), never by tenant id.
 * Covers the pure slot/label parsers (src/lib/location-numbers.ts), the
 * slot step of the embed guard (src/app/api/crm/embed/guard.ts), the embed
 * numbers route's decision logic (src/app/api/crm/embed/numbers/logic.ts)
 * and the shared bridge-response choke point (src/lib/bridge-panel-guard.ts).
 *
 * THE TENANT ID IS NEVER RETURNED: every test that builds a response body
 * serialises it and searches the JSON for the fake tenant uuids below. A
 * structural check (`Object.keys`) would miss a tenant id riding inside a
 * nested object or a free-form message; a substring search of the wire
 * format does not.
 *
 * Entirely offline: fake repos, fake bridge logout, no Supabase, no Next.
 */
process.env.ONBOARD_STATE_SECRET ||= "test-secret-not-used-anywhere-real";
process.env.GHL_SSO_SHARED_SECRET ||= "test-sso-secret-not-used-anywhere-real";
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test.supabase.example";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key-not-used-anywhere-real";

import test from "node:test";
import assert from "node:assert/strict";

import { mintGhlEmbedToken } from "@/lib/ghl-embed";
import { parseLabelInput, parseSlotParam } from "@/lib/location-numbers";
import {
  authorizeGhlEmbedLocationRequest,
  authorizeGhlEmbedRequest,
  guardFailureResponseBody,
  requestedSlotFromBody,
  type GhlEmbedGuardRepo,
} from "@/app/api/crm/embed/guard";
import {
  decideAddNumber,
  decideRemoveNumber,
  decideUpdateNumber,
  listEmbedNumbers,
  type EmbedNumbersRepo,
} from "@/app/api/crm/embed/numbers/logic";
import { MAX_PANEL_BODY_BYTES, readSmallJsonBody, toPanelBridgeResponse } from "@/lib/bridge-panel-guard";
import type { Account, GhlAccount, LocationNumber, WhatsappSessionSummary } from "@/lib/types";
import type { BridgeOkResult } from "@/lib/whatsapp-bridge";

const LOCATION_ID = "loc-numbers-1";
const TENANT_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const TENANT_2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const TENANT_3 = "33333333-cccc-4ccc-8ccc-333333333333";
const NEW_TENANT = "44444444-dddd-4ddd-8ddd-444444444444";
const ALL_TENANTS = [TENANT_1, TENANT_2, TENANT_3, NEW_TENANT];

const UNKNOWN_NUMBER_MESSAGE = "That WhatsApp number isn't set up on this sub-account.";
const INVALID_SLOT_MESSAGE = "That WhatsApp number isn't valid.";
const LIMIT_MESSAGE = "This sub-account already has 3 WhatsApp numbers.";

function assertNoTenantId(value: unknown, context: string) {
  const json = JSON.stringify(value);
  for (const tenantId of ALL_TENANTS) {
    assert.ok(!json.includes(tenantId), `${context}: response JSON must never contain a tenant id (found ${tenantId}) in ${json}`);
  }
}

function makeAccount(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: LOCATION_ID,
    tenantId: TENANT_1,
    label: "Numbers Test Location",
    companyId: null,
    conversationProviderId: null,
    accessToken: "access-token",
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshToken: "refresh-token",
    status: "active",
    lastError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    connectLinkVersion: 0,
    brandLogoPath: null,
    brandAccentColor: null,
    ...overrides,
  };
}

function summaryFor(tenantId: string): WhatsappSessionSummary {
  return {
    coachId: tenantId,
    status: "connected",
    phoneNumber: "+447700900123",
    lastConnectedAt: "2026-10-01T00:00:00.000Z",
    lastDisconnectReason: null,
    sentToday: 3,
  } as WhatsappSessionSummary;
}

// ---------------------------------------------------------------------------
// parseSlotParam / parseLabelInput
// ---------------------------------------------------------------------------

test("parseSlotParam: missing means slot 1; 1, 2 and 3 are accepted", () => {
  assert.deepEqual(parseSlotParam(undefined), { ok: true, slot: 1 });
  for (const slot of [1, 2, 3] as const) assert.deepEqual(parseSlotParam(slot), { ok: true, slot });
});

test("parseSlotParam: 0, 4, the STRING '1', a fraction, null, NaN and objects are all refused", () => {
  for (const bad of [0, 4, -1, "1", "2", 1.5, null, Number.NaN, {}, [1], true]) {
    assert.deepEqual(parseSlotParam(bad), { ok: false }, JSON.stringify(bad));
  }
});

test("parseSlotParam: required — a missing slot is refused rather than defaulting to 1", () => {
  assert.deepEqual(parseSlotParam(undefined, { required: true }), { ok: false });
  assert.deepEqual(parseSlotParam(2, { required: true }), { ok: true, slot: 2 });
});

test("parseLabelInput: trims, empty becomes null, 40 characters is the limit", () => {
  assert.deepEqual(parseLabelInput(undefined), { ok: true, label: null });
  assert.deepEqual(parseLabelInput(null), { ok: true, label: null });
  assert.deepEqual(parseLabelInput("   "), { ok: true, label: null });
  assert.deepEqual(parseLabelInput("  Sales line  "), { ok: true, label: "Sales line" });
  assert.deepEqual(parseLabelInput("x".repeat(40)), { ok: true, label: "x".repeat(40) });
  assert.deepEqual(parseLabelInput("x".repeat(41)), { ok: false });
  assert.deepEqual(parseLabelInput(42), { ok: false });
});

// ---------------------------------------------------------------------------
// The embed guard's slot step
// ---------------------------------------------------------------------------

function fakeGuardRepo(numbers: LocationNumber[], account: GhlAccount = makeAccount()): GhlEmbedGuardRepo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getGhlAccountByLocationId(locationId: string) {
      calls.push(`account:${locationId}`);
      return locationId === account.locationId ? account : null;
    },
    async getLocationNumberBySlot(locationId: string, slot: number) {
      calls.push(`number:${locationId}:${slot}`);
      if (locationId !== account.locationId) return null;
      return numbers.find((n) => n.slot === slot) ?? null;
    },
  };
}

const ONLY_SLOT_1: LocationNumber[] = [{ tenantId: TENANT_1, slot: 1, isDefault: true, label: null }];
const SLOTS_1_2: LocationNumber[] = [
  { tenantId: TENANT_1, slot: 1, isDefault: true, label: null },
  { tenantId: TENANT_2, slot: 2, isDefault: false, label: "Sales line" },
];

test("embed guard: slot 2 when only slot 1 exists -> 404 unknown_number (Review Focus 1)", async () => {
  const repo = fakeGuardRepo(ONLY_SLOT_1);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`, parseSlotParam(2));
  assert.deepEqual(result, { ok: false, status: 404, error: "unknown_number" });
  assert.deepEqual(guardFailureResponseBody(result as Exclude<typeof result, { ok: true }>), {
    ok: false,
    code: "unknown_number",
    message: UNKNOWN_NUMBER_MESSAGE,
  });
});

test("embed guard: slot 0, 4 and the string '1' -> 400 invalid_slot", async () => {
  const repo = fakeGuardRepo(SLOTS_1_2);
  const token = mintGhlEmbedToken(LOCATION_ID);
  for (const bad of [0, 4, "1"]) {
    const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`, requestedSlotFromBody({ slot: bad }));
    assert.deepEqual(result, { ok: false, status: 400, error: "invalid_slot" }, JSON.stringify(bad));
    assert.deepEqual(guardFailureResponseBody(result as Exclude<typeof result, { ok: true }>), {
      ok: false,
      code: "invalid_slot",
      message: INVALID_SLOT_MESSAGE,
    });
  }
  assert.ok(!repo.calls.some((c) => c.startsWith("number:")), "an invalid slot must never reach the number lookup");
});

test("embed guard: a malformed body (null from readSmallJsonBody) -> 400 invalid_slot", async () => {
  const repo = fakeGuardRepo(SLOTS_1_2);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`, requestedSlotFromBody(null));
  assert.deepEqual(result, { ok: false, status: 400, error: "invalid_slot" });
});

test("embed guard: ORDER HOLDS — no token with an invalid slot is still 401, and a disabled account with a bad slot is still 403", async () => {
  const repo = fakeGuardRepo(SLOTS_1_2);
  assert.deepEqual(await authorizeGhlEmbedRequest(repo, null, parseSlotParam(4)), { ok: false, status: 401, error: "missing_token" });
  const disabledRepo = fakeGuardRepo(SLOTS_1_2, makeAccount({ status: "disabled" }));
  const token = mintGhlEmbedToken(LOCATION_ID);
  assert.deepEqual(await authorizeGhlEmbedRequest(disabledRepo, `Bearer ${token}`, parseSlotParam(4)), {
    ok: false,
    status: 403,
    error: "account_disabled",
  });
});

test("embed guard: an existing slot-less call still resolves slot 1's tenant", async () => {
  const repo = fakeGuardRepo(SLOTS_1_2);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const viaDefaultParam = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`);
  const viaEmptyBody = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`, requestedSlotFromBody({}));
  for (const result of [viaDefaultParam, viaEmptyBody]) {
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.account.tenantId, TENANT_1);
      assert.equal(result.account.slot, 1);
    }
  }
});

test("embed guard: slot 2 resolves slot 2's tenant, looked up within the TOKEN's location only", async () => {
  const repo = fakeGuardRepo(SLOTS_1_2);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`, requestedSlotFromBody({ slot: 2 }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.account.tenantId, TENANT_2);
    assert.equal(result.account.slot, 2);
  }
  assert.deepEqual(repo.calls, [`account:${LOCATION_ID}`, `number:${LOCATION_ID}:2`]);
});

test("embed location guard: authorises the location without resolving (or returning) any tenant", async () => {
  const repo = fakeGuardRepo(SLOTS_1_2);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedLocationRequest(repo, `Bearer ${token}`);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.location.locationId, LOCATION_ID);
  assertNoTenantId(result, "location guard result");
  assert.ok(!repo.calls.some((c) => c.startsWith("number:")));

  assert.deepEqual(await authorizeGhlEmbedLocationRequest(repo, null), { ok: false, status: 401, error: "missing_token" });
  const disabledRepo = fakeGuardRepo(SLOTS_1_2, makeAccount({ status: "disabled" }));
  assert.deepEqual(await authorizeGhlEmbedLocationRequest(disabledRepo, `Bearer ${token}`), {
    ok: false,
    status: 403,
    error: "account_disabled",
  });
});

// ---------------------------------------------------------------------------
// toPanelBridgeResponse — the choke point every connect/status route uses
// ---------------------------------------------------------------------------

test("toPanelBridgeResponse: strips session.coachId and scrubs the tenant out of a failure message", () => {
  const ok = toPanelBridgeResponse(
    {
      ok: true,
      session: { coachId: TENANT_2, status: "waiting_qr", phoneNumber: null, qr: "qr-string", sentToday: 0, dailyCap: 50, queueLength: 0 },
    },
    TENANT_2
  );
  assertNoTenantId(ok, "ok session");
  assert.equal(ok.ok && ok.session.qr, "qr-string");

  const failure = toPanelBridgeResponse({ ok: false, code: "internal", message: `session ${TENANT_2} exploded` }, TENANT_2);
  assertNoTenantId(failure, "failure");
  assert.equal(!failure.ok && failure.code, "internal");
});

test("readSmallJsonBody: no body is {} (pre-slot clients); malformed, non-object or oversized bodies are null", async () => {
  const post = (body?: string, headers: Record<string, string> = {}) =>
    readSmallJsonBody(new Request("https://example.test/x", { method: "POST", body, headers }));
  assert.deepEqual(await post(), {});
  assert.deepEqual(await post(""), {});
  assert.deepEqual(await post(JSON.stringify({ slot: 2 })), { slot: 2 });
  assert.equal(await post("{not json"), null);
  assert.equal(await post("[1]"), null);
  assert.equal(await post("2"), null);
  assert.equal(await post(JSON.stringify({ label: "x".repeat(MAX_PANEL_BODY_BYTES) })), null);
  assert.equal(await post("{}", { "content-length": String(MAX_PANEL_BODY_BYTES + 1) }), null);
});

// ---------------------------------------------------------------------------
// The embed numbers route's decision logic
// ---------------------------------------------------------------------------

interface FakeNumbersRepo extends EmbedNumbersRepo {
  numbers: LocationNumber[];
  calls: string[];
  addResult?: "limit";
  /** Accounts and billing (merge): the location's activation and its owner's billing status. */
  activatedAt: string | null;
  billingStatus: Account["billingStatus"];
}

function fakeNumbersRepo(initial: LocationNumber[]): FakeNumbersRepo {
  const repo: FakeNumbersRepo = {
    numbers: initial.map((n) => ({ ...n })),
    calls: [],
    activatedAt: "2026-10-01T00:00:00.000Z",
    billingStatus: "active",
    async getGhlAccountByLocationId(locationId: string) {
      if (locationId !== LOCATION_ID) return null;
      return { locationId, tenantId: "t", status: "active", accountId: "acc-1", activatedAt: repo.activatedAt } as GhlAccount;
    },
    async getAccountById(id: string) {
      return { id, billingStatus: repo.billingStatus } as Account;
    },
    async listLocationNumbers(locationId: string) {
      repo.calls.push(`list:${locationId}`);
      return locationId === LOCATION_ID ? [...repo.numbers].sort((a, b) => a.slot - b.slot) : [];
    },
    async getLocationNumberBySlot(locationId: string, slot: number) {
      repo.calls.push(`get:${slot}`);
      return locationId === LOCATION_ID ? (repo.numbers.find((n) => n.slot === slot) ?? null) : null;
    },
    async addLocationNumber(locationId: string, label: string | null) {
      repo.calls.push(`add:${label}`);
      if (repo.addResult === "limit" || repo.numbers.length >= 3) return { ok: false as const, reason: "limit" as const };
      const used = repo.numbers.map((n) => n.slot);
      const slot = ([1, 2, 3] as const).find((s) => !used.includes(s))!;
      const number: LocationNumber = { tenantId: NEW_TENANT, slot, isDefault: repo.numbers.length === 0, label };
      repo.numbers.push(number);
      return { ok: true as const, number };
    },
    async removeLocationNumber(locationId: string, slot: number) {
      repo.calls.push(`remove:${slot}`);
      const target = repo.numbers.find((n) => n.slot === slot);
      if (!target) return { ok: false as const, reason: "not_found" as const };
      if (repo.numbers.length <= 1) return { ok: false as const, reason: "last_number" as const };
      repo.numbers = repo.numbers.filter((n) => n.slot !== slot);
      if (target.isDefault) repo.numbers[0].isDefault = true;
      return { ok: true as const, removedTenantId: target.tenantId };
    },
    async setDefaultLocationNumber(locationId: string, slot: number) {
      repo.calls.push(`default:${slot}`);
      if (!repo.numbers.some((n) => n.slot === slot)) return false;
      for (const n of repo.numbers) n.isDefault = n.slot === slot;
      return true;
    },
    async setLocationNumberLabel(locationId: string, slot: number, label: string | null) {
      repo.calls.push(`label:${slot}:${label}`);
      const target = repo.numbers.find((n) => n.slot === slot);
      if (!target) return false;
      target.label = label;
      return true;
    },
    async getWhatsappSessionSummary(tenantId: string) {
      repo.calls.push(`summary:${tenantId}`);
      return summaryFor(tenantId);
    },
  };
  return repo;
}

test("listEmbedNumbers: slot, label, isDefault and a redacted summary per number — one summary read each, no tenant ids", async () => {
  const repo = fakeNumbersRepo(SLOTS_1_2);
  const numbers = await listEmbedNumbers(repo, LOCATION_ID);
  assert.deepEqual(
    numbers.map((n) => ({ slot: n.slot, label: n.label, isDefault: n.isDefault })),
    [
      { slot: 1, label: null, isDefault: true },
      { slot: 2, label: "Sales line", isDefault: false },
    ]
  );
  assert.deepEqual(Object.keys(numbers[0]).sort(), ["isDefault", "key", "label", "slot", "summary"]);
  assert.equal(numbers[0].summary?.phoneNumber, "+447700900123");
  assert.equal(repo.calls.filter((c) => c.startsWith("summary:")).length, 2);
  assertNoTenantId(numbers, "listEmbedNumbers");
});

test("listEmbedNumbers: each number has an opaque key that changes when the number in a slot changes", async () => {
  const before = await listEmbedNumbers(fakeNumbersRepo(SLOTS_1_2), LOCATION_ID);
  const again = await listEmbedNumbers(fakeNumbersRepo(SLOTS_1_2), LOCATION_ID);
  // Slot 2 removed and re-added: same slot, a different tenant.
  const readded = await listEmbedNumbers(
    fakeNumbersRepo([SLOTS_1_2[0], { ...SLOTS_1_2[1], tenantId: TENANT_3 }]),
    LOCATION_ID
  );
  for (const n of before) assert.match(n.key, /^[0-9a-f]{12}$/);
  assert.notEqual(before[0].key, before[1].key);
  assert.deepEqual(again.map((n) => n.key), before.map((n) => n.key), "stable for the same number");
  assert.equal(readded[0].key, before[0].key);
  assert.notEqual(readded[1].key, before[1].key, "a re-added slot gets a new key");
  assertNoTenantId(before, "listEmbedNumbers keys");
});

test("decideAddNumber: adds at the next slot with a trimmed label, returns the redacted list", async () => {
  const repo = fakeNumbersRepo(ONLY_SLOT_1);
  const result = await decideAddNumber(repo, LOCATION_ID, { label: "  Sales line " });
  assert.equal(result.status, 200);
  assert.ok(result.body.ok);
  if (result.body.ok) {
    assert.equal(result.body.slot, 2);
    assert.equal(result.body.numbers.length, 2);
  }
  assert.ok(repo.calls.includes("add:Sales line"));
  assertNoTenantId(result, "add ok");
});

test("decideAddNumber: limit -> 409 with the fixed 'already has 3' message", async () => {
  const repo = fakeNumbersRepo([
    ...SLOTS_1_2,
    { tenantId: TENANT_3, slot: 3, isDefault: false, label: null },
  ]);
  const result = await decideAddNumber(repo, LOCATION_ID, {});
  assert.deepEqual(result, { status: 409, body: { ok: false, code: "limit", message: LIMIT_MESSAGE } });
});

test("decideAddNumber: a label over 40 characters -> 400 invalid_label, nothing added", async () => {
  const repo = fakeNumbersRepo(ONLY_SLOT_1);
  const result = await decideAddNumber(repo, LOCATION_ID, { label: "x".repeat(41) });
  assert.deepEqual(result, { status: 400, body: { ok: false, code: "invalid_label", message: "Labels can be up to 40 characters." } });
  assert.ok(!repo.calls.some((c) => c.startsWith("add:")));
});

test("decideRemoveNumber: removing the last number is refused, and the bridge is never logged out", async () => {
  const repo = fakeNumbersRepo(ONLY_SLOT_1);
  const logouts: string[] = [];
  const result = await decideRemoveNumber(repo, { logout: async (t) => (logouts.push(t), { ok: true }) }, LOCATION_ID, { slot: 1 });
  assert.equal(result.status, 409);
  assert.equal(!result.body.ok && result.body.code, "last_number");
  assert.deepEqual(logouts, []);
  assert.ok(!repo.calls.some((c) => c.startsWith("remove:")));
  assertNoTenantId(result, "last number");
});

test("decideRemoveNumber: logs that number's bridge session out FIRST, then removes the row", async () => {
  const repo = fakeNumbersRepo(SLOTS_1_2);
  const order: string[] = [];
  const logout = async (tenantId: string): Promise<BridgeOkResult> => {
    order.push(`logout:${tenantId}`);
    repo.calls.push(`logout:${tenantId}`);
    return { ok: true };
  };
  const result = await decideRemoveNumber(repo, { logout }, LOCATION_ID, { slot: 2 });
  assert.equal(result.status, 200);
  const logoutAt = repo.calls.indexOf(`logout:${TENANT_2}`);
  const removeAt = repo.calls.indexOf("remove:2");
  assert.ok(logoutAt >= 0 && removeAt > logoutAt, `logout must precede removal: ${repo.calls.join(", ")}`);
  assert.deepEqual(order, [`logout:${TENANT_2}`]);
  assert.equal(result.body.ok && result.body.numbers.length, 1);
  assertNoTenantId(result, "remove ok");
});

test("decideRemoveNumber: an unreachable bridge does not block removal; any other bridge failure does", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const unreachableRepo = fakeNumbersRepo(SLOTS_1_2);
  const unreachable = await decideRemoveNumber(
    unreachableRepo,
    { logout: async () => ({ ok: false, code: "unreachable", message: "WhatsApp bridge unreachable or timed out." }) },
    LOCATION_ID,
    { slot: 2 }
  );
  assert.equal(unreachable.status, 200);
  assert.ok(unreachableRepo.calls.includes("remove:2"));

  const brokenRepo = fakeNumbersRepo(SLOTS_1_2);
  const broken = await decideRemoveNumber(
    brokenRepo,
    { logout: async () => ({ ok: false, code: "internal", message: `bridge failed for ${TENANT_2}` }) },
    LOCATION_ID,
    { slot: 2 }
  );
  assert.equal(broken.status, 502);
  assert.ok(!brokenRepo.calls.includes("remove:2"), "a failed logout must leave the number in place");
  assertNoTenantId(broken, "remove logout failure");
  // Both failures are logged (by slot and code), and the log line never carries the tenant id either.
  assert.equal(warn.mock.callCount(), 2);
  assertNoTenantId(warn.mock.calls.map((c) => c.arguments), "remove logout warning");
});

test("decideRemoveNumber: slot is REQUIRED (never defaults to 1), and an unknown slot is 404", async () => {
  const repo = fakeNumbersRepo(SLOTS_1_2);
  const logout = async () => ({ ok: true as const });
  assert.deepEqual(await decideRemoveNumber(repo, { logout }, LOCATION_ID, {}), {
    status: 400,
    body: { ok: false, code: "invalid_slot", message: INVALID_SLOT_MESSAGE },
  });
  assert.deepEqual(await decideRemoveNumber(repo, { logout }, LOCATION_ID, { slot: 3 }), {
    status: 404,
    body: { ok: false, code: "unknown_number", message: UNKNOWN_NUMBER_MESSAGE },
  });
});

test("decideUpdateNumber: make default and relabel, returning the redacted list", async () => {
  const repo = fakeNumbersRepo(SLOTS_1_2);
  const result = await decideUpdateNumber(repo, LOCATION_ID, { slot: 2, makeDefault: true, label: " Support " });
  assert.equal(result.status, 200);
  if (result.body.ok) {
    const two = result.body.numbers.find((n) => n.slot === 2)!;
    assert.equal(two.isDefault, true);
    assert.equal(two.label, "Support");
    assert.equal(result.body.numbers.find((n) => n.slot === 1)!.isDefault, false);
  }
  assertNoTenantId(result, "update ok");
});

test("decideUpdateNumber: an empty label clears it; an over-long one is 400 invalid_label", async () => {
  const repo = fakeNumbersRepo(SLOTS_1_2);
  const cleared = await decideUpdateNumber(repo, LOCATION_ID, { slot: 2, label: "" });
  assert.equal(cleared.status, 200);
  assert.equal(repo.numbers.find((n) => n.slot === 2)!.label, null);
  assert.deepEqual(await decideUpdateNumber(repo, LOCATION_ID, { slot: 2, label: "y".repeat(41) }), {
    status: 400,
    body: { ok: false, code: "invalid_label", message: "Labels can be up to 40 characters." },
  });
});

test("decideUpdateNumber: unknown slot is 404, a bad slot 400, and a body with nothing to change 400", async () => {
  const repo = fakeNumbersRepo(ONLY_SLOT_1);
  assert.deepEqual(await decideUpdateNumber(repo, LOCATION_ID, { slot: 2, makeDefault: true }), {
    status: 404,
    body: { ok: false, code: "unknown_number", message: UNKNOWN_NUMBER_MESSAGE },
  });
  assert.equal((await decideUpdateNumber(repo, LOCATION_ID, { slot: "1", makeDefault: true })).status, 400);
  assert.equal((await decideUpdateNumber(repo, LOCATION_ID, { slot: 1 })).status, 400);
  assert.equal((await decideUpdateNumber(repo, LOCATION_ID, { slot: 1, makeDefault: false })).status, 400);
});

// Accounts and billing (merge ruling): adding numbers 2-3 never consumes an
// activation slot, but it is only allowed on a location that may send.
test("decideAddNumber: a location that is not activated -> 409 not_activated, nothing added", async () => {
  const repo = fakeNumbersRepo(ONLY_SLOT_1);
  repo.activatedAt = null;
  const result = await decideAddNumber(repo, LOCATION_ID, { label: "Sales" });
  assert.equal(result.status, 409);
  assert.equal((result.body as { code: string }).code, "not_activated");
  assert.equal(repo.numbers.length, 1);
  assert.equal(repo.calls.some((c) => c.startsWith("add:")), false);
});

test("decideAddNumber: a cancelled owner account -> 409 billing_paused, nothing added", async () => {
  const repo = fakeNumbersRepo(ONLY_SLOT_1);
  repo.billingStatus = "cancelled";
  const result = await decideAddNumber(repo, LOCATION_ID, {});
  assert.equal(result.status, 409);
  assert.equal((result.body as { code: string }).code, "billing_paused");
  assert.equal(repo.numbers.length, 1);
});
