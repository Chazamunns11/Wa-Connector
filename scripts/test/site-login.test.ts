import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const login = readFileSync("src/app/login/page.tsx", "utf8");
const proxy = readFileSync("src/proxy.ts", "utf8");

test("login page uses AuthShell and EmailLinkForm and keeps the foundation action", () => {
  assert.match(login, /AuthShell/);
  assert.match(login, /EmailLinkForm/);
  assert.match(login, /sendLoginLinkAction/);
});

test("login copy does not say owner", () => {
  assert.doesNotMatch(login, /owner account/i);
});

test("proxy lets non-admin paths through without Supabase env", () => {
  const missing = proxy.indexOf("if (!url || !anonKey)");
  assert.ok(missing > -1);
  const block = proxy.slice(missing, proxy.indexOf("let response", missing));
  const guard = block.indexOf("isOwnerPath(pathname)");
  const thrown = block.indexOf("throw new Error");
  assert.ok(guard > -1 && thrown > guard, "throw must sit inside an isOwnerPath check");
  assert.match(block, /NextResponse\.next\(\{ request \}\)/);
});
