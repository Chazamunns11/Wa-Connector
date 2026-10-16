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

test("calculator label text matches its visible name (WCAG 2.5.3): no aria-label, only 'If I connect' in the label", () => {
  const c = read("src/components/site/PricingCalculator.tsx");
  assert.ok(!/aria-label=/.test(c));
  const label = c.slice(c.indexOf("<label"), c.indexOf("</label>"));
  assert.ok(!/<input/.test(label));
  assert.match(label, /If I connect/);
  assert.ok(!/numbers,/.test(label));
});

test("calculator note region is a static status role", () => {
  assert.match(read("src/components/site/PricingCalculator.tsx"), /role="status"/);
  assert.ok(!/role=\{note/.test(read("src/components/site/PricingCalculator.tsx")));
});

test("footnote link name has no stray digit", () => {
  const p = read("src/app/(site)/page.tsx");
  assert.match(p, /aria-label="Our own average, footnote 1"/);
  assert.match(p, /<sup[^>]*aria-hidden="true"/);
});

test("dead rise-in CSS is gone", () => {
  assert.ok(!/\.rise-in/.test(read("src/app/globals.css")));
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

// Task 14: Direction B. The SMS crop test and the 'sample beside the steps' test are deleted: both phones are full height and the home page has no connect sample.
