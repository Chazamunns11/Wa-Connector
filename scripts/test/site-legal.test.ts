import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRAFT_NOTICE, LEGAL_OUTLINE } from "@/lib/site/legal-outline";

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), "utf8");

test("LEGAL_OUTLINE has the terms and privacy headings", () => {
  assert.deepEqual(LEGAL_OUTLINE.terms.headings, [
    "Who we are",
    "The service",
    "Your account and billing",
    "Acceptable use",
    "WhatsApp's linked-device mechanism and restrictions",
    "Data we process",
    "Liability",
    "Changes",
    "Contact",
  ]);
  assert.deepEqual(LEGAL_OUTLINE.privacy.headings, [
    "Who we are",
    "What we collect",
    "Why we process it",
    "Message content (we act as a processor)",
    "Retention",
    "Sub-processors",
    "Your rights (UK GDPR)",
    "Contact",
  ]);
});

test("legal pages render only headings and the draft notice", () => {
  for (const f of ["src/app/(site)/legal/terms/page.tsx", "src/app/(site)/legal/privacy/page.tsx"]) {
    const src = read(f);
    assert.match(src, /DraftNotice/, f);
    assert.match(src, /LEGAL_OUTLINE/, f);
    assert.equal(/<p[\s>]/.test(src), false, `${f} must have no body paragraphs`);
  }
  assert.match(read("src/components/site/DraftNotice.tsx"), /role="note"/);
});

test("draft notice text is fixed", () => {
  assert.equal(
    DRAFT_NOTICE,
    "Draft — this page is a placeholder outline and will be replaced by the real legal text before launch.",
  );
});

test("privacy summary states 90-day deletion including media files, and legal pages are indexable", () => {
  const src = read("src/app/(site)/docs/privacy-and-data/page.tsx").replace(/\s+/g, " ");
  assert.match(src, /photo, video, voice note or document/);
  assert.match(src, /including the file, 90 days after it arrives/);
  for (const k of ["terms", "privacy"]) {
    assert.equal(/index:\s*false/.test(read(`src/app/(site)/legal/${k}/page.tsx`)), false);
  }
});
