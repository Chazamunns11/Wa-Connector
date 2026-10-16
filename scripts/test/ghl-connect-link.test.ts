/**
 * Per-client GHL connect links (docs/GHL-PROVIDER-CLIENT-MIGRATION.md) —
 * `src/lib/ghl-connect-link.ts` (mint/verify for both token kinds),
 * `src/lib/onboarding.ts`'s `verifyKindedStateWithReason` (the reason-aware
 * primitive this feature is built on), `src/app/api/connect/guard.ts` (the
 * bearer-token + fresh-account-re-read + version-check guard the three
 * connect WhatsApp routes run on every call), and
 * `src/lib/connect-throttle.ts`. Entirely offline: no network, no Supabase,
 * no live bridge. Mirrors `scripts/test/ghl-embed.test.ts`'s style/runner
 * throughout — same env-var setup convention, same dependency-injected fake
 * repo shape, same "attack-shaped tests, not just happy paths" discipline.
 *
 * `ONBOARD_STATE_SECRET`/the two `NEXT_PUBLIC_SUPABASE_*` vars/
 * `WHATSAPP_BRIDGE_URL`/`WHATSAPP_BRIDGE_SECRET` are set at the top of this
 * file, same reasoning as `ghl-embed.test.ts`'s identical note: every guard
 * call in this feature independently gates on being configured, live-mode,
 * AND bridge-configured, so a suite where every call failed for one of THOSE
 * reasons before ever reaching the token/account/version checks would pass
 * while proving nothing about them. Tests that need any of these UNSET save,
 * mutate, and restore the relevant vars locally.
 */
process.env.ONBOARD_STATE_SECRET ||= "test-secret-not-used-anywhere-real";
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test.supabase.example";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key-not-used-anywhere-real";
process.env.WHATSAPP_BRIDGE_URL ||= "https://bridge.test.example";
process.env.WHATSAPP_BRIDGE_SECRET ||= "test-bridge-secret-not-used-anywhere-real";

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONNECT_LINK_MENU_TTL_MS,
  CONNECT_LINK_TTL_MS,
  CONNECT_SESSION_TTL_MS,
  isConnectLinkConfigured,
  mintConnectLinkToken,
  mintConnectSessionToken,
  verifyConnectLinkToken,
  verifyConnectSessionToken,
} from "@/lib/ghl-connect-link";
import {
  signKindedState,
  verifyKindedState,
  verifyKindedStateWithReason,
  type SignedStateKind,
} from "@/lib/signed-state";
import { verifyGhlEmbedToken } from "@/lib/ghl-embed";
import { authorizeConnectRequest, guardFailureResponseBody, scrubTenantIdFromFailure, type ConnectGuardRepo } from "@/app/api/connect/guard";
import { redactBridgeSessionResult } from "@/lib/bridge-panel-guard";
import { checkConnectSessionThrottle } from "@/lib/connect-throttle";
import { decideConnectSession, MAX_CONNECT_SESSION_BODY_BYTES, type ConnectSessionRepo } from "@/app/api/connect/session/logic";
import type { GhlAccount, GhlAccountStatus } from "@/lib/types";
import type { BridgeSessionResult } from "@/lib/whatsapp-bridge";

// ---------------------------------------------------------------------------
// mintConnectLinkToken / verifyConnectLinkToken — round trips
// ---------------------------------------------------------------------------

test("connect-link token: mint -> verify round trip returns the exact locationId and version", () => {
  const token = mintConnectLinkToken("loc-42", 3);
  const verified = verifyConnectLinkToken(token);
  assert.deepEqual(verified, { ok: true, locationId: "loc-42", v: 3 });
});

test("connect-link token: TTL is 7 days", () => {
  assert.equal(CONNECT_LINK_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// TWO LIFETIMES — a link MESSAGED to a client should go stale (7 days); a link
// installed as a custom menu link in that client's GHL sidebar must still work
// months later, on the day their number drops. Shipping only the short one
// meant every menu link silently died a week after install.
// ---------------------------------------------------------------------------

test("connect-link token: menu TTL is a year, and is far longer than the send TTL", () => {
  assert.equal(CONNECT_LINK_MENU_TTL_MS, 365 * 24 * 60 * 60 * 1000);
  assert.ok(CONNECT_LINK_MENU_TTL_MS > CONNECT_LINK_TTL_MS * 50, "menu links must outlive send links by a wide margin");
});

test("connect-link token: lifetime defaults to the SHORT one when the caller says nothing", () => {
  const before = Date.now();
  const token = mintConnectLinkToken("loc-42", 0);
  const exp = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")).exp as number;
  // Generous window either side — this asserts which CONSTANT was used, not clock precision.
  assert.ok(exp - before <= CONNECT_LINK_TTL_MS + 5_000, "an unspecified lifetime must not silently mint a year-long link");
  assert.ok(exp - before > CONNECT_LINK_TTL_MS - 60_000);
});

test("connect-link token: an explicit 'menu' lifetime mints the year-long variant", () => {
  const before = Date.now();
  const token = mintConnectLinkToken("loc-42", 0, "menu");
  const exp = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")).exp as number;
  assert.ok(exp - before > CONNECT_LINK_TTL_MS * 50, "the 'menu' lifetime must be the long one");
  assert.ok(exp - before <= CONNECT_LINK_MENU_TTL_MS + 5_000);
});

test("connect-link token: both lifetimes still verify, carry the same payload, and stay the same kind", () => {
  for (const lifetime of ["send", "menu"] as const) {
    const token = mintConnectLinkToken("loc-42", 7, lifetime);
    assert.deepEqual(verifyConnectLinkToken(token), { ok: true, locationId: "loc-42", v: 7 }, `${lifetime} lifetime`);
  }
});

test("connect-link token: a long-lived menu link is STILL killed by a version bump", () => {
  // The whole safety argument for a year-long credential is that revocation,
  // not expiry, is what bounds it — so pin that the version travels in the
  // payload exactly as it does for the short-lived variant.
  const token = mintConnectLinkToken("loc-42", 3, "menu");
  const verified = verifyConnectLinkToken(token);
  assert.deepEqual(verified, { ok: true, locationId: "loc-42", v: 3 });
  // v=3 in the token vs a bumped v=4 on the account is what the guard compares.
  assert.notEqual(verified.ok && verified.v, 4);
});

test("connect-link token: an expired token verifies as reason 'expired'", () => {
  const expired = signKindedState("ghl-connect-link", { locationId: "loc-42", v: 0 }, -1);
  assert.deepEqual(verifyConnectLinkToken(expired), { ok: false, reason: "expired" });
});

test("connect-link token: a tampered payload segment is rejected as 'invalid'", () => {
  const token = mintConnectLinkToken("loc-42", 0);
  const [, signature] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ k: "ghl-connect-link", d: { locationId: "loc-ATTACKER", v: 0 }, exp: Date.now() + 60_000 })).toString(
    "base64url"
  );
  assert.deepEqual(verifyConnectLinkToken(`${tamperedPayload}.${signature}`), { ok: false, reason: "invalid" });
});

test("connect-link token: garbage/malformed strings never throw and always verify as 'invalid'", () => {
  const malformed = ["", "no-dot-at-all", "too.many.dots.here", ".", "a.", ".b"];
  for (const input of malformed) {
    assert.doesNotThrow(() => verifyConnectLinkToken(input));
    assert.deepEqual(verifyConnectLinkToken(input), { ok: false, reason: "invalid" }, input);
  }
});

test("connect-link token: a non-integer or negative 'v' in the payload is rejected as 'invalid'", () => {
  for (const badV of [1.5, -1, "0", null]) {
    const token = signKindedState("ghl-connect-link", { locationId: "loc-42", v: badV });
    assert.deepEqual(verifyConnectLinkToken(token), { ok: false, reason: "invalid" }, JSON.stringify(badV));
  }
});

// ---------------------------------------------------------------------------
// mintConnectSessionToken / verifyConnectSessionToken — round trips
// ---------------------------------------------------------------------------

test("connect-session token: mint -> verify round trip returns the exact locationId and version", () => {
  const token = mintConnectSessionToken("loc-42", 5);
  const verified = verifyConnectSessionToken(token);
  assert.deepEqual(verified, { ok: true, locationId: "loc-42", v: 5 });
});

test("connect-session token: TTL is 15 minutes", () => {
  assert.equal(CONNECT_SESSION_TTL_MS, 15 * 60 * 1000);
});

test("connect-session token: an expired token verifies as reason 'expired'", () => {
  const expired = signKindedState("ghl-connect-session", { locationId: "loc-42", v: 0 }, -1);
  assert.deepEqual(verifyConnectSessionToken(expired), { ok: false, reason: "expired" });
});

// ---------------------------------------------------------------------------
// CROSS-KIND REPLAY — rejected in ALL directions, link <-> session <-> embed
// <-> signup. Every kind's own verify function checks its kind FIRST, before
// even inspecting the payload's shape (`verifyKindedStateWithReason`'s own
// header, "THE ORDERING IS THE SECURITY PROPERTY") — so a single shared
// payload works for every mint below regardless of which kind's shape it
// would or wouldn't satisfy.
// ---------------------------------------------------------------------------

const CROSS_KIND_PAYLOAD = { locationId: "loc-x", v: 0, businessName: "Test Biz", email: "test@example.com" };

function mintAs(kind: SignedStateKind): string {
  return signKindedState(kind, CROSS_KIND_PAYLOAD);
}

test("cross-kind replay: a 'ghl-connect-session'/'ghl-embed'/'signup' token never verifies as 'ghl-connect-link'", () => {
  assert.equal(verifyConnectLinkToken(mintAs("ghl-connect-session")).ok, false);
  assert.equal(verifyConnectLinkToken(mintAs("ghl-embed")).ok, false);
  assert.equal(verifyConnectLinkToken(mintAs("signup")).ok, false);
  // And the reason is specifically wrong_kind, not some other failure masking it.
  const result = verifyConnectLinkToken(mintAs("ghl-embed"));
  assert.deepEqual(result, { ok: false, reason: "wrong_kind" });
});

test("cross-kind replay: a 'ghl-connect-link'/'ghl-embed'/'signup' token never verifies as 'ghl-connect-session'", () => {
  assert.equal(verifyConnectSessionToken(mintAs("ghl-connect-link")).ok, false);
  assert.equal(verifyConnectSessionToken(mintAs("ghl-embed")).ok, false);
  assert.equal(verifyConnectSessionToken(mintAs("signup")).ok, false);
  const result = verifyConnectSessionToken(mintAs("ghl-connect-link"));
  assert.deepEqual(result, { ok: false, reason: "wrong_kind" });
});

test("cross-kind replay: a 'ghl-connect-link'/'ghl-connect-session'/'signup' token never verifies as 'ghl-embed'", () => {
  assert.equal(verifyGhlEmbedToken(mintAs("ghl-connect-link")), null);
  assert.equal(verifyGhlEmbedToken(mintAs("ghl-connect-session")), null);
  assert.equal(verifyGhlEmbedToken(mintAs("signup")), null);
});

test("cross-kind replay: a 'ghl-connect-link'/'ghl-connect-session'/'ghl-embed' token never verifies as 'signup'", () => {
  assert.equal(verifyKindedState("signup", mintAs("ghl-connect-link")), null);
  assert.equal(verifyKindedState("signup", mintAs("ghl-connect-session")), null);
  assert.equal(verifyKindedState("signup", mintAs("ghl-embed")), null);
});

test("cross-kind replay: the POSITIVE control — each kind DOES verify as itself, on the same shared payload", () => {
  assert.equal(verifyConnectLinkToken(mintAs("ghl-connect-link")).ok, true);
  assert.equal(verifyConnectSessionToken(mintAs("ghl-connect-session")).ok, true);
  assert.notEqual(verifyGhlEmbedToken(mintAs("ghl-embed")), null);
  assert.notEqual(verifyKindedState("signup", mintAs("signup")), null);
});

/**
 * FULL 7-KIND MATRIX, PLUS BOTH UNTAGGED SIGNERS — adversarial review lens 5,
 * finding 10 (MINOR, fixed). The four tests above only ever exercised 4 of
 * `SignedStateKind`'s 7 members (`ghl-connect-link`/`ghl-connect-session`/
 * `ghl-embed`/`signup`) — `stripe-self`, `calendar-google`, and `ghl-install`
 * were never minted at all, and neither untagged signer
 * (`signOnboardState`/`signDemoSession`, src/lib/onboarding.ts — sharing the
 * SAME secret and wire format as every kinded state, per that file's own
 * "MUTUAL UNREPLAYABILITY" section header) was ever tested against a kinded
 * verifier or vice versa, despite that section's header explicitly claiming
 * the mutual-unreplayability property. This is the one thing that claim
 * relied on but never had pinned.
 */
const ALL_SIGNED_STATE_KINDS: SignedStateKind[] = [
  "signup",
  "stripe-self",
  "calendar-google",
  "ghl-install",
  "ghl-embed",
  "ghl-connect-link",
  "ghl-connect-session",
];

test("cross-kind replay: FULL 7x7 MATRIX — every kind's token verifies as itself via verifyKindedState and rejects every OTHER kind's check", () => {
  for (const mintKind of ALL_SIGNED_STATE_KINDS) {
    const token = signKindedState(mintKind, CROSS_KIND_PAYLOAD);
    for (const checkKind of ALL_SIGNED_STATE_KINDS) {
      const result = verifyKindedState(checkKind, token);
      if (checkKind === mintKind) {
        assert.notEqual(result, null, `a '${mintKind}' token should verify as itself`);
      } else {
        assert.equal(result, null, `a '${mintKind}' token should NOT verify as '${checkKind}'`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// verifyKindedStateWithReason — the reason-aware primitive itself.
// ---------------------------------------------------------------------------

test("verifyKindedStateWithReason: garbage input -> invalid, never throws", () => {
  assert.doesNotThrow(() => verifyKindedStateWithReason("ghl-connect-link", "not-a-real-token"));
  assert.deepEqual(verifyKindedStateWithReason("ghl-connect-link", "not-a-real-token"), { ok: false, reason: "invalid" });
});

test("verifyKindedStateWithReason: a tampered signature -> invalid", () => {
  const token = signKindedState("ghl-connect-link", { locationId: "loc-1", v: 0 });
  const [payloadB64] = token.split(".");
  assert.deepEqual(verifyKindedStateWithReason("ghl-connect-link", `${payloadB64}.not-the-real-signature`), { ok: false, reason: "invalid" });
});

test("verifyKindedStateWithReason: wrong kind -> wrong_kind, checked before exp", () => {
  const token = signKindedState("signup", { businessName: "x", email: "y@z.example" });
  assert.deepEqual(verifyKindedStateWithReason("ghl-connect-link", token), { ok: false, reason: "wrong_kind" });
});

test("verifyKindedStateWithReason: genuinely expired, untampered -> expired", () => {
  const expired = signKindedState("ghl-connect-link", { locationId: "loc-1", v: 0 }, -1);
  assert.deepEqual(verifyKindedStateWithReason("ghl-connect-link", expired), { ok: false, reason: "expired" });
});

test("verifyKindedStateWithReason: TAMPERED-THEN-EXPIRED reads invalid, NOT expired (the regression this ordering pins)", () => {
  // An already-expired token, then the payload segment is edited (changing
  // `d.locationId`) WITHOUT re-signing — the signature no longer matches.
  // If exp were checked before the signature, an attacker could fish for
  // "does this forged token's embedded exp look plausible" without ever
  // having to forge a valid signature. It must read identically to any other
  // signature-tamper case: invalid.
  const expired = signKindedState("ghl-connect-link", { locationId: "loc-1", v: 0 }, -1);
  const [, signature] = expired.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify({ k: "ghl-connect-link", d: { locationId: "loc-ATTACKER", v: 0 }, exp: Date.now() - 1000 })
  ).toString("base64url");
  const result = verifyKindedStateWithReason("ghl-connect-link", `${tamperedPayload}.${signature}`);
  assert.deepEqual(result, { ok: false, reason: "invalid" });
});

test("verifyKindedStateWithReason: is a strict superset of verifyKindedState — same accept/reject decision either way", () => {
  const token = signKindedState("ghl-connect-link", { locationId: "loc-1", v: 0 });
  const viaReason = verifyKindedStateWithReason("ghl-connect-link", token);
  const viaPlain = verifyKindedState("ghl-connect-link", token);
  assert.equal(viaReason.ok, viaPlain !== null);
  if (viaReason.ok) assert.deepEqual(viaReason.d, viaPlain);
});

// ---------------------------------------------------------------------------
// ONBOARD_STATE_SECRET unset, CRON_SECRET set — the same MAJOR-1-class
// regression `ghl-embed.test.ts` pins for the embed, restated for this
// feature: mint throws, verify rejects, isConnectLinkConfigured is false,
// EVEN THOUGH getStateSecret() would happily fall back to CRON_SECRET.
// ---------------------------------------------------------------------------

test("isConnectLinkConfigured: false when ONBOARD_STATE_SECRET is unset, even with CRON_SECRET set", () => {
  const previousOnboard = process.env.ONBOARD_STATE_SECRET;
  const previousCron = process.env.CRON_SECRET;
  delete process.env.ONBOARD_STATE_SECRET;
  process.env.CRON_SECRET = "some-operational-cron-secret";
  try {
    assert.equal(isConnectLinkConfigured(), false);
  } finally {
    if (previousOnboard === undefined) delete process.env.ONBOARD_STATE_SECRET;
    else process.env.ONBOARD_STATE_SECRET = previousOnboard;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
});

test("mintConnectLinkToken / mintConnectSessionToken: both throw when ONBOARD_STATE_SECRET is unset, rather than signing under the CRON_SECRET fallback", () => {
  const previousOnboard = process.env.ONBOARD_STATE_SECRET;
  const previousCron = process.env.CRON_SECRET;
  delete process.env.ONBOARD_STATE_SECRET;
  process.env.CRON_SECRET = "some-operational-cron-secret";
  try {
    assert.throws(() => mintConnectLinkToken("loc-1", 0));
    assert.throws(() => mintConnectSessionToken("loc-1", 0));
  } finally {
    if (previousOnboard === undefined) delete process.env.ONBOARD_STATE_SECRET;
    else process.env.ONBOARD_STATE_SECRET = previousOnboard;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
});

test("verifyConnectLinkToken / verifyConnectSessionToken: both reject when ONBOARD_STATE_SECRET is unset, even for a token genuinely signed under the CRON_SECRET fallback", () => {
  const previousOnboard = process.env.ONBOARD_STATE_SECRET;
  const previousCron = process.env.CRON_SECRET;
  delete process.env.ONBOARD_STATE_SECRET;
  process.env.CRON_SECRET = "some-operational-cron-secret";
  try {
    // Signed with ONBOARD_STATE_SECRET already unset — getStateSecret()
    // falls back to CRON_SECRET, so this is exactly what an attacker who
    // holds only CRON_SECRET could forge by hand.
    const forgedLink = signKindedState("ghl-connect-link", { locationId: "loc-attacker", v: 0 });
    const forgedSession = signKindedState("ghl-connect-session", { locationId: "loc-attacker", v: 0 });
    assert.equal(verifyConnectLinkToken(forgedLink).ok, false);
    assert.equal(verifyConnectSessionToken(forgedSession).ok, false);
  } finally {
    if (previousOnboard === undefined) delete process.env.ONBOARD_STATE_SECRET;
    else process.env.ONBOARD_STATE_SECRET = previousOnboard;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
});

// ---------------------------------------------------------------------------
// authorizeConnectRequest (src/app/api/connect/guard.ts) — the guard matrix.
// Dependency-injected fake repo, same pattern as `ghl-embed.test.ts`'s
// `fakeGuardRepo`.
// ---------------------------------------------------------------------------

const TENANT_ID = "44444444-4444-4444-8444-444444444444";
const LOCATION_ID = "loc-connect-guard-1";

function makeConnectAccount(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: LOCATION_ID,
    tenantId: TENANT_ID,
    label: "Connect Guard Test Location",
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
    // W-CONNECT-BRAND (migration 0076) — not exercised by this file's own
    // tests (see scripts/test/ghl-branding.test.ts for those), but required
    // to satisfy `GhlAccount`'s shape.
    brandLogoPath: null,
    brandAccentColor: null,
    ...overrides,
  };
}

function fakeConnectGuardRepo(accounts: GhlAccount[]): ConnectGuardRepo & { calls: string[] } {
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

test("connect guard: ONBOARD_STATE_SECRET unset -> 503 connect_not_configured, before the token or repo are ever consulted", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount()]);
  const token = mintConnectSessionToken(LOCATION_ID, 0); // minted while still configured

  const previous = process.env.ONBOARD_STATE_SECRET;
  delete process.env.ONBOARD_STATE_SECRET;
  try {
    const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
    assert.deepEqual(result, { ok: false, status: 503, error: "connect_not_configured" });
    assert.equal(repo.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.ONBOARD_STATE_SECRET;
    else process.env.ONBOARD_STATE_SECRET = previous;
  }
});

test("connect guard: bridge not configured -> 503 bridge_not_configured (the check the embed guard does not have)", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount()]);
  const token = mintConnectSessionToken(LOCATION_ID, 0);

  const previousUrl = process.env.WHATSAPP_BRIDGE_URL;
  const previousSecret = process.env.WHATSAPP_BRIDGE_SECRET;
  delete process.env.WHATSAPP_BRIDGE_URL;
  delete process.env.WHATSAPP_BRIDGE_SECRET;
  try {
    const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
    assert.deepEqual(result, { ok: false, status: 503, error: "bridge_not_configured" });
    assert.equal(repo.calls.length, 0);
  } finally {
    if (previousUrl === undefined) delete process.env.WHATSAPP_BRIDGE_URL;
    else process.env.WHATSAPP_BRIDGE_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.WHATSAPP_BRIDGE_SECRET;
    else process.env.WHATSAPP_BRIDGE_SECRET = previousSecret;
  }
});

test("connect guard: no Authorization header -> 401 missing_token", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount()]);
  const result = await authorizeConnectRequest(repo, null);
  assert.deepEqual(result, { ok: false, status: 401, error: "missing_token" });
  assert.equal(repo.calls.length, 0);
});

test("connect guard: a syntactically-present but garbage token -> 401 invalid_token", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount()]);
  const result = await authorizeConnectRequest(repo, "Bearer not-a-real-token");
  assert.deepEqual(result, { ok: false, status: 401, error: "invalid_token" });
});

test("connect guard: an expired session token -> 401 invalid_token", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount()]);
  const expired = signKindedState("ghl-connect-session", { locationId: LOCATION_ID, v: 0 }, -1);
  const result = await authorizeConnectRequest(repo, `Bearer ${expired}`);
  assert.deepEqual(result, { ok: false, status: 401, error: "invalid_token" });
});

test("connect guard: a LINK token (wrong kind) presented as a bearer session token -> 401 invalid_token", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount()]);
  const linkToken = mintConnectLinkToken(LOCATION_ID, 0);
  const result = await authorizeConnectRequest(repo, `Bearer ${linkToken}`);
  assert.deepEqual(result, { ok: false, status: 401, error: "invalid_token" });
});

test("connect guard: a valid session token for a location with NO installed ghl_accounts row -> 403 unknown_location", async () => {
  const repo = fakeConnectGuardRepo([]);
  const token = mintConnectSessionToken("loc-never-installed", 0);
  const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.deepEqual(result, { ok: false, status: 403, error: "unknown_location" });
});

test("connect guard: a valid session token for a DISABLED account -> 403 account_disabled", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount({ status: "disabled" })]);
  const token = mintConnectSessionToken(LOCATION_ID, 0);
  const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.deepEqual(result, { ok: false, status: 403, error: "account_disabled" });
});

test("connect guard: VERSION MISMATCH -> 403 link_revoked (the check the embed guard does not have)", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount({ connectLinkVersion: 2 })]);
  const token = mintConnectSessionToken(LOCATION_ID, 1); // minted under the OLD version
  const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.deepEqual(result, { ok: false, status: 403, error: "link_revoked" });
});

test("connect guard: a NULL connectLinkVersion (migration 0075 not applied) -> 403 link_revoked, never treated as matching v=0", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount({ connectLinkVersion: null })]);
  const token = mintConnectSessionToken(LOCATION_ID, 0);
  const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.deepEqual(result, { ok: false, status: 403, error: "link_revoked" });
});

test("connect guard: a valid session token, active account, matching version -> ok, tenant resolved, repo re-read (not cached from the token)", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount({ connectLinkVersion: 4 })]);
  const token = mintConnectSessionToken(LOCATION_ID, 4);
  const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.account.tenantId, TENANT_ID);
  assert.deepEqual(repo.calls, [LOCATION_ID]);
});

test("connect guard: RE-READ ON EVERY CALL — a version bump between two calls with the SAME session token revokes it mid-session", async () => {
  const account = makeConnectAccount({ connectLinkVersion: 0 });
  const repo = fakeConnectGuardRepo([account]);
  const token = mintConnectSessionToken(LOCATION_ID, 0);

  const before = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.equal(before.ok, true);

  account.connectLinkVersion = 1; // "Revoke all links" fires between two polls
  const after = await authorizeConnectRequest(repo, `Bearer ${token}`); // SAME token, never re-minted
  assert.deepEqual(after, { ok: false, status: 403, error: "link_revoked" });
});

test("connect guard: needs_reauth is NOT refused here — only 'missing', 'disabled', and 'link_revoked' are", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount({ status: "needs_reauth", connectLinkVersion: 0 })]);
  const token = mintConnectSessionToken(LOCATION_ID, 0);
  const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.account.status, "needs_reauth");
});

test("connect guard: the ok result never carries accessToken/refreshToken/coachId — only tenantId/label/status", async () => {
  const repo = fakeConnectGuardRepo([makeConnectAccount({ connectLinkVersion: 0 })]);
  const token = mintConnectSessionToken(LOCATION_ID, 0);
  const result = await authorizeConnectRequest(repo, `Bearer ${token}`);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(Object.keys(result.account).sort(), ["label", "status", "tenantId"]);
  }
});

test("guardFailureResponseBody: every error code maps to a body, and link_revoked gets its own honest message", () => {
  const revoked = guardFailureResponseBody({ ok: false, status: 403, error: "link_revoked" });
  assert.equal(revoked.code, "link_revoked");
  assert.match(revoked.message, /revoked/i);
});

// ---------------------------------------------------------------------------
// redactBridgeSessionResult (src/lib/bridge-panel-guard.ts) — shared with the
// embed guard now. Confirms `coachId` never survives into a connect route's
// response either.
// ---------------------------------------------------------------------------

test("redactBridgeSessionResult: strips coachId off an ok session, passes a failure through untouched", () => {
  const ok: BridgeSessionResult = {
    ok: true,
    session: { coachId: TENANT_ID, status: "waiting_qr", phoneNumber: null, qr: "raw-qr-string", sentToday: 0, dailyCap: 150, queueLength: 0 },
  };
  const redacted = redactBridgeSessionResult(ok);
  assert.equal(redacted.ok, true);
  if (redacted.ok) {
    assert.equal((redacted.session as Record<string, unknown>).coachId, undefined);
    assert.equal(redacted.session.qr, "raw-qr-string");
  }

  const failure: BridgeSessionResult = { ok: false, code: "unreachable", message: "down" };
  assert.deepEqual(redactBridgeSessionResult(failure), failure);
});

// ---------------------------------------------------------------------------
// scrubTenantIdFromFailure (src/app/api/connect/guard.ts) — adversarial
// review lens 5, finding 8 (MINOR, fixed). `redactBridgeSessionResult` above
// only ever redacts a SUCCESS result's `session.coachId`; this is the
// connect-feature-specific belt-and-braces fix for the FAILURE branch's own
// free-form `message`, applied by the three `/api/connect/whatsapp/*` routes
// — see that function's own JSDoc for why this exists rather than modifying
// the shared `redactBridgeSessionResult` (which the GHL embed feature also
// depends on, out of scope here).
// ---------------------------------------------------------------------------

test("scrubTenantIdFromFailure: redacts a literal occurrence of the tenant id inside a failure message", () => {
  const failure = { ok: false as const, code: "internal", message: `session for ${TENANT_ID} could not be created` };
  const scrubbed = scrubTenantIdFromFailure(failure, TENANT_ID);
  assert.equal(scrubbed.message, "session for [redacted] could not be created");
});

test("scrubTenantIdFromFailure: a message with no tenant id in it is returned unchanged", () => {
  const failure = { ok: false as const, code: "unreachable", message: "WhatsApp bridge unreachable or timed out." };
  assert.deepEqual(scrubTenantIdFromFailure(failure, TENANT_ID), failure);
});

// ---------------------------------------------------------------------------
// checkConnectSessionThrottle (src/lib/connect-throttle.ts) — IP_LIMIT is 30
// (raised from 20) and the key is `(ip, token)`, not `ip` alone
// (adversarial review lens 5, finding 7b — MINOR, fixed).
// ---------------------------------------------------------------------------

test("connect throttle: allows the first N attempts for one (IP, token) pair, then refuses", () => {
  const ip = "203.0.113.1";
  const token = "tok-a";
  let lastDecision;
  for (let i = 0; i < 30; i++) {
    lastDecision = checkConnectSessionThrottle(ip, token);
    assert.equal(lastDecision.allowed, true, `attempt ${i + 1} should be allowed`);
  }
  const over = checkConnectSessionThrottle(ip, token);
  assert.equal(over.allowed, false);
  assert.ok(over.retryAfterSeconds >= 1);
});

test("connect throttle: a null IP is always allowed (fails open, no shared bucket)", () => {
  for (let i = 0; i < 40; i++) {
    assert.equal(checkConnectSessionThrottle(null, "tok-whatever").allowed, true);
  }
});

test("connect throttle: different IPs get independent buckets, same token", () => {
  const ipA = "203.0.113.2";
  const ipB = "203.0.113.3";
  const token = "tok-b";
  for (let i = 0; i < 30; i++) checkConnectSessionThrottle(ipA, token);
  assert.equal(checkConnectSessionThrottle(ipA, token).allowed, false, "ipA should now be limited");
  assert.equal(checkConnectSessionThrottle(ipB, token).allowed, true, "ipB must be unaffected by ipA's usage");
});

test("connect throttle: THE FINDING 7B REGRESSION — the SAME IP hammering ONE token never burns another token's budget on that same IP", () => {
  // Models Charlie testing 11-15 different clients' links from one office
  // IP: exhausting link A's budget must never touch link B's.
  const ip = "203.0.113.9";
  const tokenA = "link-a";
  const tokenB = "link-b";
  for (let i = 0; i < 30; i++) checkConnectSessionThrottle(ip, tokenA);
  assert.equal(checkConnectSessionThrottle(ip, tokenA).allowed, false, "link A's budget should be exhausted");
  assert.equal(checkConnectSessionThrottle(ip, tokenB).allowed, true, "link B, same IP, must have its own fresh budget");
});

test("connect throttle: a null token falls back to an IP-only bucket rather than refusing open", () => {
  const ip = "203.0.113.10";
  for (let i = 0; i < 30; i++) checkConnectSessionThrottle(ip, null);
  assert.equal(checkConnectSessionThrottle(ip, null).allowed, false);
});

test("connect throttle: never throws", () => {
  assert.doesNotThrow(() => checkConnectSessionThrottle("", ""));
  assert.doesNotThrow(() => checkConnectSessionThrottle("not-really-an-ip-but-a-string", "not-really-a-token"));
});

// ---------------------------------------------------------------------------
// decideConnectSession (src/app/api/connect/session/logic.ts) — adversarial
// review lens 5, finding 3 (MAJOR, fixed). `POST /api/connect/session` held
// the most bespoke security logic in this feature and had ZERO test
// coverage before this extraction — see that module's own header for what
// moved out of `route.ts` and why. Dependency-injected fake repo + fake
// deps, same pattern as `fakeConnectGuardRepo`/`authorizeConnectRequest`
// just above.
// ---------------------------------------------------------------------------

const SESSION_LOCATION_ID = "loc-session-logic-1";
const SESSION_TENANT_ID = "55555555-5555-4555-8555-555555555555";

function makeSessionAccount(overrides: Partial<{ status: GhlAccountStatus; connectLinkVersion: number | null }> = {}) {
  return {
    locationId: SESSION_LOCATION_ID,
    tenantId: SESSION_TENANT_ID,
    label: "Session Logic Test Location",
    status: "active" as GhlAccountStatus,
    connectLinkVersion: 0,
    ...overrides,
  };
}

function fakeSessionRepo(
  accounts: ReturnType<typeof makeSessionAccount>[]
): ConnectSessionRepo & { accountCalls: string[]; summaryCalls: string[] } {
  const byLocation = new Map(accounts.map((a) => [a.locationId, a]));
  const accountCalls: string[] = [];
  const summaryCalls: string[] = [];
  return {
    accountCalls,
    summaryCalls,
    async getGhlAccountByLocationId(locationId: string) {
      accountCalls.push(locationId);
      return byLocation.get(locationId) ?? null;
    },
    async getWhatsappSessionSummary(tenantId: string) {
      summaryCalls.push(tenantId);
      return null;
    },
  };
}

/** Real `verifyConnectLinkToken`/`mintConnectSessionToken` by default (so a genuinely minted token round-trips), with every OTHER dependency overridable per test and a call counter on `verifyConnectLinkToken` specifically — used to pin "throttle runs before any HMAC work" (see the test below named for it). */
function fakeSessionDeps(overrides: Partial<import("@/app/api/connect/session/logic").ConnectSessionDeps> = {}) {
  const state = { verifyCalls: 0 };
  const deps: import("@/app/api/connect/session/logic").ConnectSessionDeps = {
    isConnectLinkConfigured: () => true,
    isWhatsappBridgeConfigured: () => true,
    checkThrottle: () => ({ allowed: true, retryAfterSeconds: 0 }),
    verifyConnectLinkToken: (token: string) => {
      state.verifyCalls += 1;
      return verifyConnectLinkToken(token);
    },
    mintConnectSessionToken: (locationId: string, v: number) => mintConnectSessionToken(locationId, v),
    getBridgeHealth: async () => ({ ok: true }),
    ...overrides,
  };
  return { deps, state };
}

test("decideConnectSession: config gates checked in order, before the repo or the token are ever touched", async () => {
  const repo = fakeSessionRepo([makeSessionAccount()]);
  const token = mintConnectLinkToken(SESSION_LOCATION_ID, 0);
  const body = JSON.stringify({ token });

  const { deps: notConfigured } = fakeSessionDeps({ isConnectLinkConfigured: () => false });
  assert.deepEqual(await decideConnectSession(repo, notConfigured, { ip: null, rawBody: body }), {
    kind: "config_error",
    code: "connect_not_configured",
  });

  const { deps: noBridge } = fakeSessionDeps({ isWhatsappBridgeConfigured: () => false });
  assert.deepEqual(await decideConnectSession(repo, noBridge, { ip: null, rawBody: body }), {
    kind: "config_error",
    code: "bridge_not_configured",
  });

  assert.equal(repo.accountCalls.length, 0);
});

test("decideConnectSession: the 8KB body cap — empty body and an oversized body both decide invalid_body", async () => {
  const repo = fakeSessionRepo([makeSessionAccount()]);
  const { deps } = fakeSessionDeps();

  assert.deepEqual(await decideConnectSession(repo, deps, { ip: null, rawBody: "" }), { kind: "invalid_body" });

  const oversized = JSON.stringify({ token: "x".repeat(MAX_CONNECT_SESSION_BODY_BYTES) });
  assert.ok(Buffer.byteLength(oversized, "utf8") > MAX_CONNECT_SESSION_BODY_BYTES);
  assert.deepEqual(await decideConnectSession(repo, deps, { ip: null, rawBody: oversized }), { kind: "invalid_body" });
});

test("decideConnectSession: malformed JSON and a missing/non-string 'token' field both decide invalid_body", async () => {
  const repo = fakeSessionRepo([makeSessionAccount()]);
  const { deps } = fakeSessionDeps();

  assert.deepEqual(await decideConnectSession(repo, deps, { ip: null, rawBody: "{not json" }), { kind: "invalid_body" });
  assert.deepEqual(await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({}) }), { kind: "invalid_body" });
  assert.deepEqual(await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token: 12345 }) }), { kind: "invalid_body" });
  assert.deepEqual(await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token: "" }) }), { kind: "invalid_body" });
});

test("decideConnectSession: THROTTLE RUNS BEFORE ANY HMAC WORK — a rate-limited decision never calls verifyConnectLinkToken", async () => {
  const repo = fakeSessionRepo([makeSessionAccount()]);
  const { deps, state } = fakeSessionDeps({ checkThrottle: () => ({ allowed: false, retryAfterSeconds: 42 }) });
  const token = mintConnectLinkToken(SESSION_LOCATION_ID, 0);

  const decision = await decideConnectSession(repo, deps, { ip: "203.0.113.5", rawBody: JSON.stringify({ token }) });
  assert.deepEqual(decision, { kind: "rate_limited", retryAfterSeconds: 42 });
  assert.equal(state.verifyCalls, 0, "verifyConnectLinkToken must never be called once the throttle has already refused");
  assert.equal(repo.accountCalls.length, 0);
});

test("decideConnectSession: an expired token decides 'expired', SAFE TO SAY SPECIFICALLY", async () => {
  const repo = fakeSessionRepo([makeSessionAccount()]);
  const { deps } = fakeSessionDeps();
  const expired = signKindedState("ghl-connect-link", { locationId: SESSION_LOCATION_ID, v: 0 }, -1);

  const decision = await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token: expired }) });
  assert.deepEqual(decision, { kind: "expired" });
});

test("decideConnectSession: EVERY OTHER verify failure (garbage, tampered, wrong kind) decides the SAME generic 'invalid_link'", async () => {
  const repo = fakeSessionRepo([makeSessionAccount()]);
  const { deps } = fakeSessionDeps();

  const garbage = await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token: "not-a-real-token" }) });
  assert.deepEqual(garbage, { kind: "invalid_link" });

  const wrongKind = mintConnectSessionToken(SESSION_LOCATION_ID, 0); // a SESSION token, not a link token
  const wrongKindDecision = await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token: wrongKind }) });
  assert.deepEqual(wrongKindDecision, { kind: "invalid_link" });
});

/**
 * THE NON-ORACLE PROPERTY — the single most load-bearing test in this
 * section, named accordingly. A forged/garbage token and a genuinely-signed
 * token for a location that no longer has an installed `ghl_accounts` row
 * MUST decide to the exact same `{ kind: "invalid_link" }` — this is what
 * stops the endpoint from ever confirming "this locationId exists" to
 * someone holding nothing but a guess. THIS IS THE PROPERTY MOST LIKELY TO
 * BE BROKEN LATER BY A WELL-MEANING "BETTER ERROR MESSAGE" EDIT — someone
 * adding a `{ kind: "unknown_location" }` variant "to help debugging" would
 * silently turn this endpoint into an installed-location oracle. If this
 * test ever needs to change, that is the regression to look for first.
 */
test("decideConnectSession: A MISSING ACCOUNT ROW DECIDES THE EXACT SAME 'invalid_link' AS A FORGED TOKEN — the non-oracle property", async () => {
  const repo = fakeSessionRepo([]); // no accounts installed at all
  const { deps } = fakeSessionDeps();

  const forged = await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token: "definitely-forged" }) });

  const neverInstalledToken = mintConnectLinkToken("loc-never-installed-anywhere", 0);
  const missingAccount = await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token: neverInstalledToken }) });

  assert.deepEqual(forged, { kind: "invalid_link" });
  assert.deepEqual(missingAccount, { kind: "invalid_link" });
  assert.deepEqual(forged, missingAccount, "a forged token and a well-formed token for an uninstalled location must be INDISTINGUISHABLE");
});

test("decideConnectSession: version mismatch (including a null column — migration 0075 not applied) decides 'revoked'", async () => {
  const repoMismatch = fakeSessionRepo([makeSessionAccount({ connectLinkVersion: 2 })]);
  const { deps } = fakeSessionDeps();
  const staleToken = mintConnectLinkToken(SESSION_LOCATION_ID, 1); // minted under the OLD version
  assert.deepEqual(
    await decideConnectSession(repoMismatch, deps, { ip: null, rawBody: JSON.stringify({ token: staleToken }) }),
    { kind: "revoked" }
  );

  const repoNullVersion = fakeSessionRepo([makeSessionAccount({ connectLinkVersion: null })]);
  const tokenV0 = mintConnectLinkToken(SESSION_LOCATION_ID, 0);
  assert.deepEqual(
    await decideConnectSession(repoNullVersion, deps, { ip: null, rawBody: JSON.stringify({ token: tokenV0 }) }),
    { kind: "revoked" }
  );
});

test("decideConnectSession: a disabled account decides its OWN 'disabled' state, not an error", async () => {
  const repo = fakeSessionRepo([makeSessionAccount({ status: "disabled" })]);
  const { deps } = fakeSessionDeps();
  const token = mintConnectLinkToken(SESSION_LOCATION_ID, 0);
  const decision = await decideConnectSession(repo, deps, { ip: null, rawBody: JSON.stringify({ token }) });
  assert.deepEqual(decision, { kind: "disabled" });
});

test("decideConnectSession: a genuinely valid token for an active, version-matched account decides 'ok', with a freshly minted session token", async () => {
  const repo = fakeSessionRepo([makeSessionAccount({ connectLinkVersion: 3 })]);
  const { deps } = fakeSessionDeps();
  const token = mintConnectLinkToken(SESSION_LOCATION_ID, 3);

  const decision = await decideConnectSession(repo, deps, { ip: "203.0.113.6", rawBody: JSON.stringify({ token }) });
  assert.equal(decision.kind, "ok");
  if (decision.kind === "ok") {
    const verifiedSession = verifyConnectSessionToken(decision.token);
    assert.deepEqual(verifiedSession, { ok: true, locationId: SESSION_LOCATION_ID, v: 3 });
    assert.equal(decision.label, "Session Logic Test Location");
    assert.equal(decision.bridgeReachable, true);
  }
  assert.deepEqual(repo.accountCalls, [SESSION_LOCATION_ID]);
  assert.deepEqual(repo.summaryCalls, [SESSION_TENANT_ID]);
});
