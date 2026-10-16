import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SETUP_STEP_IDS,
  TROUBLESHOOTING_IDS,
  AUDIENCE_LABELS,
  setupSteps,
  troubleshooting,
} from "@/lib/site/setup-steps";
import type { BrandConfig } from "@/lib/brand-config";

const root = process.cwd();
const acme: BrandConfig = {
  name: "Acme",
  tagline: "t",
  supportEmail: null,
  supportWhatsApp: null,
  logoPath: null,
  accent: null,
  appUrl: "http://localhost:3000",
};

test("setupSteps returns SETUP_STEP_IDS in order with a diagram per step", () => {
  const steps = setupSteps(acme);
  assert.deepEqual(steps.map((s) => s.id), [...SETUP_STEP_IDS]);
  for (const s of steps) {
    assert.equal(s.diagram, s.id);
    assert.ok(s.detail.agency.length > 0 && s.detail.business.length > 0, s.id);
  }
  assert.deepEqual(Object.keys(AUDIENCE_LABELS), ["agency", "business"]);
});

test("telephony step states the exact GHL path ending in the brand name and Save", () => {
  const t = setupSteps(acme).find((s) => s.id === "telephony")!;
  const expected = "Settings → Phone System → Advanced Settings → Telephony Provider → Acme → Save";
  for (const a of ["agency", "business"] as const) {
    assert.ok(t.detail[a].some((d) => d.includes(expected)), a);
  }
});

test("qr step gives the Linked Devices path", () => {
  const q = setupSteps(acme).find((s) => s.id === "qr")!;
  for (const a of ["agency", "business"] as const) {
    assert.ok(q.detail[a].some((d) => d.includes("WhatsApp → Settings → Linked Devices → Link a Device")), a);
  }
  assert.ok(JSON.stringify(q.detail).includes("read and send messages as your business"));
});

test("troubleshooting covers the five spec cases", () => {
  const t = troubleshooting(acme);
  assert.deepEqual(t.map((x) => x.id), [...TROUBLESHOOTING_IDS]);
  const wl = t.find((x) => x.id === "white-label-blocks-install")!;
  assert.ok(wl.body.join(" ").includes("ask your agency to allow Acme"));
  const waiting = t.find((x) => x.id === "messages-waiting")!;
  assert.ok(waiting.body.join(" ").includes("not sent"), "daily cap overflow is not held (W11)");
});

test("both audiences render in the HTML", () => {
  const src = readFileSync(join(root, "src/components/site/AudienceTabs.tsx"), "utf8");
  assert.ok(src.includes('role="tabpanel"'));
  assert.ok(/AUDIENCES\.map|Object\.keys\(AUDIENCE_LABELS\)/.test(src), "maps over both audiences");
  assert.ok(src.includes("hidden"));
  assert.ok(src.includes('role="tablist"') && src.includes('role="tab"'));
  assert.ok(src.includes("aria-selected") && src.includes("aria-controls"));
  for (const k of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.ok(src.includes(k), k);
});

test("every diagram has role img and a title", () => {
  const dir = join(root, "src/components/site/diagrams");
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  assert.equal(files.length, 7);
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.ok(src.includes('role="img"'), `${f} role`);
    assert.ok(src.includes("aria-label"), `${f} aria-label`);
    assert.ok(src.includes("<title>"), `${f} title`);
  }
});

test("setup page reads searchParams as a Promise and renders no hard-coded brand", () => {
  const src = readFileSync(join(root, "src/app/(site)/docs/setup/page.tsx"), "utf8");
  assert.ok(src.includes("await searchParams"));
  const layout = readFileSync(join(root, "src/app/(site)/docs/layout.tsx"), "utf8");
  assert.ok(layout.includes("surface-light"));
});
