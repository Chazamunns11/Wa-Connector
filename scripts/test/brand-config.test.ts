import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { inkFor } from "@/lib/brand";
import { brandConfig, brandCssVars } from "@/lib/brand-config";

const KEYS = [
  "BRAND_NAME",
  "BRAND_TAGLINE",
  "BRAND_SUPPORT_EMAIL",
  "BRAND_SUPPORT_WHATSAPP",
  "BRAND_LOGO_PATH",
  "BRAND_ACCENT",
  "NEXT_PUBLIC_APP_URL",
  "NODE_ENV",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("defaults: tagline, no logo/accent/whatsapp", () => {
  for (const k of KEYS) delete process.env[k];
  assert.deepEqual(brandConfig(), {
    name: "WA Connector",
    tagline: "WhatsApp for GoHighLevel",
    supportEmail: null,
    supportWhatsApp: null,
    logoPath: null,
    accent: null,
    appUrl: "http://localhost:3000",
  });
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

test("brandConfig does not throw in production with BRAND_PRICE_PER_NUMBER unset", () => {
  for (const k of KEYS) delete process.env[k];
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  assert.doesNotThrow(() => brandConfig());
});

test("BRAND_ACCENT '#abc' normalises to #AABBCC and brandCssVars sets accent, ink and text", () => {
  process.env.BRAND_ACCENT = "#abc";
  const b = brandConfig();
  assert.equal(b.accent, "#AABBCC");
  const vars = brandCssVars(b) as Record<string, string>;
  assert.equal(vars["--color-accent"], "#AABBCC");
  assert.equal(vars["--color-accent-text"], "#AABBCC");
  assert.equal(vars["--color-accent-ink"], inkFor("#AABBCC"));
});

test("BRAND_ACCENT invalid → accent null and brandCssVars undefined", () => {
  process.env.BRAND_ACCENT = "teal-ish";
  const b = brandConfig();
  assert.equal(b.accent, null);
  assert.equal(brandCssVars(b), undefined);
});
