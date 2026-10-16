import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GHL_NATIVE, COMPARISON } from "@/lib/site/comparison";

// Task 13C: the GoHighLevel comparison quotes HighLevel's own published figures (W33).
test("GHL_NATIVE carries two dated, HighLevel-hosted sources and the US dollar figures", () => {
  assert.equal(GHL_NATIVE.sources.length, 2);
  for (const s of GHL_NATIVE.sources) {
    assert.ok(s.href.startsWith("https://help.gohighlevel.com/"), s.href);
    assert.ok(s.modified.trim().length > 0);
    assert.ok(s.title.trim().length > 0);
  }
  assert.ok(GHL_NATIVE.checkedOn.trim().length > 0);
  assert.equal(GHL_NATIVE.monthlyPerSubAccount, "$10");
  assert.equal(GHL_NATIVE.perMessageExample, "$0.0263");
});

test("the comparison makes no cheaper/better claim and states what native has that we do not", () => {
  const all = JSON.stringify({ GHL_NATIVE, COMPARISON });
  assert.doesNotMatch(all, /cheaper|better than|beats/i);
  assert.match(COMPARISON.closing, /green tick/);
  assert.match(COMPARISON.native.join(" "), /green tick/);
  assert.match(COMPARISON.native.join(" "), /templates/);
  assert.match(COMPARISON.native.join(" "), /No phone to keep online/);
});

test("the source line names both articles, both dates and the check date", () => {
  const line = COMPARISON.sourceLine;
  assert.match(line, /22 September 2026/);
  assert.match(line, /15 October 2026/);
  assert.match(line, /16 October 2026/);
  assert.match(line, /US dollars/);
});

test("the pricing page renders the comparison with rel=noopener links and no tables or cards", () => {
  const page = readFileSync("src/app/(site)/pricing/page.tsx", "utf8");
  assert.match(page, /COMPARISON/);
  assert.match(page, /rel="noopener"/);
  assert.doesNotMatch(page, /<table/);
});
