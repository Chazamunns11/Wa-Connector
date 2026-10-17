import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(site)/signup/complete/page.tsx"), "utf8");

test("signup complete only claims a saved card when there is a session_id", () => {
  assert.doesNotMatch(src, /Your card was saved/);
  const claim = src.indexOf("Your card is saved and your");
  assert.ok(claim > 0);
  // the claim must sit inside a sessionId-guarded branch
  const before = src.slice(Math.max(0, claim - 200), claim);
  assert.match(before, /sessionId\s*\?/);
});

test("signup complete without a session_id points to the login page", () => {
  assert.match(src, /If you&apos;ve just finished checkout, request a sign-in link from the/);
  assert.match(src, /href="\/login"/);
});
