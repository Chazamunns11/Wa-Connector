import test from "node:test";
import assert from "node:assert/strict";

import { normalisePhoneE164, isE164 } from "@/lib/phone";

// --- phone ------------------------------------------------------------------

test("phone: GB mobile shapes normalise to E.164", () => {
  for (const raw of ["07700900123", "+447700900123", "0044 7700 900123", "+44 (0)7700 900123", "07700 900 123"]) {
    assert.equal(normalisePhoneE164(raw, "GB"), "+447700900123", raw);
  }
});

test("phone: a spreadsheet's leading apostrophe is stripped", () => {
  // Excel/Sheets CSV exports write '07700900123 to preserve the leading zero,
  // which is exactly the shape of the GoHighLevel contact backfill.
  assert.equal(normalisePhoneE164("'07700900123", "GB"), "+447700900123");
});

test("phone: the +44 trunk-zero mistake is repaired", () => {
  assert.equal(normalisePhoneE164("+4407700900123", "GB"), "+447700900123");
});

test("phone: international numbers are never re-regionalised", () => {
  assert.equal(normalisePhoneE164("+34600123456", "GB"), "+34600123456");
});

test("phone: a bare national number with no region resolves to null, not a guess", () => {
  assert.equal(normalisePhoneE164("07700900123", null), null);
});

test("phone: junk and non-strings return null and never throw", () => {
  for (const raw of ["", "  ", "nope", "12", null, undefined, 447700900123 as unknown as string, {} as unknown as string]) {
    assert.equal(normalisePhoneE164(raw, "GB"), null, String(raw));
  }
});

test("phone: isE164 rejects a leading zero and over-length input", () => {
  assert.equal(isE164("+447700900123"), true);
  assert.equal(isE164("+0447700900123"), false);
  assert.equal(isE164("+4477009001234567890"), false);
  assert.equal(isE164("447700900123"), false);
});
