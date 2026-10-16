import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("dashboard actions are server actions behind requireAccountSession", () => {
  const src = read("src/app/(app)/dashboard/actions.ts");
  assert.match(src, /^"use server"/);
  assert.match(src, /requireAccountSession\(\)/);
  assert.doesNotMatch(src, /@supabase/);
});

// The dashboard header lives in PlanHeader, which the page renders.
test("both pages are noindex and carry no preview markers", () => {
  assert.match(read("src/app/(app)/dashboard/page.tsx"), /<PlanHeader\b/);
  for (const f of PAGES) assert.match(read(f), /robots:\s*\{\s*index:\s*false/, f);
  for (const f of [...PAGES, "src/components/app/PlanHeader.tsx", "src/components/app/RowActions.tsx", "src/components/app/LocationTable.tsx"]) {
    assert.doesNotMatch(read(f), /PreviewBadge|ScenarioSwitcher|scenario|\(preview\)|\(sample\)|Sample data/i, f);
  }
  for (const f of ["src/lib/account-data/preview.ts", "src/components/app/ScenarioSwitcher.tsx", "src/components/site/PreviewBadge.tsx"]) {
    assert.equal(existsSync(join(process.cwd(), f)), false, f);
  }
});

test("pages gate on requireAccountSession and pass the session to the data source", () => {
  for (const f of PAGES) {
    const src = read(f);
    assert.match(src, /const session = await requireAccountSession\(\)/, f);
    assert.match(src, /getAccountDataSource\(session/, f);
  }
});

test("a pending account gets a working add-a-card form button, not a link to nowhere", () => {
  const header = read("src/components/app/PlanHeader.tsx");
  assert.match(header, /pendingCheckoutAction/);
  assert.match(header, /Add a card to start your trial/);
  assert.match(read("src/app/(app)/dashboard/page.tsx"), /pendingCheckoutAction=\{[^}]*startCheckoutAction/);
  assert.match(read("src/app/(app)/dashboard/actions.ts"), /export async function startCheckoutAction/);
});

test("the connect button leaves the app for the OAuth start route", () => {
  assert.match(read("src/lib/site/routes.ts"), /connectGhl: "\/api\/crm\/oauth\/start"/);
  assert.match(read("src/components/app/PlanHeader.tsx"), /<a href=\{APP_ROUTE_HANDLERS\.connectGhl\}/);
});

test("the result and GHL notices are announced", () => {
  assert.match(read("src/components/app/GhlResultNotice.tsx"), /role="status"/);
  assert.match(read("src/components/app/GhlResultNotice.tsx"), /already connected to another/);
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

test("dashboard URLs come from one helper", () => {
  assert.match(read("src/lib/site/dashboard-url.ts"), /export function billingHref/);
  assert.match(read("src/app/(app)/dashboard/page.tsx"), /billingHref\(/);
});

test("the footer nav hugs its links", () => {
  assert.match(read("src/components/site/SiteFooter.tsx"), /aria-label="Footer" className="[^"]*self-start/);
});
