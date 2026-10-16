import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_ROUTES, PUBLIC_ROUTES } from "@/lib/site/routes";
import { CONNECT_SHEET_PDF, connectSheet } from "@/lib/site/connect-sheet";
import { TELEPHONY_PROVIDER_PATH } from "@/lib/site/setup-steps";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const brand = { name: "PingWren" } as Parameters<typeof connectSheet>[0];

test("the how-to-connect page exists and is public", () => {
  assert.equal(SITE_ROUTES.connect, "/docs/connect");
  assert.ok(existsSync(join(root, "src/app/(site)/docs/connect/page.tsx")));
  assert.ok(PUBLIC_ROUTES.includes(SITE_ROUTES.connect));
});

test("labels are quoted from the real app, verbatim", () => {
  const sources = [
    read("src/app/embed/crm/CrmEmbedClient.tsx"),
    read("src/components/whatsapp/WhatsappConnectionPanel.tsx"),
    read("src/app/connect/[token]/ConnectLinkClient.tsx"),
  ].join("\n");
  const s = connectSheet(brand);
  for (const label of [s.labels.connect, s.labels.freshCode, s.labels.reconnect, s.labels.connected, s.labels.waiting, s.labels.disconnected, s.labels.qrInstruction, s.labels.openElsewhere]) {
    assert.ok(sources.includes(label), `not found in the app: ${label}`);
  }
  assert.equal(s.labels.qrInstruction, "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.");
});

test("the telephony path matches the setup guide", () => {
  const s = connectSheet(brand);
  assert.ok(JSON.stringify(s).includes(TELEPHONY_PROVIDER_PATH.join(" → ") + " → PingWren"));
});

test("copy never says GHL and the page has print and PDF affordances", () => {
  const files = [
    "src/lib/site/connect-sheet.ts",
    "src/app/(site)/docs/connect/page.tsx",
    "src/components/site/PrintButton.tsx",
  ];
  for (const f of files) assert.doesNotMatch(read(f), /\bGHL\b/, f);
  const page = read("src/app/(site)/docs/connect/page.tsx");
  assert.match(page, /Download the PDF/);
  assert.match(page, /PrintButton/);
  assert.match(read("src/components/site/PrintButton.tsx"), /window\.print\(\)/);
  assert.equal(CONNECT_SHEET_PDF, "/help/pingwren-how-to-connect.pdf");
  assert.ok(existsSync(join(root, "public/help/pingwren-how-to-connect.pdf")));
  assert.match(read("src/app/globals.css"), /@media print/);
});

test("linked from the docs index and the setup guide", () => {
  assert.match(read("src/app/(site)/docs/page.tsx"), /SITE_ROUTES\.connect/);
  assert.match(read("src/app/(site)/docs/setup/page.tsx"), /SITE_ROUTES\.connect/);
});

test("sheet carries the safety and disclosure lines", () => {
  const s = JSON.stringify(connectSheet(brand));
  assert.match(s, /read and send/);
  assert.match(s, /official WhatsApp Business API/);
  assert.match(s, /restrict/);
});
