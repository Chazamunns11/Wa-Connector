import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { brandConfig, brandCssVars } from "@/lib/brand-config";

const KEYS = [
  "BRAND_NAME",
  "BRAND_TAGLINE",
  "BRAND_SUPPORT_EMAIL",
  "BRAND_SUPPORT_WHATSAPP",
  "BRAND_LOGO_PATH",
  "BRAND_ACCENT",
  "BRAND_PRICE_PER_NUMBER",
  "BRAND_CURRENCY",
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

test("defaults: tagline, no logo/accent/whatsapp, price 29 GBP", () => {
  for (const k of KEYS) delete process.env[k];
  assert.deepEqual(brandConfig(), {
    name: "WA Connector",
    tagline: "WhatsApp for GoHighLevel",
    supportEmail: null,
    supportWhatsApp: null,
    logoPath: null,
    accent: null,
    pricePerNumber: 29,
    currency: "GBP",
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

test("BRAND_PRICE_PER_NUMBER '35.50' parses to 35.5 and BRAND_CURRENCY lower-case is upper-cased", () => {
  process.env.BRAND_PRICE_PER_NUMBER = "35.50";
  process.env.BRAND_CURRENCY = "eur";
  const b = brandConfig();
  assert.equal(b.pricePerNumber, 35.5);
  assert.equal(b.currency, "EUR");
});

test("production with BRAND_PRICE_PER_NUMBER unset throws", () => {
  for (const k of KEYS) delete process.env[k];
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  assert.throws(() => brandConfig(), /BRAND_PRICE_PER_NUMBER/);
});

test("BRAND_PRICE_PER_NUMBER 'abc' throws in any env", () => {
  process.env.BRAND_PRICE_PER_NUMBER = "abc";
  assert.throws(() => brandConfig(), /BRAND_PRICE_PER_NUMBER must be a number/);
});

test("BRAND_ACCENT '#abc' normalises to #AABBCC and brandCssVars sets accent, ink and text", () => {
  process.env.BRAND_ACCENT = "#abc";
  const b = brandConfig();
  assert.equal(b.accent, "#AABBCC");
  const vars = brandCssVars(b) as Record<string, string>;
  assert.equal(vars["--color-accent"], "#AABBCC");
  assert.equal(vars["--color-accent-text"], "#AABBCC");
  assert.match(vars["--color-accent-ink"], /^#[0-9A-F]{6}$/);
});

test("BRAND_ACCENT invalid → accent null and brandCssVars undefined", () => {
  process.env.BRAND_ACCENT = "teal-ish";
  const b = brandConfig();
  assert.equal(b.accent, null);
  assert.equal(brandCssVars(b), undefined);
});
