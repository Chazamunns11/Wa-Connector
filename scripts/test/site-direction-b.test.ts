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

test("chrome: header is Ink, footer is Ink, Cta and forms use the site pills", () => {
  const header = read("src/components/site/SiteHeader.tsx");
  assert.match(header, /surface-dark/);
  assert.match(header, /siteButton\("coral"/);
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

// ---- Task 14B: home page in Direction B ----

test("14B home page: grounds run dark, white features, coral, slab, mist, coral", () => {
  const p = read("src/app/(site)/page.tsx");
  const order = ["surface-dark", "surface-coral", "slab slab-lift", "bg-raised", "surface-coral"];
  let at = -1;
  for (const token of order) {
    const i = p.indexOf(token, at + 1);
    assert.ok(i > at, `${token} out of order`);
    at = i;
  }
  assert.ok(!p.includes("section-rule"));
  assert.ok(p.indexOf("bg-raised") > p.indexOf("slab slab-lift"), "bg-raised only on the FAQ band");
  const heroSection = p.slice(p.indexOf("<section"), p.indexOf("</section>"));
  assert.match(heroSection, /surface-dark/);
  const h1 = p.slice(p.indexOf("<h1"), p.indexOf("</h1>"));
  assert.match(h1, /copy\.heroH1/);
  assert.ok(p.indexOf('id="own-result"') > p.indexOf("copy.reasons.heading"), "footnote target sits inside the Why use us block");
  assert.match(p, /<HowItWorks steps=\{copy\.setup\.steps\} \/>/);
  assert.ok(!/aside=/.test(p));
  assert.match(p, /<CustomerResults/);
  assert.match(p, /<FeatureList/);
  assert.ok(!/Clients read WhatsApp/.test(p));
  assert.ok(!/copy\.safetyIntro/.test(p), "safetyIntro is not rendered (W37)");
});

test("14B HowItWorks: giant numerals, path chip, no aside", () => {
  const h = read("src/components/site/HowItWorks.tsx");
  assert.match(h, /step-num/);
  assert.match(h, /path-chip/);
  assert.match(h, /s\.path/);
  assert.match(h, /aria-hidden="true"/);
  assert.ok(!/aside/.test(h));
  assert.ok(!/lg:grid-cols-\[/.test(h));
});

test("14B SafetyThread: ruled rows, no bubbles", () => {
  const s = read("src/components/site/SafetyThread.tsx");
  assert.match(s, /className="rules"/);
  assert.match(s, /\[paced, held, stop\] = items/);
  assert.match(s, /note\.title/);
  assert.ok(!/bubble/.test(s));
  assert.ok(!/<ol/.test(s));
});

test("14B DashboardSample: the board, with the pinned strings kept", () => {
  const d = read("src/components/site/samples/DashboardSample.tsx");
  for (const c of ["board", "board-top", "pill-sample", "Sample", "meter", "dot", "attn"]) assert.ok(d.includes(c), c);
  assert.ok(!/import \{[^}]*Chip/.test(d));
});

test("14B SameReminderTwice: two phones are direct children of .phones", () => {
  const t = read("src/components/site/samples/SameReminderTwice.tsx");
  const wrap = t.slice(t.indexOf("className=\"phones\""));
  const inner = wrap.slice(0, wrap.indexOf("<figcaption"));
  assert.equal((inner.match(/<PhoneFrame/g) ?? []).length, 2);
  assert.ok(!t.includes("Sample messages. Sam is made up."));
});

test("14B globals.css: hero-rise only under no-preference, reduced motion lists the phones, no SMS crop", () => {
  const css = read("src/app/globals.css");
  const npIdx = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(npIdx >= 0);
  const kf = css.indexOf("@keyframes hero-rise");
  assert.ok(kf > npIdx);
  // keyframes sits inside a no-preference block: nearest preceding @media is no-preference
  assert.equal(css.lastIndexOf("@media", kf), css.lastIndexOf("@media (prefers-reduced-motion: no-preference)", kf));
  const reduced = css.split("@media (prefers-reduced-motion: reduce)").slice(1).join("\n");
  assert.match(reduced, /\.phones \.phone/);
  assert.ok(!/height:\s*260px/.test(css));
  assert.ok(!/\.phone-sms \.phone-composer,\s*\.phone-sms \.phone-home\s*\{[^}]*display:\s*none/.test(css));
  assert.match(css, /\.phones > \.phone:nth-child\(1\)\s*\{[^}]*rotate\(-4deg\)/);
});

test("14B sales-copy: step 2 carries the path chip; sampleCaption gone; other strings untouched", async () => {
  const { salesCopy } = await import("../../src/lib/site/sales-copy.ts");
  const c = salesCopy({ name: "PingWren" } as never);
  assert.equal(c.setup.steps[1].path, "Settings → Phone System → Advanced Settings → Telephony Provider");
  assert.ok(!c.setup.steps[1].body.includes("Phone System"));
  assert.equal(c.setup.steps[0].path, undefined);
  assert.equal(c.setup.steps[2].path, undefined);
  assert.ok(!("sampleCaption" in c.setup));
  assert.equal(
    c.heroSub,
    "Set PingWren as the Telephony Provider and the Send SMS steps you already have go out on WhatsApp. When the customer writes back, the reply lands in Conversations.",
  );
  assert.equal(c.faqAllLink, "All the questions, on one page");
  assert.equal(c.priceStrip.terms, "7-day free trial, no card needed. The trial covers up to 3 sub-accounts, and you can cancel any time from the billing portal.");
  assert.ok(c.safety[0].body.startsWith("Messages leave at a steady rate"));
});
