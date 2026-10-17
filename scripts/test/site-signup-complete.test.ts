import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(site)/signup/complete/page.tsx"), "utf8");

test("signup complete only claims the trial started when there is a session_id, and never a saved card", () => {
  assert.doesNotMatch(src, /Your card (was|is) saved/);
  const claim = src.indexOf("-day free trial has started. No card needed until it ends.");
  assert.ok(claim > 0);
  // the claim must sit inside a sessionId-guarded branch
  const before = src.slice(Math.max(0, claim - 200), claim);
  assert.match(before, /sessionId\s*\?/);
});

test("signup complete without a session_id points to the login page", () => {
  assert.match(src, /If you&apos;ve just finished checkout, request a sign-in link from the/);
  assert.match(src, /href="\/login"/);
});
