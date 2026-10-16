/**
 * GHL Custom Page embed — `src/lib/ghl-embed.ts` (SSO payload decryption,
 * user-context parsing, embed token mint/verify), `src/app/api/crm/embed/guard.ts`
 * (the shared config-gate + bearer-token + fresh-account guard the three
 * embed WhatsApp routes run on every call), and `src/lib/csp.ts` (the
 * `GHL_EMBED_FRAME_ANCESTORS` allowlist validator). Entirely offline: no
 * network, no Supabase, no live GHL account, no live bridge.
 *
 * The decryption tests are written as ATTACKS where possible — same
 * discipline as `scripts/test/security.test.ts`'s own header: a wrong
 * secret, truncated/garbage input, a missing magic header, and a
 * successfully-decrypted-but-wrong-shaped plaintext are all more interesting
 * than "the happy path works", because this function's only caller is a
 * public HTTP endpoint that receives exactly this kind of input as a matter
 * of course. The round-trip fixtures below (`encryptOpenSslStyle` /
 * `evpBytesToKeyMd5Fixture`) exercise MALFORMED-INPUT HANDLING ONLY — a
 * character-for-character copy of the module's own KDF encrypting a fixture
 * this same suite then decrypts proves the two copies agree with each
 * OTHER, not that either agrees with GHL's actual wire format; if the KDF
 * itself were wrong, both copies would be wrong identically and every test
 * below would still pass. `decryptGhlSsoPayload: KNOWN-ANSWER VECTOR` below
 * (adversarial review lens 4, finding 8 — MINOR, fixed) is what actually
 * pins wire compatibility — it decrypts a ciphertext produced by a REAL
 * `openssl enc -aes-256-cbc -md md5` invocation, external to this codebase
 * entirely, so a KDF regression here would show up as THAT test failing even
 * though every self-referential round-trip test above it kept passing.
 *
 * `ONBOARD_STATE_SECRET`/`GHL_SSO_SHARED_SECRET`/the two `NEXT_PUBLIC_SUPABASE_*`
 * vars are set at the top of this file (mirrors `security.test.ts`'s own
 * note): `mintGhlEmbedToken`/`verifyGhlEmbedToken` fail closed with no
 * `ONBOARD_STATE_SECRET` configured (adversarial review lens 4, finding 1),
 * and `authorizeGhlEmbedRequest` now 503s outright with the embed
 * unconfigured or the deployment not in live mode (finding 3) — a suite
 * where every guard call failed for THAT reason before ever reaching the
 * token/account checks would pass while proving nothing about them. Tests
 * that need the UNCONFIGURED/DEMO-MODE states save, mutate, and restore
 * these same vars locally, same pattern as the existing config-gate tests
 * below.
 */
process.env.ONBOARD_STATE_SECRET ||= "test-secret-not-used-anywhere-real";
process.env.GHL_SSO_SHARED_SECRET ||= "test-sso-secret-not-used-anywhere-real";
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test.supabase.example";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key-not-used-anywhere-real";

import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

import {
  decryptGhlSsoPayload,
  ghlSsoSharedSecret,
  isGhlEmbedConfigured,
  mintGhlEmbedToken,
  parseGhlUserContext,
  verifyGhlEmbedToken,
} from "@/lib/ghl-embed";
import { signKindedState, verifyKindedState } from "@/lib/signed-state";
import { authorizeGhlEmbedRequest, type GhlEmbedGuardRepo } from "@/app/api/crm/embed/guard";
import { isValidGhlEmbedFrameAncestor, parseGhlEmbedFrameAncestors } from "@/lib/csp";
import type { GhlAccount } from "@/lib/types";

const SECRET = "correct-shared-secret";
const WRONG_SECRET = "a-completely-different-secret";

// ---------------------------------------------------------------------------
// A local reimplementation of the OpenSSL "salted passphrase" container
// format (`Salted__` + 8-byte salt + ciphertext, AES-256-CBC, key/IV via
// EVP_BytesToKey/MD5) — the SAME scheme `decryptGhlSsoPayload` implements,
// built independently here (not imported from the module under test).
//
// CORRECTED (adversarial review lens 4, finding 8 — MINOR): this used to
// claim these fixtures "exercise the real wire format rather than merely
// round-tripping through the same code twice" — false. It IS a second,
// independent implementation of the same algorithm, but if that algorithm
// itself were wrong (a mis-transcribed EVP_BytesToKey, a swapped key/IV
// order), BOTH copies would be wrong in the SAME way, and every test below
// that encrypts with this file's fixtures and decrypts with the module under
// test would still pass — proving the two agree with each OTHER, not that
// either agrees with GHL's actual output. What these fixtures actually test
// well is MALFORMED-INPUT HANDLING: truncation, a wrong secret, a corrupted
// header, non-JSON plaintext — cases where "does this look like a real
// container" matters more than "is this the exact bytes a real `openssl`
// would produce". The `decryptGhlSsoPayload: KNOWN-ANSWER VECTOR` test below
// (against a real `openssl enc -aes-256-cbc -md md5` output, external to
// this codebase) is what actually pins wire compatibility.
// ---------------------------------------------------------------------------

function evpBytesToKeyMd5Fixture(secret: Buffer, salt: Buffer, totalLength: number): Buffer {
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(chunks).length < totalLength) {
    const hash = createHash("md5");
    hash.update(previous);
    hash.update(secret);
    hash.update(salt);
    previous = hash.digest();
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, totalLength);
}

function encryptOpenSslStyle(plaintext: string, secret: string, saltOverride?: Buffer): string {
  const salt = saltOverride ?? randomBytes(8);
  const keyAndIv = evpBytesToKeyMd5Fixture(Buffer.from(secret, "utf8"), salt, 32 + 16);
  const key = keyAndIv.subarray(0, 32);
  const iv = keyAndIv.subarray(32, 48);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const container = Buffer.concat([Buffer.from("Salted__", "utf8"), salt, ciphertext]);
  return container.toString("base64");
}

function locationContextPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "ghl-user-1",
    companyId: "ghl-company-1",
    role: "admin",
    type: "location",
    userName: "Jane Coach",
    email: "jane@example.com",
    isAgencyOwner: false,
    versionId: "v1",
    activeLocation: "loc-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decryptGhlSsoPayload
// ---------------------------------------------------------------------------

test("decryptGhlSsoPayload: round-trips a genuine GHL-shaped payload", () => {
  const plaintext = JSON.stringify(locationContextPayload());
  const encrypted = encryptOpenSslStyle(plaintext, SECRET);
  const decrypted = decryptGhlSsoPayload(encrypted, SECRET);
  assert.deepEqual(decrypted, JSON.parse(plaintext));
});

test("decryptGhlSsoPayload: KNOWN-ANSWER VECTOR — a real `openssl enc -aes-256-cbc -md md5` ciphertext, external to this codebase (adversarial review lens 4, finding 8)", () => {
  // Produced and externally verified during review — NOT generated by
  // `encryptOpenSslStyle` above. This is the one test in this file that can
  // actually catch a KDF/cipher-mode regression: every other decrypt test
  // encrypts with this same module's own EVP_BytesToKey/AES-256-CBC
  // reimplementation and decrypts with the module under test, so a wrong KDF
  // that's wrong in the SAME way on both sides would still pass every one of
  // them. This ciphertext was never touched by this codebase's own crypto —
  // only real `openssl` was — so it pins actual wire compatibility with
  // GHL's documented format, not just internal self-consistency.
  const ciphertext = "U2FsdGVkX19heYEWD+4f5k7U+6LxxVpG9nCT1T/lJVsdqH+FTeOncw2IJkIl2Pdk19t7rMJBTiBL6gu+9qsrnw==";
  const secret = "correct-shared-secret";
  const decrypted = decryptGhlSsoPayload(ciphertext, secret);
  assert.deepEqual(decrypted, { activeLocation: "loc-1", userId: "u1" });
});

test("decryptGhlSsoPayload: the wrong secret fails to decrypt (bad PKCS#7 padding) -> null", () => {
  const encrypted = encryptOpenSslStyle(JSON.stringify(locationContextPayload()), SECRET);
  assert.equal(decryptGhlSsoPayload(encrypted, WRONG_SECRET), null);
});

test("decryptGhlSsoPayload: truncated base64 (a real container cut short) -> null", () => {
  const encrypted = encryptOpenSslStyle(JSON.stringify(locationContextPayload()), SECRET);
  const truncated = encrypted.slice(0, Math.floor(encrypted.length / 2));
  assert.equal(decryptGhlSsoPayload(truncated, SECRET), null);
});

test("decryptGhlSsoPayload: garbage (non-base64-shaped) input -> null, never throws", () => {
  assert.doesNotThrow(() => decryptGhlSsoPayload("!!!not base64 at all!!!", SECRET));
  assert.equal(decryptGhlSsoPayload("!!!not base64 at all!!!", SECRET), null);
});

test("decryptGhlSsoPayload: missing the 'Salted__' magic header -> null", () => {
  // A well-formed AES block count, correct length, just the wrong 8 leading
  // bytes — pins that the header is actually CHECKED, not just implied by
  // length.
  const salt = randomBytes(8);
  const keyAndIv = evpBytesToKeyMd5Fixture(Buffer.from(SECRET, "utf8"), salt, 48);
  const cipher = createCipheriv("aes-256-cbc", keyAndIv.subarray(0, 32), keyAndIv.subarray(32, 48));
  const ciphertext = Buffer.concat([cipher.update("{}", "utf8"), cipher.final()]);
  const wrongMagic = Buffer.concat([Buffer.from("NotSalt!", "utf8"), salt, ciphertext]).toString("base64");
  assert.equal(decryptGhlSsoPayload(wrongMagic, SECRET), null);
});

test("decryptGhlSsoPayload: a valid decrypt of non-JSON plaintext -> null", () => {
  const encrypted = encryptOpenSslStyle("this is not json at all", SECRET);
  assert.equal(decryptGhlSsoPayload(encrypted, SECRET), null);
});

test("decryptGhlSsoPayload: a valid decrypt of a JSON ARRAY -> null (must be a plain object)", () => {
  const encrypted = encryptOpenSslStyle(JSON.stringify([1, 2, 3]), SECRET);
  assert.equal(decryptGhlSsoPayload(encrypted, SECRET), null);
});

test("decryptGhlSsoPayload: a valid decrypt of a JSON PRIMITIVE -> null", () => {
  for (const primitive of ['"a string"', "42", "true", "null"]) {
    const encrypted = encryptOpenSslStyle(primitive, SECRET);
    assert.equal(decryptGhlSsoPayload(encrypted, SECRET), null, primitive);
  }
});

test("decryptGhlSsoPayload: never throws across a spread of malformed inputs", () => {
  const malformed = [
    "",
    " ",
    "Salted__",
    "U2FsdGVk", // "Salted__"'s own base64 without ever making a valid full container
    "====",
    "a".repeat(3),
    "a".repeat(31), // one byte short of the minimum viable container
    Buffer.from("Salted__" + "x".repeat(8)).toString("base64"), // header + salt, zero ciphertext
    Buffer.from("Salted__" + "x".repeat(8) + "y".repeat(15)).toString("base64"), // ciphertext not a multiple of the 16-byte block size
    "%%%invalid%%%",
  ];
  for (const input of malformed) {
    assert.doesNotThrow(() => decryptGhlSsoPayload(input, SECRET), `threw on: ${JSON.stringify(input)}`);
    assert.equal(decryptGhlSsoPayload(input, SECRET), null, `expected null for: ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// parseGhlUserContext — the one function this app trusts for "which
// location is this".
// ---------------------------------------------------------------------------

test("parseGhlUserContext: a genuine sub-account (location-context) payload passes through", () => {
  const ctx = parseGhlUserContext(locationContextPayload());
  assert.deepEqual(ctx, { activeLocation: "loc-1", userId: "ghl-user-1", companyId: "ghl-company-1", email: "jane@example.com" });
});

test("parseGhlUserContext: agency-context (no activeLocation field at all) -> null", () => {
  const { activeLocation: _drop, ...agencyContext } = locationContextPayload();
  void _drop;
  assert.equal(parseGhlUserContext(agencyContext), null);
});

test("parseGhlUserContext: an empty-string activeLocation -> null", () => {
  assert.equal(parseGhlUserContext(locationContextPayload({ activeLocation: "" })), null);
});

test("parseGhlUserContext: a non-string activeLocation -> null", () => {
  for (const bad of [42, true, null, {}, ["loc-1"]]) {
    assert.equal(parseGhlUserContext(locationContextPayload({ activeLocation: bad })), null, JSON.stringify(bad));
  }
});

test("parseGhlUserContext: activeLocation over the length cap -> null (adversarial review lens 4, finding 11)", () => {
  // 128 is the cap (src/lib/ghl-embed.ts's MAX_ACTIVE_LOCATION_LENGTH) —
  // real GHL location ids are ~24 characters, so 129 is already absurd, and
  // this exact string becomes a DB lookup key AND rides inside every
  // subsequently-minted embed token payload if it were ever let through.
  const exactlyAtCap = "l".repeat(128);
  const oneOverCap = "l".repeat(129);
  assert.notEqual(parseGhlUserContext(locationContextPayload({ activeLocation: exactlyAtCap })), null, "128 chars is still valid");
  assert.equal(parseGhlUserContext(locationContextPayload({ activeLocation: oneOverCap })), null, "129 chars must be refused");
});

test("parseGhlUserContext: a non-object top level -> null, never throws", () => {
  for (const bad of [null, undefined, "loc-1", 42, [locationContextPayload()]]) {
    assert.doesNotThrow(() => parseGhlUserContext(bad));
    assert.equal(parseGhlUserContext(bad), null);
  }
});

// ---------------------------------------------------------------------------
// isGhlEmbedConfigured / ghlSsoSharedSecret — the config gate.
// ---------------------------------------------------------------------------

test("isGhlEmbedConfigured: false when GHL_SSO_SHARED_SECRET is unset", () => {
  const previous = process.env.GHL_SSO_SHARED_SECRET;
  delete process.env.GHL_SSO_SHARED_SECRET;
  try {
    assert.equal(isGhlEmbedConfigured(), false);
    assert.equal(ghlSsoSharedSecret(), null);
  } finally {
    if (previous === undefined) delete process.env.GHL_SSO_SHARED_SECRET;
    else process.env.GHL_SSO_SHARED_SECRET = previous;
  }
});

test("isGhlEmbedConfigured: true once GHL_SSO_SHARED_SECRET is set", () => {
  const previous = process.env.GHL_SSO_SHARED_SECRET;
  process.env.GHL_SSO_SHARED_SECRET = "some-secret";
  try {
    assert.equal(isGhlEmbedConfigured(), true);
    assert.equal(ghlSsoSharedSecret(), "some-secret");
  } finally {
    if (previous === undefined) delete process.env.GHL_SSO_SHARED_SECRET;
    else process.env.GHL_SSO_SHARED_SECRET = previous;
  }
});

test("isGhlEmbedConfigured: FALSE when GHL_SSO_SHARED_SECRET is set but ONBOARD_STATE_SECRET is unset, EVEN THOUGH CRON_SECRET is set (adversarial review lens 4, finding 1 — MAJOR, the regression test that matters most)", () => {
  // Before this fix, mintGhlEmbedToken/verifyGhlEmbedToken signed under
  // getStateSecret()'s "ONBOARD_STATE_SECRET or CRON_SECRET" fallback, so an
  // operator who never got around to setting a dedicated ONBOARD_STATE_SECRET
  // (a state docs/RUNBOOK.md's §3b explicitly used to bless as a working
  // interim) would have the embed silently signing under CRON_SECRET — an
  // operational bearer token pasted into curl commands elsewhere in that
  // same runbook — rather than refusing to switch on at all.
  const previousOnboard = process.env.ONBOARD_STATE_SECRET;
  const previousCron = process.env.CRON_SECRET;
  const previousGhlSso = process.env.GHL_SSO_SHARED_SECRET;
  delete process.env.ONBOARD_STATE_SECRET;
  process.env.CRON_SECRET = "some-operational-cron-secret";
  process.env.GHL_SSO_SHARED_SECRET = "some-sso-secret";
  try {
    assert.equal(isGhlEmbedConfigured(), false);
  } finally {
    if (previousOnboard === undefined) delete process.env.ONBOARD_STATE_SECRET;
    else process.env.ONBOARD_STATE_SECRET = previousOnboard;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
    if (previousGhlSso === undefined) delete process.env.GHL_SSO_SHARED_SECRET;
    else process.env.GHL_SSO_SHARED_SECRET = previousGhlSso;
  }
});

// ---------------------------------------------------------------------------
// mintGhlEmbedToken / verifyGhlEmbedToken
// ---------------------------------------------------------------------------

test("embed token: mint -> verify round trip returns the exact locationId", () => {
  const token = mintGhlEmbedToken("loc-42");
  const verified = verifyGhlEmbedToken(token);
  assert.deepEqual(verified, { locationId: "loc-42" });
});

test("embed token: an expired token verifies as null", () => {
  // mintGhlEmbedToken has no ttl parameter of its own (by design — every
  // embed token uses the same fixed EMBED_TOKEN_TTL_MS) so an already-expired
  // token is built directly via signKindedState with a negative ttl, the
  // same underlying primitive mintGhlEmbedToken itself calls.
  const expired = signKindedState("ghl-embed", { locationId: "loc-42" }, -1);
  assert.equal(verifyGhlEmbedToken(expired), null);
});

test("embed token: a tampered payload segment is rejected", () => {
  const token = mintGhlEmbedToken("loc-42");
  const [, signature] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ k: "ghl-embed", d: { locationId: "loc-ATTACKER" }, exp: Date.now() + 60_000 })).toString(
    "base64url"
  );
  assert.equal(verifyGhlEmbedToken(`${tamperedPayload}.${signature}`), null);
});

test("embed token: a tampered signature segment is rejected", () => {
  const token = mintGhlEmbedToken("loc-42");
  const [payloadB64] = token.split(".");
  assert.equal(verifyGhlEmbedToken(`${payloadB64}.not-the-real-signature`), null);
});

test("embed token: garbage/malformed strings never throw and always verify as null", () => {
  const malformed = ["", "no-dot-at-all", "too.many.dots.here", ".", "a.", ".b"];
  for (const input of malformed) {
    assert.doesNotThrow(() => verifyGhlEmbedToken(input));
    assert.equal(verifyGhlEmbedToken(input), null, input);
  }
});

test("embed token: KIND CONFUSION PINNED — a 'ghl-install'-kind state must NOT verify as 'ghl-embed'", () => {
  // ghl-install carries no payload at all ({}), so it wouldn't even have a
  // locationId to leak — but the point of this test is that the KIND check
  // itself refuses it before the payload shape is ever inspected.
  const installState = signKindedState("ghl-install", {});
  assert.equal(verifyGhlEmbedToken(installState), null);
});

test("embed token: the reverse direction also holds — a 'ghl-embed' token must not verify under a different kind", () => {
  const embedToken = mintGhlEmbedToken("loc-42");
  // Exercised via the underlying primitive directly, since there is no
  // 'verifyGhlInstallToken' sibling to call.
  assert.equal(verifyKindedState("ghl-install", embedToken), null);
});

test("verifyGhlEmbedToken: returns null when only CRON_SECRET is present, even for a token genuinely signed under it (adversarial review lens 4, finding 1 — MAJOR)", () => {
  const previousOnboard = process.env.ONBOARD_STATE_SECRET;
  const previousCron = process.env.CRON_SECRET;
  delete process.env.ONBOARD_STATE_SECRET;
  process.env.CRON_SECRET = "some-operational-cron-secret";
  try {
    // Signed with ONBOARD_STATE_SECRET ALREADY unset — getStateSecret()
    // (src/lib/onboarding.ts) falls back to CRON_SECRET, so this is exactly
    // what an attacker who holds only CRON_SECRET could forge by hand, with
    // no SSO payload, no decrypt, no GHL involvement at all. Without the
    // explicit `hasEmbedStateSecret()` gate this fix adds,
    // `verifyKindedState` would happily validate this — it was signed and
    // would be verified under the SAME CRON_SECRET-backed key, a perfectly
    // valid signature by getStateSecret()'s own rules. The gate is what
    // refuses it anyway.
    const forgedUnderCron = signKindedState("ghl-embed", { locationId: "loc-attacker" });
    assert.equal(verifyGhlEmbedToken(forgedUnderCron), null);
  } finally {
    if (previousOnboard === undefined) delete process.env.ONBOARD_STATE_SECRET;
    else process.env.ONBOARD_STATE_SECRET = previousOnboard;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
});

test("mintGhlEmbedToken: throws when ONBOARD_STATE_SECRET is unset, rather than silently signing under getStateSecret()'s CRON_SECRET fallback (adversarial review lens 4, finding 1 — MAJOR)", () => {
  const previousOnboard = process.env.ONBOARD_STATE_SECRET;
  const previousCron = process.env.CRON_SECRET;
  delete process.env.ONBOARD_STATE_SECRET;
  process.env.CRON_SECRET = "some-operational-cron-secret";
  try {
    assert.throws(() => mintGhlEmbedToken("loc-1"));
  } finally {
    if (previousOnboard === undefined) delete process.env.ONBOARD_STATE_SECRET;
    else process.env.ONBOARD_STATE_SECRET = previousOnboard;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
});

// ---------------------------------------------------------------------------
// authorizeGhlEmbedRequest (src/app/api/crm/embed/guard.ts) — the shared
// bearer-token + fresh-account-re-read guard the three embed WhatsApp routes
// run on EVERY call. Deps-injected (a fake repo), same pattern as
// `scripts/test/ghl.test.ts`'s `createFakeRepo`.
// ---------------------------------------------------------------------------

const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const LOCATION_ID = "loc-guard-1";

function makeAccount(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: LOCATION_ID,
    tenantId: TENANT_ID,
    label: "Guard Test Location",
    companyId: null,
    conversationProviderId: null,
    accessToken: "access-token",
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshToken: "refresh-token",
    status: "active",
    lastError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeGuardRepo(accounts: GhlAccount[]): GhlEmbedGuardRepo & { calls: string[] } {
  const byLocation = new Map(accounts.map((a) => [a.locationId, a]));
  const calls: string[] = [];
  return {
    calls,
    async getGhlAccountByLocationId(locationId: string) {
      calls.push(locationId);
      return byLocation.get(locationId) ?? null;
    },
  };
}

test("guard: no Authorization header at all -> 401 missing_token", async () => {
  const repo = fakeGuardRepo([makeAccount()]);
  const result = await authorizeGhlEmbedRequest(repo, null);
  assert.deepEqual(result, { ok: false, status: 401, error: "missing_token" });
  assert.equal(repo.calls.length, 0, "the repo must never be consulted when there is no token to verify first");
});

test("guard: a header without the Bearer scheme -> 401 missing_token", async () => {
  const repo = fakeGuardRepo([makeAccount()]);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedRequest(repo, token); // no "Bearer " prefix
  assert.deepEqual(result, { ok: false, status: 401, error: "missing_token" });
});

test("guard: a syntactically-present but garbage token -> 401 invalid_token", async () => {
  const repo = fakeGuardRepo([makeAccount()]);
  const result = await authorizeGhlEmbedRequest(repo, "Bearer not-a-real-token");
  assert.deepEqual(result, { ok: false, status: 401, error: "invalid_token" });
});

test("guard: an expired token -> 401 invalid_token", async () => {
  const repo = fakeGuardRepo([makeAccount()]);
  const expired = signKindedState("ghl-embed", { locationId: LOCATION_ID }, -1);
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${expired}`);
  assert.deepEqual(result, { ok: false, status: 401, error: "invalid_token" });
});

test("guard: a valid token for a location with NO installed ghl_accounts row -> 403 unknown_location", async () => {
  const repo = fakeGuardRepo([]); // nothing installed anywhere
  const token = mintGhlEmbedToken("loc-never-installed");
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`);
  assert.deepEqual(result, { ok: false, status: 403, error: "unknown_location" });
});

test("guard: a valid token for a DISABLED account -> 403 account_disabled", async () => {
  const repo = fakeGuardRepo([makeAccount({ status: "disabled" })]);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`);
  assert.deepEqual(result, { ok: false, status: 403, error: "account_disabled" });
});

test("guard: a valid token for an active account -> ok, tenant resolved, and the repo is re-read (not cached from the token)", async () => {
  const repo = fakeGuardRepo([makeAccount()]);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.account.tenantId, TENANT_ID);
  assert.deepEqual(repo.calls, [LOCATION_ID], "must call getGhlAccountByLocationId — the revocation lever this guard exists for");
});

test("guard: needs_reauth is NOT refused here — only 'missing' and 'disabled' are (GHL OAuth health is orthogonal to the WhatsApp bridge session)", async () => {
  const repo = fakeGuardRepo([makeAccount({ status: "needs_reauth" })]);
  const token = mintGhlEmbedToken(LOCATION_ID);
  const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.account.status, "needs_reauth");
});

test("guard: RE-READ ON EVERY CALL — an account that was active when the token was minted but is disabled by the time this call runs is refused (the actual revocation lever)", async () => {
  const account = makeAccount({ status: "active" });
  const repo = fakeGuardRepo([account]);
  const token = mintGhlEmbedToken(LOCATION_ID);

  const before = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`);
  assert.equal(before.ok, true);

  account.status = "disabled"; // an owner disables the location in GhlAccountsPanel between two polls
  const after = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`); // SAME token, never re-minted
  assert.deepEqual(after, { ok: false, status: 403, error: "account_disabled" });
});

// ---------------------------------------------------------------------------
// THE KILL-SWITCH GAP (adversarial review lens 4, finding 3 — MAJOR). Before
// this fix, `authorizeGhlEmbedRequest` checked only the token + a DB
// re-read — `isGhlEmbedConfigured()`/`isLiveMode()` lived ONLY on
// `POST /api/crm/embed/session`, so an already-minted token (up to 15
// minutes old) kept working on these three routes even after an operator
// flipped `GHL_SSO_SHARED_SECRET` off as an emergency kill switch, or a
// deployment's env drifted out of live mode mid-flight. These tests use a
// STILL-VALID token/account pair — the config gate must refuse BEFORE the
// token or the repo are ever consulted.
// ---------------------------------------------------------------------------

test("guard: GHL_SSO_SHARED_SECRET unset -> 503 embed_not_configured, even with a perfectly valid token and account (the kill-switch case)", async () => {
  const repo = fakeGuardRepo([makeAccount()]);
  const token = mintGhlEmbedToken(LOCATION_ID); // minted while still configured

  const previous = process.env.GHL_SSO_SHARED_SECRET;
  delete process.env.GHL_SSO_SHARED_SECRET; // the emergency kill switch
  try {
    const result = await authorizeGhlEmbedRequest(repo, `Bearer ${token}`);
    assert.deepEqual(result, { ok: false, status: 503, error: "embed_not_configured" });
    assert.equal(repo.calls.length, 0, "must refuse before the repo is ever consulted");
  } finally {
    if (previous === undefined) delete process.env.GHL_SSO_SHARED_SECRET;
    else process.env.GHL_SSO_SHARED_SECRET = previous;
  }
});

// ---------------------------------------------------------------------------
// isValidGhlEmbedFrameAncestor / parseGhlEmbedFrameAncestors (src/lib/csp.ts)
// — the `GHL_EMBED_FRAME_ANCESTORS` allowlist validator (adversarial review
// lens 4, finding 11 — MINOR). Extracted as pure functions specifically so
// they're testable here without spinning up `next.config.ts` itself.
// ---------------------------------------------------------------------------

test("isValidGhlEmbedFrameAncestor: accepts a normal https origin", () => {
  assert.equal(isValidGhlEmbedFrameAncestor("https://app.theiragencyname.com"), true);
});

test("isValidGhlEmbedFrameAncestor: accepts a single leading *. wildcard", () => {
  assert.equal(isValidGhlEmbedFrameAncestor("https://*.theiragencyname.com"), true);
});

test("isValidGhlEmbedFrameAncestor: rejects a bare *", () => {
  assert.equal(isValidGhlEmbedFrameAncestor("*"), false);
});

test("isValidGhlEmbedFrameAncestor: rejects a value containing ; (CSP directive injection)", () => {
  assert.equal(isValidGhlEmbedFrameAncestor("https://app.example.com; script-src *"), false);
});

test("isValidGhlEmbedFrameAncestor: rejects whitespace-injected entries", () => {
  assert.equal(isValidGhlEmbedFrameAncestor("https://app.example.com https://evil.example.com"), false);
  assert.equal(isValidGhlEmbedFrameAncestor("https://app.example.com\tevil"), false);
  assert.equal(isValidGhlEmbedFrameAncestor("https://app.example.com\nevil"), false);
});

test("isValidGhlEmbedFrameAncestor: rejects a non-https scheme, a path, and more than one wildcard label", () => {
  assert.equal(isValidGhlEmbedFrameAncestor("http://app.example.com"), false, "http, not https");
  assert.equal(isValidGhlEmbedFrameAncestor("https://app.example.com/path"), false, "carries a path");
  assert.equal(isValidGhlEmbedFrameAncestor("https://*.*.example.com"), false, "two wildcard labels");
});

test("parseGhlEmbedFrameAncestors: drops invalid entries and keeps valid ones, never throws", () => {
  const raw = "https://good.example.com * https://also-good.example.com; https://*.wildcard.example.com";
  const result = parseGhlEmbedFrameAncestors(raw);
  assert.deepEqual(result, ["https://good.example.com", "https://*.wildcard.example.com"]);
});

test("parseGhlEmbedFrameAncestors: undefined/empty input -> []", () => {
  assert.deepEqual(parseGhlEmbedFrameAncestors(undefined), []);
  assert.deepEqual(parseGhlEmbedFrameAncestors(""), []);
  assert.deepEqual(parseGhlEmbedFrameAncestors("   "), []);
});
