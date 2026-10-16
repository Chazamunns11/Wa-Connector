import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { salesCopy } from "@/lib/site/sales-copy";
import type { BrandConfig } from "@/lib/brand-config";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const FILES = ["src/components/site/HeroWorkflow.tsx", "src/components/site/SafetyThread.tsx"];

test("hero and safety components never use WhatsApp green or its tick marks", () => {
  for (const f of FILES) {
    const text = read(f);
    assert.ok(!/#25D366/i.test(text), f);
    assert.ok(!/[✓✔]/.test(text), `${f} has tick glyphs`);
  }
  assert.ok(!/#25D366/i.test(read("src/app/globals.css")));
});

test("hero animation is CSS-only and switched off under prefers-reduced-motion", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /@keyframes hero-land/);
  const reduced = css.split("@media (prefers-reduced-motion: reduce)").slice(1).join("\n");
  assert.match(reduced, /\.hero-bubble/);
  assert.match(reduced, /animation:\s*none/);
  assert.ok(!/"use client"/.test(read("src/components/site/HeroWorkflow.tsx")), "hero must not ship client JS");
});

test("hero visual is described to assistive tech", () => {
  const text = read("src/components/site/HeroWorkflow.tsx");
  assert.match(text, /role="img"/);
  assert.match(text, /aria-label=/);
});

test("safety thread is fed by the sales-copy safety items and is not a numbered list", () => {
  const src = read("src/components/site/SafetyThread.tsx");
  assert.match(src, /\[paced, held, stop\] = items/);
  assert.match(src, /note\.title/);
  assert.ok(!/<ol/.test(src));
  assert.match(read("src/app/(site)/page.tsx"), /<SafetyThread items=\{copy\.safety\}/);
});

test("paced copy says over-cap messages are reported back as not sent", () => {
  const brand: BrandConfig = {
    name: "Acme",
    tagline: "t",
    supportEmail: null,
    supportWhatsApp: null,
    logoPath: null,
    accent: null,
    appUrl: "http://localhost:3000",
  };
  const paced = salesCopy(brand).safety[0];
  assert.equal(paced.title, "Paced sending");
  assert.match(paced.body, /reported back to GoHighLevel as not sent/);
});

test("hero entrance does not fade the bubble in", () => {
  const css = read("src/app/globals.css");
  const kf = css.match(/@keyframes hero-land \{[^}]*\}[^}]*\}/)![0];
  assert.ok(!/opacity/.test(kf));
});
