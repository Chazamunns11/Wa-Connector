import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyStripeSignature } from "@/lib/stripe/webhook";

const secret = "whsec_test";
const body = '{"id":"evt_1"}';
const hmac = (s: string, t: number, b: string) => createHmac("sha256", s).update(`${t}.${b}`).digest("hex");

test("verifyStripeSignature: valid, wrong secret, stale, null, multi-v1, no t", () => {
  const t = 1700000000;
  const header = `t=${t},v1=${hmac(secret, t, body)}`;
  assert.equal(verifyStripeSignature(body, header, secret, t + 100), true);
  assert.equal(verifyStripeSignature(body, header, "whsec_other", t + 100), false);
  assert.equal(verifyStripeSignature(body, header, secret, t + 400), false);
  assert.equal(verifyStripeSignature(body, null, secret, t + 100), false);
  assert.equal(verifyStripeSignature(body + " ", header, secret, t + 100), false);
  const multi = `t=${t},v1=${"0".repeat(64)},v1=${hmac(secret, t, body)}`;
  assert.equal(verifyStripeSignature(body, multi, secret, t + 100), true);
  assert.equal(verifyStripeSignature(body, `v1=${hmac(secret, t, body)}`, secret, t + 100), false);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=short`, secret, t + 100), false);
});
