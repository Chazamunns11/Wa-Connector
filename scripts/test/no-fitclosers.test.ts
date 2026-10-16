/**
 * Review Focus 2 — leftover FitClosers wording or URLs. Walks `src/` and
 * `services/whatsapp-bridge/src/` (skipping any that do not exist yet — the
 * bridge arrives in a later task), strips `//` and block comments, and fails
 * on any /fitclosers/i hit in what remains. Comments may keep history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "services/whatsapp-bridge/src"];
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(name)) out.push(full);
  }
  return out;
}

/** Remove block and line comments while leaving string literals untouched. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
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

test("no 'fitclosers' outside comments in src/ or the bridge service", () => {
  const hits: string[] = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      stripped.split("\n").forEach((line, idx) => {
        if (/fitclosers/i.test(line)) hits.push(`${file}:${idx + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
