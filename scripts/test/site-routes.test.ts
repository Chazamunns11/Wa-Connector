import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  NAV_LINKS,
  NOINDEX_ROUTES,
  PUBLIC_ROUTES,
  SITE_ROUTES,
} from "@/lib/site/routes";

const root = process.cwd();

// Route -> page file. `/login` is owned by the foundation branch (Task 11
// restyles it), so it has no entry here.
const PAGE_FILES: Record<string, string> = {
  [SITE_ROUTES.home]: "src/app/(site)/page.tsx",
  [SITE_ROUTES.pricing]: "src/app/(site)/pricing/page.tsx",
  [SITE_ROUTES.docs]: "src/app/(site)/docs/page.tsx",
  [SITE_ROUTES.setup]: "src/app/(site)/docs/setup/page.tsx",
  [SITE_ROUTES.faq]: "src/app/(site)/docs/faq/page.tsx",
  [SITE_ROUTES.billingHelp]: "src/app/(site)/docs/billing/page.tsx",
  [SITE_ROUTES.privacySummary]: "src/app/(site)/docs/privacy-and-data/page.tsx",
  [SITE_ROUTES.terms]: "src/app/(site)/legal/terms/page.tsx",
  [SITE_ROUTES.privacy]: "src/app/(site)/legal/privacy/page.tsx",
  [SITE_ROUTES.signup]: "src/app/(site)/signup/page.tsx",
  [SITE_ROUTES.dashboard]: "src/app/(app)/dashboard/page.tsx",
  [SITE_ROUTES.billing]: "src/app/(app)/dashboard/billing/page.tsx",
};

// Routes whose pages later tasks create (4-10). Each task removes its own
// entries; an empty set means every page exists.
const PENDING = new Set<string>([
  SITE_ROUTES.docs,
  SITE_ROUTES.setup,
  SITE_ROUTES.faq,
  SITE_ROUTES.billingHelp,
  SITE_ROUTES.privacySummary,
  SITE_ROUTES.terms,
  SITE_ROUTES.privacy,
  SITE_ROUTES.signup,
  SITE_ROUTES.dashboard,
  SITE_ROUTES.billing,
]);

test("every SITE_ROUTES entry has a page file in the expected route group", () => {
  for (const route of Object.values(SITE_ROUTES)) {
    if (route === SITE_ROUTES.login) continue; // foundation-owned
    const file = PAGE_FILES[route];
    assert.ok(file, `no page file mapped for ${route}`);
    if (PENDING.has(route)) continue; // todo: created by a later task
    assert.ok(existsSync(join(root, file)), `${route} should exist at ${file}`);
  }
});

test("src/app/page.tsx is gone", () => {
  assert.equal(existsSync(join(root, "src/app/page.tsx")), false);
});

test("PUBLIC_ROUTES and NOINDEX_ROUTES are disjoint and together cover SITE_ROUTES", () => {
  const pub = new Set(PUBLIC_ROUTES);
  const noindex = new Set(NOINDEX_ROUTES);
  for (const r of pub) assert.ok(!noindex.has(r), `${r} is in both`);
  const all = new Set([...pub, ...noindex]);
  assert.deepEqual([...all].sort(), Object.values(SITE_ROUTES).sort());
});

test("shell files exist and nav links point at known routes", () => {
  for (const f of [
    "src/app/(site)/layout.tsx",
    "src/app/(site)/not-found.tsx",
    "src/app/(app)/layout.tsx",
    "src/app/robots.ts",
    "src/app/sitemap.ts",
  ]) {
    assert.ok(existsSync(join(root, f)), `${f} missing`);
  }
  const known = new Set<string>(Object.values(SITE_ROUTES));
  for (const l of NAV_LINKS) assert.ok(known.has(l.href), l.href);
});
