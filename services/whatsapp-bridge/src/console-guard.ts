/**
 * Console guard — libsignal (a Baileys transitive dependency) calls the
 * GLOBAL `console` directly for its own internal diagnostics, completely
 * bypassing the pino 'warn' floor set on the Baileys child logger passed to
 * `makeWASocket` (src/sessions.ts:522). That floor exists for exactly one
 * reason (see that call site's own comment): Baileys' own logger can carry
 * frame/key-material content at 'debug'/'trace', and this bridge's log sink
 * retains logs for 7 days — a plaintext Signal private key sitting in a log
 * line for a week defeats src/crypto.ts's entire at-rest encryption design
 * for a value FAR more sensitive than the creds that module protects. This
 * guard closes that gap for the ONE other place key material can reach a log
 * line: the global `console`, which pino never touches.
 *
 * Verified leaking call sites (node_modules/libsignal/src) — every one below
 * passes a LIVE session/record object (not a string) as a console argument,
 * and that object embeds Signal private key material:
 *   - session_record.js:270 console.warn("Session already closed", session)
 *   - session_record.js:273 console.info("Closing session:", session)
 *   - session_record.js:281 console.info("Opening session:", session)
 *   - session_record.js:301 console.info("Removing old closed session:", oldestSession)
 *   - queue_job.js:50       console.warn("Unhandled bucket type (for naming):", typeof bucket, bucket)
 *
 * Genuinely useful, KEY-FREE diagnostics also go through console, at both
 * warn AND error, and must keep surfacing:
 *   - session_cipher.js:157  console.error("Failed to decrypt message with any known session...")
 *   - session_cipher.js:159  console.error("Session error:" + e, e.stack)
 *   - session_builder.js:74  console.warn("Closing open session in favor of incoming prekey bundle")
 *   - curve.js:43            console.error("WARNING: Expected pubkey of length 33, please report the ST and client that generated the pubkey")
 *
 * Because key material leaks at BOTH info and warn, while useful fixed
 * strings also live at BOTH warn and error, filtering by console METHOD
 * (e.g. "drop console.info, keep console.warn/error") cannot separate the
 * two — a method-level filter would either still leak keys (keep warn) or
 * lose the decrypt-failure diagnostic (drop warn). The only place that
 * reliably distinguishes safe from unsafe is the ARGUMENT itself: a string
 * literal libsignal wrote is always safe; an object/Buffer it is dumping
 * wholesale is not. Hence `sanitizeConsoleArgs` redacts per argument, not by
 * filtering methods.
 *
 * LEVEL MAPPING (installConsoleGuard): console.error -> log.error,
 * console.warn -> log.warn, console.log/info/debug -> log.debug. The
 * redacted "Opening/Closing session" lines above fire on every single
 * decrypt/encrypt (libsignal opens or closes a session per operation), so
 * routing them to 'debug' keeps them out of the default 'info' floor — pure
 * per-message noise once the key material is gone — while still being
 * reachable with LOG_LEVEL=debug if a real investigation ever needs the
 * volume. warn/error keep their native level so the third-party diagnostics
 * above stay visible by default, same as today.
 *
 * NO RECURSION RISK: pino writes to fd 1 (stdout) directly — it never calls
 * through `console.*` itself — so patching `console` here cannot create a
 * pino -> console -> pino loop.
 *
 * Wired in src/main.ts's `main()` immediately after `pino(...)` is
 * constructed, and STRICTLY after `loadConfig()`/`pino()` — the top-level
 * config-failure `console.error` (src/index.ts's `main().catch(...)`, the
 * only caller of `main()`) must keep using the native console, since at that
 * point there is no logger yet to route through and no session has opened
 * to leak from.
 */
import type { Logger } from "pino";

/** The five console methods this guard patches — the full surface libsignal (and anything else in the dependency tree) can reach for. */
type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

/**
 * Pure — no console access, no pino — so this half of the guard is
 * unit-testable with plain fabricated objects (test/console-guard.test.ts),
 * independent of the patch/install machinery below.
 *
 * Primitives pass through unchanged (joined with spaces, matching
 * `console.log`'s own formatting) because they are structurally incapable of
 * carrying a Buffer/typed-array of key bytes — a string libsignal wrote
 * itself (e.g. "Closing open session in favor of incoming prekey bundle") is
 * always safe to surface verbatim. `Error` instances collapse to
 * `name: message` only — no `.stack` and no enumerable extra properties,
 * either of which could carry argument/context detail in some error
 * subclasses. Everything else (plain objects, Buffers, arrays, functions —
 * exactly what libsignal dumps at the leaking call sites in the file header)
 * becomes a placeholder naming only its constructor: diagnostic enough to
 * tell an operator "a Buffer/SessionEntry argument was here" while being
 * structurally unable to carry key bytes, since the constructor NAME is a
 * fixed string, never the object's own data.
 *
 * NEVER THROWS, for any argument shape — including a hostile one this
 * bridge does not control: a `constructor` accessor (own or inherited) that
 * throws on read, a Proxy whose `get` trap throws on any property access, or
 * an `Error` subclass with a throwing `message`/`name` getter. The patched
 * `console.*` this function backs stands in for the native console, which
 * never throws; a guard that CAN throw would turn "libsignal logged
 * something" into "libsignal's decrypt call now raises an exception it
 * never would have natively", which is a strictly worse outcome than the
 * key-leak this file exists to prevent. Any argument that throws during
 * classification falls back to a bare `"[redacted]"` placeholder instead
 * (see the try/catch below) — still counted in `redactedCount`, since
 * something un-inspectable was, definitionally, not safe to surface.
 */
export function sanitizeConsoleArgs(args: unknown[]): { message: string; redactedCount: number } {
  let redactedCount = 0;
  const parts = args.map((arg) => {
    if (arg === null) return "null";
    const kind = typeof arg;
    if (kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint" || kind === "undefined") {
      return String(arg);
    }
    // Everything below this line reads a PROPERTY OF THE HOSTILE ARGUMENT
    // ITSELF — `instanceof`, `.name`, `.message`, `.constructor`, all of
    // which can be a throwing getter/proxy trap on an object this bridge
    // never controls (libsignal's own dependency tree, or anything else
    // reaching the global `console`). This guard's entire purpose is
    // wrapping calls this bridge doesn't control so they can never crash a
    // caller — a sanitiser whose OWN failure mode is throwing would inject a
    // brand-new exception into whatever called console.error/warn, which for
    // libsignal is mid-decrypt (see this file's header). Never let that
    // happen: try the real classification, fall back to a bare placeholder
    // on ANY throw.
    try {
      if (arg instanceof Error) {
        const rendered = `${arg.name}: ${arg.message}`;
        redactedCount++;
        return rendered;
      }
      // Objects, Buffers, arrays, functions — anything else. `constructor.name`
      // is a fixed string owned by the class/prototype, never the instance's
      // own data, so it cannot itself carry key bytes.
      const ctorName = (arg as { constructor?: { name?: string } })?.constructor?.name;
      redactedCount++;
      return `[redacted ${ctorName || "Object"}]`;
    } catch {
      redactedCount++;
      return "[redacted]";
    }
  });
  return { message: parts.join(" "), redactedCount };
}

/**
 * Patches the global console so every libsignal call site above (and
 * anything else in the dependency tree that reaches for `console` directly)
 * is sanitised before it can reach a log sink. Returns an uninstall function
 * — tests use it to restore the native methods; production calls it exactly
 * once, for the process lifetime, from src/main.ts, and never uninstalls.
 */
export function installConsoleGuard(log: Logger): () => void {
  const guardLog = log.child({ module: "console" });
  const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const patch = (method: ConsoleMethod): void => {
    console[method] = (...args: unknown[]): void => {
      const { message } = sanitizeConsoleArgs(args);
      // See file header's LEVEL MAPPING for why log/info/debug all collapse
      // to 'debug' while warn/error keep their native level.
      if (method === "error") guardLog.error(message);
      else if (method === "warn") guardLog.warn(message);
      else guardLog.debug(message);
    };
  };

  (Object.keys(original) as ConsoleMethod[]).forEach(patch);

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  };
}
