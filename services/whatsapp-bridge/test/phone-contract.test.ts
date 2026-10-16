/**
 * Hard rule 3's lockstep proof: the bridge's E.164 predicate is the SAME
 * contract as the portal's src/lib/phone.ts, not a looser re-implementation.
 * The last test reads the portal file straight off disk and asserts the
 * shared regex source appears in it verbatim — if either side ever changes
 * alone, this test fails until both move together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isE164 } from "../src/phone.js";

test("accepts strict E.164 only", () => {
  assert.equal(isE164("+447700900123"), true);
  assert.equal(isE164("+14155552671"), true);
  assert.equal(isE164("+8613912345678"), true);
});

test("rejects everything the portal's normaliser would have already fixed or refused", () => {
  for (const bad of [
    "07700900123", // bare national — must be normalised at capture, never here
    "0044 7700 900123", // written international prefix
    "+44 7700 900123", // separators
    "+4407700900123x2", // extension garbage
    "+0447700900123", // leading zero country code
    "+123456", // too short (6 digits after +)
    "+1234567890123456", // 16 digits — past the ITU max of 15
    "", // empty
    "prospect@example.com", // wrong field entirely
  ]) {
    assert.equal(isE164(bad), false, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test("LOCKSTEP: the exact regex source also appears in the portal's src/lib/phone.ts", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const portalPhone = readFileSync(path.resolve(here, "../../../src/lib/phone.ts"), "utf8");
  const bridgePhone = readFileSync(path.resolve(here, "../src/phone.ts"), "utf8");
  const SHARED = "/^\\+[1-9]\\d{6,14}$/";
  assert.ok(portalPhone.includes(SHARED), "portal src/lib/phone.ts no longer contains the shared E.164 regex — update BOTH sides together");
  assert.ok(bridgePhone.includes(SHARED), "bridge src/phone.ts no longer contains the shared E.164 regex — update BOTH sides together");
});
