import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Task 14C: pricing, docs, setup, auth and legal in Direction B (coral field).
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

test("pricing: coral top, slab calculator, ruled comparison, Mist billing band", () => {
  const page = read("src/app/(site)/pricing/page.tsx");
  const firstSection = page.slice(page.indexOf("<section"), page.indexOf("</section>"));
  assert.match(firstSection, /surface-coral/);
  assert.ok(page.includes("slab"));
  assert.match(page, /<section className="[^"]*bg-raised/);
  assert.ok(!page.includes("section-rule"));
  assert.ok(!page.includes("divide-x"));
  assert.ok(page.includes("There is no setup fee, and {brand.name} does not charge per message."));
  const calc = read("src/components/site/PricingCalculator.tsx");
  assert.ok(calc.includes("htmlFor"));
  assert.ok(calc.includes('aria-live="polite"'));
  assert.ok(calc.includes('role="status"'));
  assert.ok(!calc.includes("aria-label"));
  assert.ok(calc.includes("If I activate"));
});

test("setup guide: disclosure troubleshooting, Ink numerals, slab sample chrome", () => {
  const page = read("src/app/(site)/docs/setup/page.tsx");
  assert.match(page, /<details[^>]*className="disclosure/);
  assert.ok(!page.includes("&minus;"));
  assert.match(read("src/components/site/SetupStep.tsx"), /text-ink[^-]/);
  const css = stripCss(read("src/app/globals.css"));
  const chrome = [...css.matchAll(/\n\.sample-chrome \{([^}]*)\}/g)].map((m) => m[1]).join("\n");
  assert.match(chrome, /border:\s*3px solid var\(--color-ink\)/);
  assert.match(chrome, /border-radius:\s*20px/);
});

test("docs pages: coral top band and slab tiles", () => {
  assert.ok(read("src/components/site/PageTop.tsx").includes("surface-coral"));
  for (const p of ["docs/page", "docs/faq/page", "docs/billing/page", "docs/privacy-and-data/page", "docs/setup/page"]) {
    assert.ok(read(`src/app/(site)/${p}.tsx`).includes("<PageTop"), `${p} uses PageTop`);
  }
  assert.ok(read("src/app/(site)/docs/page.tsx").includes("slab"));
  assert.ok(!read("src/app/(site)/docs/page.tsx").includes("rounded-lg border bg-raised"));
  assert.match(read("src/app/(site)/docs/faq/page.tsx"), /<section className="[^"]*bg-raised/);
});

test("auth forms use the site pills, not ui/Button", () => {
  for (const f of ["src/components/auth/SignupForm.tsx", "src/components/auth/EmailLinkForm.tsx"]) {
    const s = read(f);
    assert.ok(!s.includes("@/components/ui/Button"), f);
    assert.ok(s.includes('siteButton("coral"'), f);
  }
  assert.ok(read("src/components/auth/SignupForm.tsx").includes("border-2 border-border-strong"));
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

test("no cream or white-text utilities anywhere in the site, app and auth sources", () => {
  const dirs = ["src/app/(site)", "src/app/(app)", "src/components/site", "src/components/auth", "src/app/login"];
  for (const d of dirs) {
    for (const f of walk(join(process.cwd(), d))) {
      const s = readFileSync(f, "utf8");
      assert.ok(!/F6F1EA|EFE8DD/i.test(s), `${f} has cream`);
      assert.ok(!/text-white/.test(s), `${f} has text-white`);
    }
  }
});
