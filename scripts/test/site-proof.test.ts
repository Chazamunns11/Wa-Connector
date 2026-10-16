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
  const urls = RESEARCH_FINDINGS.map((f) => f.href);
  assert.ok(urls.includes("https://pmc.ncbi.nlm.nih.gov/articles/PMC5227159/"));
  assert.ok(urls.includes("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7310733/"));
  const band = read("src/components/site/ReminderResearch.tsx");
  assert.match(band, /rel="noopener"/);
  const page = read("src/app/(site)/page.tsx");
  assert.ok(page.indexOf("Live in three steps") < page.indexOf("<ReminderResearch") );
  assert.ok(page.indexOf("<ReminderResearch") < page.indexOf("copy.keepWorkflows.heading"));
  assert.match(page, /<CustomerResults/);
});

test("the research band states honest figures and the SMS-to-WhatsApp bridge", () => {
  const text = JSON.stringify(RESEARCH_FINDINGS);
  assert.match(text, /38% to 24%/);
  assert.match(text, /21% to 14%/);
  const band = read("src/components/site/ReminderResearch.tsx");
  assert.match(band, /used SMS reminders/);
  assert.ok(!/outperform|better than SMS|beats SMS/i.test(band + text));
});
