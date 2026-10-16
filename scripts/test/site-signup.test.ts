import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkoutQuery,
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

test("checkoutQuery encodes the three fields", () => {
  const q = checkoutQuery({ accountName: "Smith & Sons", kind: "agency", email: "a+b@x.co" });
  assert.equal(q, "?name=Smith+%26+Sons&kind=agency&email=a%2Bb%40x.co");
});

test("signup errors round-trip through the redirect query", () => {
  const r = validateSignup({ accountName: "A", kind: "agency", email: "nobody" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  const q = signupRedirectQuery(r);
  const state = signupStateFromParams(Object.fromEntries(new URLSearchParams(q)));
  assert.deepEqual(state.errors, r.errors);
  assert.deepEqual(state.values, r.values);
});

test("signupStateFromParams ignores unknown kinds and array values", () => {
  const s = signupStateFromParams({ "v.kind": "evil", "v.email": ["a", "b"], "error.kind": "Pick one" });
  assert.equal(s.values.kind, undefined);
  assert.equal(s.values.email, undefined);
  assert.equal(s.errors.kind, "Pick one");
});

test("signup action never imports supabase or stripe", () => {
  assert.doesNotMatch(read("src/app/(site)/signup/actions.ts"), /supabase|stripe/i);
});

test("both preview pages render PreviewBadge and are noindex", () => {
  const signup = read("src/app/(site)/signup/page.tsx");
  assert.match(signup, /<AuthShell[^>]*\bpreview\b/);
  assert.match(read("src/components/auth/AuthShell.tsx"), /<PreviewBadge \/>/);
  assert.match(read("src/app/(site)/signup/checkout/page.tsx"), /<PreviewBadge \/>/);
  for (const src of [signup, read("src/app/(site)/signup/checkout/page.tsx")]) {
    assert.match(src, /robots:\s*\{\s*index:\s*false/);
  }
});

test("the preview badge stacks on its own line below 640px", () => {
  assert.match(read("src/components/auth/AuthShell.tsx"), /flex-col[^"]*sm:flex-row|flex-col[^"]*sm:items/);
});
