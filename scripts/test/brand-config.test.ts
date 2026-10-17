import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inkFor } from "@/lib/brand";
import { brandConfig, brandCssVars } from "@/lib/brand-config";

const KEYS = [
  "BRAND_NAME",
  "BRAND_TAGLINE",
  "BRAND_SUPPORT_EMAIL",
  "BRAND_SUPPORT_WHATSAPP",
  "BRAND_LOGO_PATH",
  "BRAND_LOGO_REVERSE_PATH",
  "BRAND_ACCENT",
  "NEXT_PUBLIC_APP_URL",
  "NODE_ENV",
  "VERCEL_ENV",
  "VERCEL_BRANCH_URL",
  "VERCEL_URL",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("defaults: PingWren name, tagline, kit logos, coral accent, no whatsapp", () => {
  for (const k of KEYS) delete process.env[k];
  assert.deepEqual(brandConfig(), {
    name: "PingWren",
    tagline: "WhatsApp for GoHighLevel",
    supportEmail: null,
    supportWhatsApp: null,
    logoPath: "/brand/pingwren-logo.svg",
    logoReversePath: "/brand/pingwren-logo-reverse.svg",
    accent: "#FF5A36",
    appUrl: "http://localhost:3000",
  });
});

test("BRAND_LOGO_PATH overrides the light logo; reverse falls back to it unless set", () => {
  for (const k of KEYS) delete process.env[k];
  process.env.BRAND_LOGO_PATH = "/custom.svg";
  assert.equal(brandConfig().logoPath, "/custom.svg");
  assert.equal(brandConfig().logoReversePath, "/custom.svg");
  process.env.BRAND_LOGO_REVERSE_PATH = "/custom-rev.svg";
  assert.equal(brandConfig().logoReversePath, "/custom-rev.svg");
  delete process.env.BRAND_LOGO_REVERSE_PATH;
});

test("brand kit logo and favicon files exist", () => {
  for (const f of ["pingwren-logo.svg", "pingwren-logo-reverse.svg", "favicon.svg", "favicon.ico", "favicon-180.png"]) {
    assert.ok(existsSync(join(process.cwd(), "public/brand", f)), f);
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

test("no source file under src/ uses WhatsApp green or a WhatsApp logo asset", () => {
  const bad: string[] = [];
  for (const f of walk(join(process.cwd(), "src"))) {
    if (!/\.(tsx?|css|svg|json|md)$/.test(f)) {
      if (/whatsapp[-_ ]?(logo|icon|glyph)/i.test(f)) bad.push(f);
      continue;
    }
    const text = readFileSync(f, "utf8");
    if (/#25D366/i.test(text) || /whatsapp[-_]?(logo|icon|glyph)\.(svg|png|webp)/i.test(text) || /whatsapp[-_ ]?(logo|icon|glyph)/i.test(f)) {
      bad.push(f);
    }
  }
  assert.deepEqual(bad, []);
});

test("env overrides name and support email", () => {
  process.env.BRAND_NAME = "Acme Chat";
  process.env.BRAND_SUPPORT_EMAIL = "help@acme.test";
  const b = brandConfig();
  assert.equal(b.name, "Acme Chat");
  assert.equal(b.supportEmail, "help@acme.test");
});

test("trailing slash is stripped from appUrl", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
  assert.equal(brandConfig().appUrl, "https://app.example.com");
});

test("brandConfig does not throw in production without any pricing variable", () => {
  for (const k of KEYS) delete process.env[k];
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  assert.doesNotThrow(() => brandConfig());
});

test("Vercel preview without NEXT_PUBLIC_APP_URL uses the branch URL", () => {
  for (const k of KEYS) delete process.env[k];
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_BRANCH_URL = "pingwren-git-branch-syncme.vercel.app";
  process.env.VERCEL_URL = "pingwren-abc123-syncme.vercel.app";
  assert.equal(brandConfig().appUrl, "https://pingwren-git-branch-syncme.vercel.app");
  delete process.env.VERCEL_BRANCH_URL;
  assert.equal(brandConfig().appUrl, "https://pingwren-abc123-syncme.vercel.app");
});

test("production (not a Vercel preview) still requires NEXT_PUBLIC_APP_URL", () => {
  for (const k of KEYS) delete process.env[k];
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.VERCEL_ENV = "production";
  process.env.VERCEL_URL = "pingwren-abc123-syncme.vercel.app";
  assert.throws(() => brandConfig(), /NEXT_PUBLIC_APP_URL must be set in production/);
});

test("BRAND_ACCENT '#abc' normalises to #AABBCC and brandCssVars sets accent and ink (text stays themed)", () => {
  process.env.BRAND_ACCENT = "#abc";
  const b = brandConfig();
  assert.equal(b.accent, "#AABBCC");
  const vars = brandCssVars(b) as Record<string, string>;
  assert.equal(vars["--color-accent"], "#AABBCC");
  assert.equal(vars["--color-accent-text"], undefined);
  assert.equal(vars["--color-accent-ink"], inkFor("#AABBCC"));
});

test("BRAND_ACCENT invalid → default coral accent and brandCssVars undefined", () => {
  process.env.BRAND_ACCENT = "teal-ish";
  const b = brandConfig();
  assert.equal(b.accent, "#FF5A36");
  assert.equal(brandCssVars(b), undefined);
});
