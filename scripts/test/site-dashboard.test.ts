import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const PAGES = ["src/app/(app)/dashboard/page.tsx", "src/app/(app)/dashboard/billing/page.tsx"];

test("dashboard and billing pages read only through getAccountDataSource", () => {
  for (const f of PAGES) {
    const src = read(f);
    assert.match(src, /from "@\/lib\/account-data"/, f);
    assert.match(src, /getAccountDataSource\(/, f);
    assert.doesNotMatch(src, /@\/lib\/data/, f);
  }
});

test("RowActions.tsx decides enablement through rowActionsFor", () => {
  const src = read("src/components/app/RowActions.tsx");
  assert.match(src, /import \{[^}]*rowActionsFor[^}]*\} from "@\/lib\/account-data\/derive"/);
  assert.doesNotMatch(src, /state\.kind\s*===/);
});

test("dashboard action never imports supabase or stripe", () => {
  const src = read("src/app/(app)/dashboard/actions.ts");
  assert.match(src, /^"use server"/);
  assert.doesNotMatch(src, /supabase|stripe/i);
});

// The dashboard header (and its badge) lives in PlanHeader, which the page renders.
const HEADERS = ["src/components/app/PlanHeader.tsx", "src/app/(app)/dashboard/billing/page.tsx"];

test("both preview pages render PreviewBadge and are noindex", () => {
  assert.match(read("src/app/(app)/dashboard/page.tsx"), /<PlanHeader\b/);
  for (const f of HEADERS) assert.match(read(f), /<PreviewBadge \/>/, f);
  for (const f of PAGES) assert.match(read(f), /robots:\s*\{\s*index:\s*false/, f);
});

test("the preview badge stacks on its own line below 640px", () => {
  for (const f of HEADERS) assert.match(read(f), /flex-col[^"]*sm:flex-row/, f);
});

test("location rows use the table from 768px and cards below", () => {
  const src = read("src/components/app/LocationTable.tsx");
  assert.match(src, /hidden[^"]*md:grid/);
  assert.match(src, /md:sr-only/);
});

test("the notice and banner are announced", () => {
  assert.match(read("src/app/(app)/dashboard/page.tsx"), /role="status"/);
  assert.match(read("src/components/app/PlanHeader.tsx"), /role="alert"/);
});

test("column labels stay in the accessibility tree at every width", () => {
  const src = read("src/components/app/LocationTable.tsx");
  assert.match(src, /md:sr-only/);
  assert.doesNotMatch(src, /text-ink-faint md:hidden/);
});

test("scenario URLs come from one helper", () => {
  assert.match(read("src/lib/site/dashboard-url.ts"), /export function billingHref/);
  assert.match(read("src/app/(app)/dashboard/page.tsx"), /billingHref\(/);
  assert.doesNotMatch(read("src/app/(app)/dashboard/page.tsx"), /\?scenario=\$/);
  assert.doesNotMatch(read("src/components/app/ScenarioSwitcher.tsx"), /scenario=/);
});

test("the footer nav hugs its links", () => {
  assert.match(read("src/components/site/SiteFooter.tsx"), /aria-label="Footer" className="[^"]*self-start/);
});
