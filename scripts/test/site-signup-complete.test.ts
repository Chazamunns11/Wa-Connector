import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(site)/signup/complete/page.tsx"), "utf8");

test("signup complete only says the card is saved when there is a session_id, and that nothing was charged", () => {
  assert.doesNotMatch(src, /trial has started/);
  const claim = src.indexOf("Card saved. Nothing has been charged: each WhatsApp number you add gets its own");
  assert.ok(claim > 0);
  // the claim must sit inside a sessionId-guarded branch
  const before = src.slice(Math.max(0, claim - 200), claim);
  assert.match(before, /sessionId\s*\?/);
});

test("signup complete without a session_id points to the login page", () => {
  assert.match(src, /If you&apos;ve just finished checkout, request a sign-in link from the/);
  assert.match(src, /href="\/login"/);
});
