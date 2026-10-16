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

const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
const callback = readFileSync("src/app/auth/callback/route.ts", "utf8");
const actions = readFileSync("src/app/login/actions.ts", "utf8");

test("proxy gates /dashboard on a signed-in user and still excludes api", () => {
  assert.match(proxy, /"\/dashboard"/);
  assert.match(proxy, /\(\?!api\|/);
});

test("app layout logs out with the sign-out action, not a link", () => {
  assert.match(layout, /import \{ signOutAction \}/);
  assert.match(layout, /<form action=\{signOutAction\}>/);
  assert.doesNotMatch(layout, /SITE_ROUTES\.login/);
});

test("auth callback routes owners to /admin and accounts to /dashboard", () => {
  assert.match(callback, /"\/admin"|\/admin/);
  assert.match(callback, /\/dashboard/);
  assert.match(callback, /no_account/);
});

test("sign-out action signs out then redirects to /login; login page explains the new errors", () => {
  assert.match(actions, /export async function signOutAction/);
  assert.match(actions, /auth\.signOut\(\)/);
  assert.match(login, /no_account/);
  assert.match(login, /checkout/);
});
