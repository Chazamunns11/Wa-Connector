/** The 30-minute GoHighLevel claim token (signup?claim=...). */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ONBOARD_STATE_SECRET ||= "test-secret-not-used-anywhere-real";

import { CLAIM_TOKEN_TTL_MS, claimSignupUrl, isClaimConfigured, mintClaimToken, verifyClaimToken } from "@/lib/ghl-claim";
import { signKindedState } from "@/lib/signed-state";

test("TTL is 30 minutes", () => assert.equal(CLAIM_TOKEN_TTL_MS, 30 * 60 * 1000));

test("mint then verify returns the location id", () => {
  assert.deepEqual(verifyClaimToken(mintClaimToken("loc_1")), { locationId: "loc_1" });
});

test("a token of another kind is refused", () => {
  assert.equal(verifyClaimToken(signKindedState("ghl-embed", { locationId: "loc_1" })), null);
});

test("a tampered token is refused", () => {
  const t = mintClaimToken("loc_1");
  const bad = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
  assert.equal(verifyClaimToken(bad), null);
});

test("an expired token is refused", () => {
  assert.equal(verifyClaimToken(signKindedState("ghl-claim", { locationId: "l" }, -1)), null);
});

test("a payload without a string locationId is refused", () => {
  assert.equal(verifyClaimToken(signKindedState("ghl-claim", { locationId: 5 })), null);
  assert.equal(verifyClaimToken(signKindedState("ghl-claim", {})), null);
});

test("claimSignupUrl builds the signup link", () => {
  assert.ok(claimSignupUrl("https://x", "loc").startsWith("https://x/signup?claim="));
});

test("with the dedicated secret unset nothing mints or verifies, even with CRON_SECRET set", () => {
  const prevO = process.env.ONBOARD_STATE_SECRET;
  const prevC = process.env.CRON_SECRET;
  const token = mintClaimToken("loc_1");
  try {
    delete process.env.ONBOARD_STATE_SECRET;
    process.env.CRON_SECRET = "cron";
    assert.equal(isClaimConfigured(), false);
    assert.equal(verifyClaimToken(token), null);
    assert.throws(() => mintClaimToken("loc_1"));
  } finally {
    process.env.ONBOARD_STATE_SECRET = prevO;
    if (prevC === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevC;
  }
});
