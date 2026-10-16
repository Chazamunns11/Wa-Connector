/**
 * Review Focus 3 — leftover Hub tables. This bridge serves GHL-location
 * tenants only: it must never query the Hub's `calls`, `coaches` or
 * `automation_*` tables, never touch a `call_id` column, and never carry the
 * old `'coach'` tenant kind (0001_init.sql's `whatsapp_tenants.kind` CHECK
 * only allows `'ghl_location'`).
 *
 * `coach_id` itself is NOT banned outright: it is the retained historical
 * name of the tenant-id column on every `whatsapp_*` table (see
 * 0001_init.sql). What IS pinned is that every literal `.from("<table>")`
 * this bridge queries is one of those `whatsapp_*` tables — so `coach_id`
 * can only ever mean "tenant id on a whatsapp_* row", never a Hub coach.
 *
 * Comments are stripped first (same approach as the root
 * scripts/test/no-fitclosers.test.ts) — history comments may keep naming
 * the Hub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../src");

/** Remove block and line comments (keeping line breaks) while leaving string literals untouched. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep the comment's newlines so reported line numbers match the file.
      out += "\n".repeat(source.slice(i, stop).split("\n").length - 1);
      i = stop;
    } else if (ch === "/" && next === "/" && source[i - 1] !== ":") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function srcFiles(): { file: string; code: string }[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ file: `src/${name}`, code: stripComments(readFileSync(path.join(SRC, name), "utf8")) }));
}

const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: '"calls" table', pattern: /["'`]calls["'`]/ },
  { label: '"coaches" table', pattern: /["'`]coaches["'`]/ },
  { label: "automation_* tables", pattern: /automation_/ },
  { label: "call_id column", pattern: /call_id/ },
  { label: "'coach' tenant kind", pattern: /["'`]coach["'`]/ },
];

test("src/ never names a Hub table or column (calls, coaches, automation_*, call_id) or the 'coach' tenant kind", () => {
  const hits: string[] = [];
  for (const { file, code } of srcFiles()) {
    code.split("\n").forEach((line, idx) => {
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(line)) hits.push(`${file}:${idx + 1} [${label}]: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});

test("every table src/ queries is a whatsapp_* table — coach_id only ever means the tenant id on those rows", () => {
  const tables = new Set<string>();
  for (const { code } of srcFiles()) {
    for (const match of code.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) tables.add(match[1]!);
  }
  assert.ok(tables.size > 0, "expected to find the bridge's literal .from(...) table names");
  const notWhatsapp = [...tables].filter((t) => !t.startsWith("whatsapp_"));
  assert.deepEqual(notWhatsapp, []);
});
