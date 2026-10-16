import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { siteButton } from "../../src/components/site/button.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = (css: string, selector: string) => {
  const out: string[] = [];
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`, "g");
  for (const m of css.matchAll(re)) out.push(m[1]);
  return out;
};

// ---- Task 14A: tokens, chrome and primitives (Direction B, coral field) ----

test("globals.css: Cream, sand and Wren are gone from every declaration", () => {
  const css = stripCss(read("src/app/globals.css"));
  for (const hex of ["F6F1EA", "EFE8DD", "7A4E2D"]) {
    assert.ok(!new RegExp(hex, "i").test(css), `${hex} must not appear in globals.css`);
  }
});

test("globals.css: .surface-coral makes every text token Ink and never white", () => {
  const css = stripCss(read("src/app/globals.css"));
  const coral = blocks(css, ".surface-coral").join("\n");
  assert.ok(coral, ".surface-coral block exists");
  assert.match(coral, /--color-bg:\s*#FF5A36/);
  assert.match(coral, /--color-ink:\s*#1B1F2A/);
  assert.match(coral, /--color-ink-dim:\s*#1B1F2A/);
  assert.match(coral, /--color-ink-faint:\s*#1B1F2A/);
  assert.match(coral, /--color-accent:\s*#1B1F2A/);
  assert.match(coral, /--color-accent-ink:\s*#FFFFFF/);
  assert.match(coral, /--color-accent-text:\s*#1B1F2A/);
});

test("globals.css: light and Ink scopes carry the Direction B tokens", () => {
  const css = stripCss(read("src/app/globals.css"));
  const roots = blocks(css, ":root");
  const lastRoot = roots[roots.length - 1];
  assert.match(lastRoot, /--color-raised:\s*#EEF0F4/);
  assert.match(lastRoot, /--color-rule:\s*#1B1F2A/);
  const darks = blocks(css, ".surface-dark");
  const lastDark = darks[darks.length - 1];
  assert.match(lastDark, /--color-ink:\s*#FFFFFF/);
  assert.match(lastDark, /--color-rule:\s*#FF5A36/);
});

test("globals.css: the Direction B primitives exist", () => {
  const css = stripCss(read("src/app/globals.css"));
  for (const c of [".btn", ".btn-ink", ".btn-line", ".btn-coral", ".slab", ".slab-lift", ".disclosure", ".rules", ".board", ".path-chip", ".step-num", ".phones", ".pill-sample", ".attn", ".meter", ".dot"]) {
    assert.ok(css.includes(`${c} {`) || css.includes(`${c},`) || css.includes(`${c}:`) || css.includes(`${c}.`) || css.includes(`${c} `), `${c} defined`);
  }
  const btn = blocks(css, ".btn").join("\n");
  assert.match(btn, /border-radius:\s*999px/);
  assert.match(btn, /min-height:\s*52px/);
  assert.match(css, /html,\s*body\s*\{[^}]*overflow-x:\s*clip/);
});

test("siteButton builds the pill class string", () => {
  assert.equal(siteButton("coral", "x"), "btn btn-coral x");
  assert.equal(siteButton("ink"), "btn btn-ink");
  assert.equal(siteButton("line", "btn-sm"), "btn btn-line btn-sm");
});

test("chrome: header is coral, footer is Ink, Cta and forms use the site pills", () => {
  const header = read("src/components/site/SiteHeader.tsx");
  assert.match(header, /surface-coral/);
  assert.match(header, /siteButton\("ink"/);
  assert.ok(!/buttonClasses\(/.test(header));
  assert.match(read("src/components/site/SiteFooter.tsx"), /surface-dark/);
  assert.match(read("src/components/site/Cta.tsx"), /siteButton/);
  const faq = read("src/components/site/FaqList.tsx");
  assert.match(faq, /className="disclosure[ "]/);
  assert.ok(!/&minus;/.test(faq));
  const shell = read("src/components/auth/AuthShell.tsx");
  assert.match(shell, /slab/);
  assert.ok(!shell.includes("rounded-lg border bg-card"));
  assert.match(read("src/app/(site)/not-found.tsx"), /siteButton/);
  const docs = read("src/app/(site)/docs/page.tsx");
  assert.match(docs, /slab/);
  assert.ok(!docs.includes("rounded-lg border bg-raised"));
});
