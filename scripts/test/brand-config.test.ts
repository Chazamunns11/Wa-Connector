import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { brandConfig } from "@/lib/brand-config";

const KEYS = ["BRAND_NAME", "BRAND_SUPPORT_EMAIL", "NEXT_PUBLIC_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("defaults: name 'WA Connector', no support email, localhost app url", () => {
  for (const k of KEYS) delete process.env[k];
  assert.deepEqual(brandConfig(), {
    name: "WA Connector",
    supportEmail: null,
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
