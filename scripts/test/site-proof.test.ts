import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_RESULTS, resultsToShow, type CustomerResult } from "@/lib/site/proof";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
function walk(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

test("customer results ship empty: no invented customers in this commit", () => {
  assert.deepEqual(CUSTOMER_RESULTS, []);
});

test("the customer results slot renders nothing for an empty list and something for a consented entry", () => {
  assert.equal(resultsToShow([]), null);
  const entry: CustomerResult = {
    business: "Test Studio",
    businessType: "Personal training",
    showRateBefore: 60,
    showRateAfter: 80,
    period: "Jan to Mar",
    permission: true,
  };
  assert.deepEqual(resultsToShow([entry]), [entry]);
  const src = read("src/components/site/CustomerResults.tsx");
  assert.match(src, /resultsToShow\(/);
  assert.match(src, /return null/);
  assert.match(read("src/lib/site/proof.ts"), /permission:\s*true/);
});

test("no 98% claim and no open-rate or read-rate phrasing anywhere in src", () => {
  for (const f of walk("src").filter((f) => /\.(tsx?|css|md)$/.test(f))) {
    const text = read(f);
    assert.ok(!/98\s?%/.test(text), `${f} has 98%`);
    assert.ok(!/(open|read)[\s-]rates?\b/i.test(text), `${f} has an open/read rate phrase`);
  }
});

test("W38: the research line, its component and its data are gone", () => {
  const proof = read("src/lib/site/proof.ts");
  assert.ok(!/RESEARCH_FINDINGS|PMC5227159|PMC7310733/.test(proof));
  assert.ok(!existsSync(join(root, "src/components/site/ReminderResearch.tsx")));
  const page = read("src/app/(site)/page.tsx");
  assert.ok(!/ReminderResearch|copy\.why|why-pad/.test(page));
  assert.match(page, /<CustomerResults/);
  assert.ok(!/Why we made it/.test(read("src/lib/site/sales-copy.ts")));
});

test("W38: the 85%+ note lives inside 'Read this before you sign up' and the hero footnote points at it", () => {
  const page = read("src/app/(site)/page.tsx");
  const disclosure = page.slice(page.indexOf("copy.disclosure.heading"));
  assert.ok(disclosure.includes('id="own-result"'));
  assert.ok(disclosure.includes("result.note"));
  assert.ok(page.indexOf('href="#own-result"') < page.indexOf("copy.disclosure.heading"));
  assert.ok(page.indexOf("copy.disclosure.heading") < page.indexOf("copy.faqHeading"));
  assert.ok(page.indexOf("<SafetyThread") < page.indexOf("copy.disclosure.heading"));
});

test("owner's own average: figures, honest framing, and nothing banned (Rulings W25/W27)", async () => {
  const { OWN_RESULTS_AVERAGE } = await import("@/lib/site/proof");
  const a = OWN_RESULTS_AVERAGE;
  assert.match(a.before, /50%/);
  assert.match(a.after, /85%/);
  const text = JSON.stringify(a);
  for (const banned of [/FitClosers/i, /\bsales\b/i, /PingWren customers/i, /with PingWren/i, /open rate/i, /read rate/i]) {
    assert.ok(!banned.test(text), `aggregate matches ${banned}`);
  }
  assert.match(a.note, /not an independent study/);
  assert.match(a.note, /vary/i);
  // Task 13: the owner's result is the hero headline, with the signature figure beside it.
  const page = read("src/app/(site)/page.tsx");
  assert.match(page, /<SameReminderTwice/);
  assert.match(page, /import \{[^}]*OWN_RESULTS_AVERAGE[^}]*\} from "@\/lib\/site\/proof"/);
  assert.ok(!a.headingLead.includes("%"), "headline lead carries no percentage");
  assert.match(a.headingTail, /it's$/);
  assert.ok(page.indexOf("OWN_RESULTS_AVERAGE") < page.indexOf("<SafetyThread"));
});

test("walkthrough fixes: menu item named after the brand, no triple negative, pricing line, auth logo link", () => {
  assert.ok(!/Open the WhatsApp page in the left menu/.test(read("src/lib/site/sales-copy.ts")));
  assert.match(read("src/lib/site/sales-copy.ts"), /left menu/);
  assert.ok(!/The WhatsApp page lives in the left menu/.test(read("src/lib/site/setup-steps.ts")));
  assert.ok(!/no verified badge, no template approval/.test(read("src/lib/site/faq.ts")));
  assert.match(read("src/app/(site)/pricing/page.tsx"), /There is no setup fee, and \{brand\.name\} does not charge per message\./);
  const shell = read("src/components/auth/AuthShell.tsx");
  assert.match(shell, /<Link[^>]*href="\/"[^>]*aria-label=\{`\$\{brandConfig\(\)\.name\} home`\}/s);
});
