/**
 * Resolve `@/…` the way tsconfig.json's `paths` does, so tests can import the
 * real application modules instead of copies.
 *
 * Node 24 strips TypeScript types natively, so `.ts` sources run directly —
 * the only thing missing is the path alias, which is a bundler concept Node
 * knows nothing about. This adds it in ~10 lines rather than pulling in a test
 * framework and a transpiler to get the same result.
 *
 * Preload with:  node --import ./scripts/test/alias-hook.mjs …
 *
 * EXTENSIONLESS-SPECIFIER FALLBACK (added for scripts/test/feed.test.ts, 5 Aug
 * 2026 — Shannon Jaggard feed-row incident): that new test is the first one
 * in this suite to import `src/lib/data/demo.ts`, and it fails to load
 * without this. Node's native type-stripping ESM loader is strict about
 * extensions in a way both Next's own bundler AND Node's CJS `require()`
 * historically were not:
 *
 *   1. `src/lib/data/demo.ts` has one bare `from "./supabase"` (its
 *      `CloserInviteRefusedError` re-export) rather than the `@/lib/data/…`
 *      alias every other cross-file import in this codebase uses — Node
 *      needs the literal `./supabase.ts`.
 *   2. `src/lib/data/supabase.ts` itself imports `next/headers` — Next's
 *      package.json has no `"exports"` map for that subpath, so plain ESM
 *      resolution refuses the bare `next/headers` and only accepts the
 *      literal on-disk `next/headers.js` (Node's own error message for this
 *      case literally suggests that exact fix).
 *
 * Rather than hand-fix these two call sites (and whichever others turn up
 * next time a test reaches further into `src/lib/data`), this hook now
 * retries ANY specifier Node's own resolver rejects with `ERR_MODULE_NOT_FOUND`
 * by re-asking `nextResolve` with each of a short list of extensions/index
 * files appended — exactly Node's own suggested fix, generalised. Every
 * specifier that already resolved before this change keeps resolving through
 * the exact same first-try path (this only ever engages after a genuine
 * `ERR_MODULE_NOT_FOUND`; any other resolution error still throws
 * unchanged), so no previously-passing test's resolution behaviour moves.
 */
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** tsconfig `paths` maps `@/*` -> `./src/*`, extension-less. Try the same candidates a bundler would. */
function resolveAlias(spec) {
  const rel = spec.slice(2);
  const base = path.join(SRC, rel);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

/** See this file's header EXTENSIONLESS-SPECIFIER FALLBACK comment — candidates tried, in order, for a specifier Node couldn't resolve as given. */
const FALLBACK_SUFFIXES = [".ts", ".tsx", ".js", "/index.ts", "/index.js"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const hit = resolveAlias(specifier);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      // No alias hit — fall through to the normal resolver below, which will
      // predictably fail with the codebase's own clear "module not found"
      // error rather than this hook masking a genuine typo.
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
      for (const suffix of FALLBACK_SUFFIXES) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // Not this candidate — try the next one; the ORIGINAL error (not
          // this candidate's) is what gets thrown if none of them hit.
        }
      }
      throw err;
    }
  },
});
