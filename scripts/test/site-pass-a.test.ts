import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Site pass, Task A: Ink header and first band on every page, one scale for
// borders, radius, spacing and headings.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

test("header is Ink with the reverse logo and no bottom border", () => {
  const header = read("src/components/site/SiteHeader.tsx");
  assert.match(header, /surface-dark/);
  assert.match(header, /surface="dark"/);
  assert.ok(!/surface-coral/.test(header));
  assert.ok(!/<header[^>]*border-b/.test(header), "no border-b on the header element");
  assert.match(header, /siteButton\("coral"/);
  assert.match(header, /accountNav/);
});

test("PageTop is Ink", () => {
  const p = read("src/components/site/PageTop.tsx");
  assert.match(p, /surface-dark/);
  assert.ok(!/surface-coral/.test(p));
  assert.match(p, /h-page/);
});

test("app layout uses SiteHeader and has no header of its own", () => {
  const l = read("src/app/(app)/layout.tsx");
  assert.match(l, /import \{ SiteHeader \}/);
  assert.ok(!/<header/.test(l));
});

test("login sits inside the site chrome", () => {
  const l = read("src/app/login/page.tsx");
  assert.match(l, /import \{ SiteHeader \}/);
  assert.match(l, /import \{ SiteFooter \}/);
  assert.match(l, /skip-link/);
});

test("the old heading, light-alias and one-off strings are gone from the site sources", () => {
  const banned = [
    "clamp(1.5rem,3vw,2.2rem)",
    "h2-b",
    "h-display",
    "surface-light",
    "border-border-strong",
    "!pb-[",
    "text-[.95rem]",
    "text-[0.95rem]",
  ];
  for (const d of ["src/app/(site)", "src/components/site", "src/components/auth"]) {
    for (const f of walk(join(process.cwd(), d))) {
      const s = readFileSync(f, "utf8");
      for (const b of banned) assert.ok(!s.includes(b), `${f} contains ${b}`);
    }
  }
});

test("globals.css defines the one heading, small-text and band scale", () => {
  const css = stripCss(read("src/app/globals.css"));
  for (const c of [".h-hero", ".h-page", ".h-section", ".h-item", ".h-app", ".num-display", ".small", ".band", ".band-tight"]) {
    assert.ok(new RegExp(`\\n${c.replace(".", "\\.")}[ ,{]`).test(css), `${c} defined`);
  }
  for (const gone of [".surface-light", ".h-display", ".h2-b", ".section-rule"]) {
    assert.ok(!css.includes(gone), `${gone} removed`);
  }
  assert.equal((css.match(/\n\.phone \{/g) ?? []).length, 1, "one .phone block");
});

test("--color-outline and the chip tokens exist in all three scopes and in @theme", () => {
  const css = stripCss(read("src/app/globals.css"));
  const scopeBlocks = (sel: string) => [...css.matchAll(new RegExp(`\\n${sel.replace(".", "\\.")} \\{([^}]*)\\}`, "g"))].map((m) => m[1]).join("\n");
  const light = [...css.matchAll(/\n:root \{([^}]*)\}/g)].map((m) => m[1]).filter((b) => b.includes("--color-bg"));
  assert.ok(light.length >= 1);
  for (const [name, body] of [["light", light.join("\n")], ["dark", scopeBlocks(".surface-dark")], ["coral", scopeBlocks(".surface-coral")]] as const) {
    for (const t of ["--color-outline:", "--color-chip:", "--color-chip-ink:"]) assert.ok(body.includes(t), `${name} scope has ${t}`);
  }
  assert.match(css, /@theme inline \{[^}]*--color-outline: var\(--color-outline\)/);
  assert.match(css, /@theme inline \{[^}]*--color-chip: var\(--color-chip\)/);
  assert.match(css, /@theme inline \{[^}]*--color-chip-ink: var\(--color-chip-ink\)/);
});

test("object outlines are 3px on --color-outline", () => {
  const css = stripCss(read("src/app/globals.css"));
  for (const sel of [".slab", ".board", ".sample-chrome"]) {
    const m = css.match(new RegExp(`\\n${sel.replace(".", "\\.")} \\{([^}]*)\\}`));
    assert.ok(m, sel);
    assert.match(m[1], /border:\s*3px solid var\(--color-outline\)/, sel);
  }
  assert.match(css, /\.path-chip \{[^}]*background:\s*var\(--color-chip\)[^}]*color:\s*var\(--color-chip-ink\)/);
  assert.match(css, /\.step-num \{[^}]*color:\s*var\(--color-rule\)/);
});

test("ui primitives follow the site scale", () => {
  assert.match(read("src/components/ui/Button.tsx"), /rounded-full/);
  assert.match(read("src/components/ui/Card.tsx"), /rounded-\[20px\] border-2 border-outline/);
  assert.match(read("src/components/app/LocationTable.tsx"), /rounded-\[20px\] border-2 border-outline/);
  for (const f of ["src/components/app/PlanHeader.tsx", "src/app/(app)/dashboard/billing/page.tsx", "src/app/login/page.tsx"]) {
    assert.match(read(f), /rounded-\[12px\] border-2/, f);
  }
});

test("Cta picks its primary by ground", () => {
  const c = read("src/components/site/Cta.tsx");
  assert.match(c, /ground\?: "white" \| "coral" \| "dark"/);
  assert.ok(!c.includes("onCoral"));
});

test("first band is Ink on the home and pricing pages; every section is a band", () => {
  const home = read("src/app/(site)/page.tsx");
  assert.match(home.slice(home.indexOf("<section"), home.indexOf("</section>")), /surface-dark/);
  const pricing = read("src/app/(site)/pricing/page.tsx");
  assert.match(pricing.slice(pricing.indexOf("<section"), pricing.indexOf("</section>")), /surface-dark/);
  assert.match(pricing, /id="resale"[^>]*surface-coral|surface-coral[^>]*id="resale"|<section id="resale" className="surface-coral/);
  assert.ok(!/\bmt-\[clamp/.test(pricing), "no stacked margins between pricing sections");
  assert.ok(!/SECTION = "pt-/.test(pricing));
  assert.match(read("src/app/(site)/docs/faq/page.tsx"), /band-tight/);
  assert.match(read("src/app/(site)/not-found.tsx"), /band-tight/);
});

test("docs and legal layouts do not carry the removed alias", () => {
  for (const f of ["src/app/(site)/docs/layout.tsx", "src/app/(site)/legal/layout.tsx"]) {
    assert.ok(!read(f).includes("surface-light"), f);
  }
});
