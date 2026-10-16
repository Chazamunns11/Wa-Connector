/**
 * Crypto unit checks (hard rule 1, proven without any live connection —
 * hard rule 6): roundtrip, tamper detection, cross-coach AAD rejection, and
 * key rotation via the previous-key slot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createCredsCipher, keyFingerprint, whatsappCredsAad, whatsappKeyAad } from "../src/crypto.js";

const keyA = randomBytes(32);
const keyB = randomBytes(32);

test("roundtrip: decrypt(encrypt(x)) === x", () => {
  const cipher = createCredsCipher(keyA, null);
  const aad = whatsappCredsAad("11111111-1111-4111-8111-111111111111");
  const plaintext = JSON.stringify({ noiseKey: "secret-material", registered: true });
  assert.equal(cipher.decrypt(cipher.encrypt(plaintext, aad), aad), plaintext);
});

test("tampered ciphertext fails loudly (GCM tag)", () => {
  const cipher = createCredsCipher(keyA, null);
  const aad = whatsappCredsAad("11111111-1111-4111-8111-111111111111");
  const envelope = cipher.encrypt("creds", aad);
  const parts = envelope.split(".");
  // Flip a byte inside the ciphertext segment.
  const ct = Buffer.from(parts[4], "base64url");
  ct[0] ^= 0xff;
  parts[4] = ct.toString("base64url");
  assert.throws(() => cipher.decrypt(parts.join("."), aad));
});

test("cross-coach replay is rejected: coach A's blob cannot decrypt under coach B's AAD", () => {
  const cipher = createCredsCipher(keyA, null);
  const envelope = cipher.encrypt("creds", whatsappCredsAad("11111111-1111-4111-8111-111111111111"));
  assert.throws(() => cipher.decrypt(envelope, whatsappCredsAad("22222222-2222-4222-8222-222222222222")));
});

test("cross-row replay is rejected for key rows too (category/key id in AAD)", () => {
  const cipher = createCredsCipher(keyA, null);
  const coach = "11111111-1111-4111-8111-111111111111";
  const envelope = cipher.encrypt("session-key", whatsappKeyAad(coach, "session", "447700900123.0"));
  assert.throws(() => cipher.decrypt(envelope, whatsappKeyAad(coach, "session", "447700900999.0")));
  assert.throws(() => cipher.decrypt(envelope, whatsappKeyAad(coach, "pre-key", "447700900123.0")));
});

test("rotation: old envelopes decrypt via previous key; new writes use the active key", () => {
  const before = createCredsCipher(keyA, null);
  const aad = whatsappCredsAad("11111111-1111-4111-8111-111111111111");
  const oldEnvelope = before.encrypt("creds", aad);

  // Rotate: keyB active, keyA demoted to previous.
  const after = createCredsCipher(keyB, keyA);
  assert.equal(after.decrypt(oldEnvelope, aad), "creds"); // old rows still readable (previous-key path).
  const newEnvelope = after.encrypt("creds", aad);
  // New writes carry the NEW key's fingerprint; the old envelope keeps the
  // old key's — the fingerprint identifies the key, never the env slot.
  assert.ok(newEnvelope.startsWith(`v1.${keyFingerprint(keyB)}.`));
  assert.ok(oldEnvelope.startsWith(`v1.${keyFingerprint(keyA)}.`));
  // And once the previous key is dropped, old envelopes stop decrypting.
  const finished = createCredsCipher(keyB, null);
  assert.throws(() => finished.decrypt(oldEnvelope, aad));
  assert.equal(finished.decrypt(newEnvelope, aad), "creds");
});

test("envelope never contains the plaintext or key material", () => {
  const cipher = createCredsCipher(keyA, null);
  const envelope = cipher.encrypt("PLAINTEXT-SENTINEL", whatsappCredsAad("11111111-1111-4111-8111-111111111111"));
  assert.ok(!envelope.includes("PLAINTEXT-SENTINEL"));
  assert.ok(!envelope.includes(keyA.toString("base64url")));
});
