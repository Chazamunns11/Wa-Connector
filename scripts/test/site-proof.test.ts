import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_RESULTS, RESEARCH_FINDINGS, resultsToShow, type CustomerResult } from "@/lib/site/proof";

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

test("the research band cites both studies with a link to each source", () => {
  assert.equal(RESEARCH_FINDINGS.length, 2);
  const urls = RESEARCH_FINDINGS.map((f) => f.href);
  assert.ok(urls.includes("https://pmc.ncbi.nlm.nih.gov/articles/PMC5227159/"));
  assert.ok(urls.includes("https://pmc.ncbi.nlm.nih.gov/articles/PMC7310733/"));
  const band = read("src/components/site/ReminderResearch.tsx");
  assert.match(band, /rel="noopener"/);
  const page = read("src/app/(site)/page.tsx");
  // Ruling W26: after "Keep your workflows", before the safety thread.
  assert.ok(page.indexOf("copy.keepWorkflows.heading") < page.indexOf("<ReminderResearch"));
  assert.ok(page.indexOf("<ReminderResearch") < page.indexOf("Built to be careful"));
  assert.match(page, /<CustomerResults/);
});

test("the research band states honest figures and the SMS-to-WhatsApp bridge", () => {
  const text = JSON.stringify(RESEARCH_FINDINGS);
  assert.match(text, /"from":"38%","to":"24%"/);
  assert.match(text, /"from":"21%","to":"14%"/);
  assert.match(text, /about 170 patients/);
  assert.match(text, /rewording the reminder/);
  const band = read("src/components/site/ReminderResearch.tsx");
  assert.match(band, /used SMS reminders/);
  assert.match(band, /from your own\s+number, and replies land back in Conversations/);
  assert.ok(!/most of your\s+contacts/.test(band));
  assert.ok(!/outperform|better than SMS|beats SMS/i.test(band + text));
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
  const page = read("src/app/(site)/page.tsx");
  assert.match(page, /<OwnResults/);
  assert.ok(page.indexOf("<OwnResults") < page.indexOf("<ReminderResearch"));
});

test("walkthrough fixes: control group, best-of-eight caveat", () => {
  const text = JSON.stringify(RESEARCH_FINDINGS);
  assert.ok(!/patients sent none/.test(text));
  assert.match(text, /usual voice-message reminder/);
  assert.match(text, /best of the eight/);
  assert.match(text, /letting others down/);
});

test("walkthrough fixes: menu item named after the brand, no triple negative, pricing line, auth logo link", () => {
  assert.ok(!/Open the WhatsApp page in the left menu/.test(read("src/lib/site/sales-copy.ts")));
  assert.match(read("src/lib/site/sales-copy.ts"), /left menu/);
  assert.ok(!/The WhatsApp page lives in the left menu/.test(read("src/lib/site/setup-steps.ts")));
  assert.ok(!/no green tick, no template approval/.test(read("src/lib/site/faq.ts")));
  assert.match(read("src/app/(site)/pricing/page.tsx"), /There is no setup fee, and \{brand\.name\} does not charge per message\./);
  const shell = read("src/components/auth/AuthShell.tsx");
  assert.match(shell, /<Link[^>]*href="\/"[^>]*aria-label=\{`\$\{brandConfig\(\)\.name\} home`\}/s);
});
