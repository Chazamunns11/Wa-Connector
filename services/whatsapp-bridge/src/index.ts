/**
 * Thin process entrypoint — the actual boot sequence lives in src/main.ts
 * (`main()`, `wireGracefulShutdown()`), imported and called below. This file
 * exists ONLY to be "the thing Node was actually invoked on"; it must never
 * grow logic of its own.
 *
 * THE FAILURE MODE THIS SPLIT FIXES: this file used to hold `main()`
 * directly, guarded by an "am I the entrypoint" check —
 * `process.argv[1] === fileURLToPath(import.meta.url)` — so importing it
 * from a test wouldn't execute `main()` as a side effect. Proven locally to
 * be FALSE (and therefore skip `main()` entirely) under two conditions that
 * are one infra change away from today's exact start command
 * (`node dist/index.js`):
 *   - `node dist` (directory form) — Node resolves `dist`'s package.json/
 *     index convention rather than argv[1] literally being this file's path.
 *   - ANY symlink in the path (pnpm's linked node_modules/bin layouts, a
 *     Dockerfile COPY through a symlink) — `fileURLToPath(import.meta.url)`
 *     resolves through the symlink, `process.argv[1]` does not, so a
 *     byte-identical file is reached by two different-looking paths.
 * In BOTH cases the process exits 0 having done nothing and printed
 * nothing — no crash, no stack trace, no log line, just a container that
 * Railway sees come up healthy... because nothing in it ever ran far enough
 * to open port `PORT`, let alone a single one of the 7 live client WhatsApp
 * sessions. That is an all-clients-dark blackout with nothing to grep for.
 *
 * The fix removes the need for entrypoint detection rather than patching the
 * comparison: `main()` now lives in src/main.ts as a plain export with NO
 * self-execution of its own, so there is nothing here for a symlink or a
 * directory-form invocation to defeat — this file's only job, importing
 * `main` and calling it, does not depend on how Node was invoked. Both
 * `npm start` (`node dist/index.js`) and `npm run dev` (`tsx src/index.ts`)
 * still resolve `./main.js` to the same module (tsx resolves the `.js`
 * specifier to `main.ts` in dev, `tsc` emits `dist/main.js` for prod — same
 * NodeNext convention every other relative import in this package already
 * uses). test/main.test.ts imports src/main.ts directly for the same
 * reason it always could have: no guard to route around, no risk of a bare
 * import executing `main()`.
 */
import { main } from "./main.js";

main().catch((err) => {
  // Config/boot failures print the message only — never a dump that could
  // include env contents.
  console.error(`[whatsapp-bridge] fatal: ${(err as Error).message}`);
  process.exit(1);
});
