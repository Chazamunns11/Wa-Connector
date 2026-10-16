/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS script */
/*
 * Regenerates public/help/pingwren-how-to-connect.pdf from the printed /docs/connect page.
 * Run against a production build:
 *   NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build && npx next start -p 3000 &
 *   BASE_URL=http://localhost:3000 node scripts/connect-sheet-pdf.cjs
 * Uses the global Playwright install; prints the page count so you can check it is one A4 page.
 */
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const { readFileSync } = require("node:fs");

(async () => {
  const base = process.env.BASE_URL || "http://localhost:3000";
  const out = "public/help/pingwren-how-to-connect.pdf";
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/docs/connect`, { waitUntil: "networkidle" });
  await page.pdf({ path: out, format: "A4", printBackground: false, preferCSSPageSize: true });
  await browser.close();
  const pages = (readFileSync(out, "latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(`${out}: ${pages} page(s)`);
})();
