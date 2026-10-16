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
import { redactBridgeSessionResult } from "@/lib/bridge-panel-guard";
import { checkConnectSessionThrottle } from "@/lib/connect-throttle";
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
// redactBridgeSessionResult (src/lib/bridge-panel-guard.ts) — shared with the
// embed guard now. Confirms `coachId` never survives into a connect route's
// response either.
// ---------------------------------------------------------------------------

const TENANT_ID = "44444444-4444-4444-8444-444444444444";

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

