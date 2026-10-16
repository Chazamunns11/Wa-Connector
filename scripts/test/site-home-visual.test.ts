import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

test("safety thread uses the existing safety copy titles", async () => {
  const { salesCopy } = await import("@/lib/site/sales-copy");
  const titles = salesCopy({ name: "PingWren" } as never).safety.map((s) => s.title);
  assert.deepEqual(titles, ["Paced sending", "Held while disconnected", "STOP opt-outs"]);
});
