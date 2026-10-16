#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script run with plain node, outside the Next.js build */
/**
 * Website verification walkthrough (Task 12).
 *
 * Starts nothing itself: expects the production build to be running at
 * BASE_URL (default http://localhost:3000), e.g.
 *
 *   NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build
 *   NEXT_PUBLIC_APP_URL=http://localhost:3000 npm start &
 *   npm i --no-save axe-core@4.10.2
 *   NODE_PATH=/opt/node22/lib/node_modules node scripts/site-walkthrough.cjs
 *
 * For every route, at 375x812 and 1280x900:
 *   - the page must not scroll horizontally (scrollWidth <= innerWidth)
 *   - exactly one <h1>
 *   - a full-page screenshot goes to docs/website-screenshots/<slug>-<width>.png
 *   - axe-core runs with the wcag2a, wcag2aa and wcag21aa tags
 * Plus: /admin must fail closed (HTTP 500) without Supabase env, and no page
 * may paint WhatsApp green (#25D366) or load a WhatsApp logo.
 *
 * Writes docs/website-screenshots/a11y-report.md and exits 1 on any
 * horizontal scroll, h1 miscount, unexpected HTTP status, brand-colour hit,
 * or serious/critical axe violation. Minor/moderate violations are reported,
 * not fatal.
 */
const fs = require("node:fs");
const path = require("node:path");

let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require("/opt/node22/lib/node_modules/playwright");
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync("/opt/pw-browsers")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
}

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "website-screenshots");
const AXE_PATH = path.join(ROOT, "node_modules", "axe-core", "axe.min.js");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 1280, height: 900 },
];
const WHATSAPP_GREEN = "rgb(37, 211, 102)"; // #25D366

/** Mirrors SITE_ROUTES in src/lib/site/routes.ts (kept literal: this script runs without TS). */
const SITE_ROUTES = [
  "/",
  "/pricing",
  "/docs",
  "/docs/setup",
  "/docs/connect",
  "/docs/faq",
  "/docs/billing",
  "/docs/privacy-and-data",
  "/legal/terms",
  "/legal/privacy",
  "/signup",
  "/login",
  "/dashboard",
  "/dashboard/billing",
];

/** Extra states. `status` is the HTTP status the page must answer with (200 unless set); `h1` the expected count (1 unless set). */
const EXTRA_ROUTES = [
  { url: "/dashboard?scenario=past_due" },
  { url: "/dashboard?filter=attention" },
  { url: "/docs/setup?audience=business" },
  { url: "/signup/checkout?name=Test&kind=agency&email=t%40example.com" },
  { url: "/login?sent=1" },
  {
    url: "/signup?error.accountName=name_length&error.kind=kind_required&error.email=email_invalid&v.accountName=A&v.email=not-an-email",
    slug: "signup--errors",
  },
  { url: "/this-page-does-not-exist", slug: "not-found", status: 404 },
  // Foundation-owned widget rendered inside GoHighLevel's own page (an iframe
  // in the left-nav Custom Page), so the host page owns the <h1>; the panel's
  // title is an <h2>. Recorded as a finding in docs/website-screenshots/README.md.
  { url: "/embed/crm", h1: 0 },
  { url: "/connect/abc" },
];

/** Routes asserted by status only; never screenshotted. */
const STATUS_ONLY = [{ url: "/admin", status: 500, why: "fails closed without Supabase env" }];

function slugFor(route) {
  if (route.slug) return route.slug;
  const u = new URL(route.url, BASE_URL);
  const base = u.pathname === "/" ? "home" : u.pathname.replace(/^\//, "").replace(/\//g, "-");
  const q = [...u.searchParams.entries()].map(([k, v]) => `${k}-${v}`.replace(/[^a-z0-9-]+/gi, "-")).join("-");
  return q ? `${base}--${q}` : base;
}

const ROUTES = [...SITE_ROUTES.map((url) => ({ url })), ...EXTRA_ROUTES].map((r) => ({
  status: 200,
  h1: 1,
  ...r,
  slug: slugFor(r),
}));

async function main() {
  if (!fs.existsSync(AXE_PATH)) {
    console.error(`axe-core not found at ${AXE_PATH}. Run: npm i --no-save axe-core@4.10.2`);
    process.exit(2);
  }
  const axeSource = fs.readFileSync(AXE_PATH, "utf8");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const launch = { headless: true };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await playwright.chromium.launch(launch);

  const failures = [];
  const rows = []; // { route, width, impact, rule, count, help }
  const summary = []; // per route × width
  const logos = {}; // slug -> [{src, surfaceBg}]

  for (const route of ROUTES) {
    for (const vp of WIDTHS) {
      const context = await browser.newContext({ viewport: vp, reducedMotion: "reduce", deviceScaleFactor: 1 });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      const target = `${BASE_URL}${route.url}`;
      const label = `${route.url} @${vp.width}`;
      let response;
      try {
        response = await page.goto(target, { waitUntil: "networkidle", timeout: 60000 });
      } catch (e) {
        failures.push(`${label}: navigation failed: ${e.message}`);
        await context.close();
        continue;
      }
      const status = response ? response.status() : 0;
      if (status !== route.status) failures.push(`${label}: HTTP ${status}, expected ${route.status}`);

      const checks = await page.evaluate((green) => {
        const docEl = document.documentElement;
        const h1s = document.querySelectorAll("h1").length;
        const greenHits = [];
        const logoImgs = [];
        for (const el of document.querySelectorAll("body *")) {
          const cs = getComputedStyle(el);
          for (const prop of ["color", "background-color", "border-color", "fill", "stroke", "outline-color"]) {
            if (cs.getPropertyValue(prop) === green) {
              greenHits.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} ${prop}`);
              break;
            }
          }
          if (el.tagName === "IMG") {
            const src = el.getAttribute("src") || "";
            if (/whatsapp/i.test(src)) greenHits.push(`img src looks like a WhatsApp logo: ${src}`);
            if (/pingwren-logo|brand/i.test(src)) {
              // Walk up to the nearest painted background so the logo variant can be checked against its surface.
              let node = el.parentElement;
              let bg = "transparent";
              while (node) {
                const b = getComputedStyle(node).backgroundColor;
                if (b && b !== "rgba(0, 0, 0, 0)" && b !== "transparent") {
                  bg = b;
                  break;
                }
                node = node.parentElement;
              }
              logoImgs.push({ src, bg });
            }
          }
        }
        return {
          scrollWidth: docEl.scrollWidth,
          innerWidth: window.innerWidth,
          h1s,
          title: document.title,
          greenHits,
          logoImgs,
        };
      }, WHATSAPP_GREEN);

      if (checks.scrollWidth > checks.innerWidth) {
        failures.push(`${label}: horizontal scroll (scrollWidth ${checks.scrollWidth} > innerWidth ${checks.innerWidth})`);
      }
      if (checks.h1s !== route.h1) failures.push(`${label}: ${checks.h1s} <h1> elements (expected ${route.h1})`);
      for (const hit of checks.greenHits) failures.push(`${label}: WhatsApp green/logo: ${hit}`);
      if (pageErrors.length) failures.push(`${label}: page errors: ${pageErrors.join("; ")}`);
      logos[route.slug] = checks.logoImgs;

      const file = path.join(OUT_DIR, `${route.slug}-${vp.width}.png`);
      await page.screenshot({ path: file, fullPage: true, scale: "css" });

      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(
        (tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }),
        AXE_TAGS,
      );
      let serious = 0;
      for (const v of axe.violations) {
        rows.push({ route: route.url, width: vp.width, impact: v.impact, rule: v.id, count: v.nodes.length, help: v.help });
        if (v.impact === "serious" || v.impact === "critical") {
          serious += v.nodes.length;
          const targets = v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(" "))
            .join(", ");
          failures.push(`${label}: axe ${v.impact} ${v.id} (${v.nodes.length}): ${targets}`);
        }
      }
      summary.push({
        route: route.url,
        width: vp.width,
        status,
        h1s: checks.h1s,
        scroll: checks.scrollWidth <= checks.innerWidth,
        violations: axe.violations.length,
        serious,
        title: checks.title,
      });
      console.log(
        `${status === route.status ? "ok " : "!! "}${label.padEnd(100)} http ${status} h1=${checks.h1s} scroll=${checks.scrollWidth}/${checks.innerWidth} axe=${axe.violations.length} (serious+ ${serious})`,
      );
      await context.close();
    }
  }

  // Status-only routes.
  const probe = await browser.newContext();
  const probePage = await probe.newPage();
  for (const r of STATUS_ONLY) {
    const res = await probePage.goto(`${BASE_URL}${r.url}`, { waitUntil: "commit", timeout: 60000 }).catch(() => null);
    const status = res ? res.status() : 0;
    const ok = status === r.status;
    if (!ok) failures.push(`${r.url}: HTTP ${status}, expected ${r.status} (${r.why})`);
    console.log(`${ok ? "ok " : "!! "}${r.url.padEnd(100)} http ${status} (expected ${r.status}: ${r.why})`);
    summary.push({ route: r.url, width: "-", status, h1s: "-", scroll: "-", violations: "-", serious: "-", statusOnly: true });
  }
  await probe.close();
  await browser.close();

  writeReport({ rows, summary, failures, logos });

  const seriousTotal = rows.filter((r) => r.impact === "serious" || r.impact === "critical").reduce((n, r) => n + r.count, 0);
  console.log(`\n${ROUTES.length} routes x ${WIDTHS.length} widths; axe serious/critical nodes: ${seriousTotal}; failures: ${failures.length}`);
  if (failures.length) {
    console.error("\nFAILURES:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

function writeReport({ rows, summary, failures, logos }) {
  const lines = [];
  lines.push("# Accessibility report");
  lines.push("");
  lines.push(`Generated by \`scripts/site-walkthrough.cjs\` against ${BASE_URL} on ${new Date().toISOString().slice(0, 10)}.`);
  lines.push(`axe-core ${axeVersion()} with tags ${AXE_TAGS.join(", ")}; viewports ${WIDTHS.map((w) => `${w.width}x${w.height}`).join(" and ")}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Route | Width | HTTP | h1 | No horizontal scroll | axe violations | serious/critical |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of summary) {
    lines.push(
      `| \`${s.route}\` | ${s.width} | ${s.status} | ${s.h1s} | ${s.scroll === "-" ? "-" : s.scroll ? "yes" : "NO"} | ${s.violations} | ${s.serious} |`,
    );
  }
  lines.push("");
  lines.push("## Violations (route x impact x rule x count)");
  lines.push("");
  if (rows.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Route | Width | Impact | Rule | Nodes | Help |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    rows.sort((a, b) => order[a.impact] - order[b.impact] || a.route.localeCompare(b.route) || a.width - b.width);
    for (const r of rows) lines.push(`| \`${r.route}\` | ${r.width} | ${r.impact} | ${r.rule} | ${r.count} | ${r.help} |`);
  }
  lines.push("");
  lines.push("## Logo variant per route");
  lines.push("");
  lines.push("Logo `<img>` sources found at 1280 with the nearest painted background (reverse artwork belongs on Ink, standard on Coral).");
  lines.push("");
  lines.push("| Route | Logo file | Background |");
  lines.push("| --- | --- | --- |");
  for (const [slug, imgs] of Object.entries(logos)) {
    if (!imgs.length) {
      lines.push(`| ${slug} | (none) | |`);
      continue;
    }
    for (const i of imgs) lines.push(`| ${slug} | ${path.basename(i.src)} | ${i.bg} |`);
  }
  lines.push("");
  lines.push("## Failures");
  lines.push("");
  if (failures.length === 0) lines.push("None.");
  else for (const f of failures) lines.push(`- ${f}`);
  lines.push("");
  fs.writeFileSync(path.join(OUT_DIR, "a11y-report.md"), lines.join("\n"));
}

function axeVersion() {
  try {
    return require(path.join(ROOT, "node_modules", "axe-core", "package.json")).version;
  } catch {
    return "unknown";
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
