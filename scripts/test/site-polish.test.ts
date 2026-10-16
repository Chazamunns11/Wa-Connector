import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Task 13E: polish from the 13D walkthrough.
test("W35: customer copy says verified badge and per message, never green tick or per conversation", () => {
  for (const f of ["src/lib/site/sales-copy.ts", "src/lib/site/faq.ts", "src/lib/site/comparison.ts"]) {
    const t = read(f);
    assert.ok(!/green tick/i.test(t), `${f} still says green tick`);
    assert.ok(!/per conversation/i.test(t), `${f} still says per conversation`);
  }
  assert.match(read("src/lib/site/sales-copy.ts"), /verified badge/);
  assert.match(read("src/lib/site/sales-copy.ts"), /charge you per message/);
});

test("13D copy fixes: no send/sends echo, no 'not settings' contrast, plain footer sentence", () => {
  const s = read("src/lib/site/sales-copy.ts");
  assert.ok(!/send and sends/.test(s));
  assert.ok(!/not settings/.test(s));
  assert.match(s, /none of them can be switched off/);
  assert.ok(!/linked-device connector/.test(read("src/components/site/SiteFooter.tsx")));
  assert.match(read("src/components/site/SiteFooter.tsx"), /connects to WhatsApp as a linked device, not through the official WhatsApp Business API/);
  assert.match(read("src/app/(site)/docs/setup/page.tsx"), /You need it in your hand for the scan/);
});

test("page titles share the em-dash pattern", () => {
  assert.match(read("src/app/(site)/docs/faq/page.tsx"), /title: `FAQ — \$\{name\}`/);
});

test("phone status bar uses an ordinary time", () => {
  const f = read("src/components/site/samples/PhoneFrame.tsx");
  assert.ok(!f.includes("9:41"));
  assert.ok(f.includes("10:24"));
});

test("W34: the footnote link is a sibling of the h1, not inside it", () => {
  const p = read("src/app/(site)/page.tsx");
  const h1 = p.slice(p.indexOf("<h1"), p.indexOf("</h1>"));
  assert.ok(!h1.includes("#own-result"));
  assert.match(p, /href="#own-result"/);
});

test("calculator input has an explicit accessible name", () => {
  assert.match(read("src/components/site/PricingCalculator.tsx"), /aria-label="How many numbers"/);
});

test("connect strip does not say Connected twice", () => {
  const c = read("src/components/site/samples/ConnectPanelSample.tsx");
  assert.ok(!/<span>\s*Connected as/.test(c));
  assert.match(c, /<span>\s*as <span/);
});

test("selected audience tab is Ink, not Coral", () => {
  const t = read("src/components/site/AudienceTabs.tsx");
  assert.ok(!/bg-accent/.test(t));
});

test("SMS phone is cropped below 1024px", () => {
  assert.match(read("src/app/globals.css"), /\.phone-sms\s*\{[^}]*height:\s*2\d\dpx/);
});

test("how-it-works puts the sample beside the steps", () => {
  const h = read("src/components/site/HowItWorks.tsx");
  assert.match(h, /lg:grid-cols-\[/);
  assert.ok(!/mt-8">\{aside\}/.test(h));
});
