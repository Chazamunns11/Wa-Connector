import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIGNUP_ERROR_MESSAGES,
  signupRedirectQuery,
  signupStateFromParams,
  validateSignup,
} from "@/lib/site/signup";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("validateSignup accepts a good form and lower-cases the email", () => {
  const r = validateSignup({ accountName: "  Acme Gym  ", kind: "business", email: "Sam@Example.CO.uk" });
  assert.deepEqual(r, { ok: true, value: { accountName: "Acme Gym", kind: "business", email: "sam@example.co.uk" } });
});

test("validateSignup rejects a 1-char name, an unknown kind, and 'nobody' as email, keeping the values", () => {
  const r = validateSignup({ accountName: "A", kind: "partner", email: "nobody" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(Object.keys(r.errors).sort(), ["accountName", "email", "kind"]);
  assert.equal(r.values.accountName, "A");
  assert.equal(r.values.email, "nobody");
  assert.equal(r.values.kind, undefined);
});

test("validateSignup rejects missing fields, long names and malformed emails", () => {
  const r = validateSignup({ accountName: "x".repeat(81), kind: null, email: "a@b" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.accountName && r.errors.kind && r.errors.email);
  for (const bad of ["a@@b.co", "a@b.", "@b.co", "a b@c.co", `${"a".repeat(320)}@b.co`]) {
    assert.equal(validateSignup({ accountName: "Acme", kind: "agency", email: bad }).ok, false, bad);
  }
});

test("signup errors round-trip through the redirect query", () => {
  const r = validateSignup({ accountName: "A", kind: "agency", email: "nobody" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  const q = signupRedirectQuery(r);
  const state = signupStateFromParams(Object.fromEntries(new URLSearchParams(q)));
  assert.deepEqual(Object.keys(state.errors).sort(), Object.keys(r.errors).sort());
  assert.equal(state.errors.email, SIGNUP_ERROR_MESSAGES.email_invalid);
  assert.doesNotMatch(q, /Enter|Choose/, "URL carries codes, not message text");
  assert.deepEqual(state.values, r.values);
});

test("signupStateFromParams ignores unknown kinds and array values", () => {
  const hostile = signupStateFromParams({ "error.email": "Call 0800 scam", "error.kind": "__proto__", "error.accountName": "toString" });
  assert.deepEqual(hostile.errors, {});
  const s = signupStateFromParams({ "v.kind": "evil", "v.email": ["a", "b"], "error.kind": "kind_required" });
  assert.equal(s.values.kind, undefined);
  assert.equal(s.values.email, undefined);
  assert.equal(s.errors.kind, SIGNUP_ERROR_MESSAGES.kind_required);
});

test("signup error redirect ends at the focusable summary", () => {
  assert.match(read("src/app/(site)/signup/actions.ts"), /#signup-errors/);
  assert.match(read("src/components/auth/SignupForm.tsx"), /id="signup-errors"\s+tabIndex=\{-1\}/);
});

test("signup action only emails a link: no account, profile or admin user before the email is proven", () => {
  const src = read("src/app/(site)/signup/actions.ts");
  assert.match(src, /prepareSignup\(/);
  assert.match(src, /shouldCreateUser: true/);
  assert.match(src, /data: prepared\.data/);
  assert.match(src, /redirect\("\/signup\/check-email"\)/);
  assert.doesNotMatch(src, /createAccount|createProfile|admin\.createUser|createCheckoutSession|startSignup\(/);
  assert.doesNotMatch(src, /api\.stripe\.com/);
});

test("the login form still never creates users", () => {
  assert.match(read("src/app/login/actions.ts"), /shouldCreateUser: false/);
  assert.doesNotMatch(read("src/app/login/actions.ts"), /shouldCreateUser: true/);
});

test("auth callback completes a pending signup after the exchange, with fixed redirects and no logged claim", () => {
  const src = read("src/app/auth/callback/route.ts");
  assert.match(src, /exchangeCodeForSession\(code\)/);
  assert.match(src, /decideCallback\(/);
  assert.match(src, /completeSignup\(/);
  assert.match(src, /verifyClaim: verifyClaimToken/);
  assert.doesNotMatch(src, /searchParams\.get\("(next|redirect|returnTo)/);
  assert.doesNotMatch(src, /console\.\w+\(/);
});

test("check-email page exists and is noindex", () => {
  const src = read("src/app/(site)/signup/check-email/page.tsx");
  assert.match(src, /Check your email to continue/);
  assert.match(src, /robots:\s*\{\s*index:\s*false/);
});

test("signup action carries the claim through every redirect and never logs it", () => {
  const src = read("src/app/(site)/signup/actions.ts");
  assert.match(src, /signupUrl\(new URLSearchParams\(signupRedirectQuery\(result\)\), claim/);
  assert.match(src, /error: "unavailable"[^\n]*claim/);
  assert.match(src, /error: "failed"[^\n]*claim/);
  assert.doesNotMatch(src, /console\.\w+\([^)]*claim/i);
});

test("signup pages are noindex and no longer preview", () => {
  for (const f of ["signup/page.tsx", "signup/complete/page.tsx"]) {
    const src = read(`src/app/(site)/${f}`);
    assert.match(src, /robots:\s*\{\s*index:\s*false/);
    assert.doesNotMatch(src, /preview/i);
  }
  assert.equal(existsSync(join(root, "src/app/(site)/signup/checkout/page.tsx")), false);
});

test("the auth shell header stacks below 640px", () => {
  assert.match(read("src/components/auth/AuthShell.tsx"), /flex-col[^"]*sm:flex-row|flex-col[^"]*sm:items/);
});
