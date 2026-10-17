/**
 * Bridge boot sequence — everything that actually runs the service. Lives
 * here, in a module with NO top-level self-execution, rather than in
 * src/index.ts directly — see src/index.ts's own file header for the
 * incident this split fixes (an "am I the entrypoint" guard that could exit
 * 0 having booted nothing, with nothing to grep for). `main()` and
 * `wireGracefulShutdown()` are exported so both src/index.ts (the real
 * process entrypoint) and test/main.test.ts (which exercises
 * `wireGracefulShutdown` directly) can import this module with zero risk of
 * a bare `import` executing anything as a side effect.
 *
 * Boot order matters:
 *   1. loadConfig() — fail fast on missing secrets (see src/config.ts).
 *   2. HTTP server up FIRST, so Railway's healthcheck passes while sessions
 *      resume (a slow resume must not fail a deploy).
 *   3. SIGTERM/SIGINT registered — BEFORE `resumeAll()` is even awaited. See
 *      `wireGracefulShutdown`'s own JSDoc below for the incident this fixes:
 *      registering the handlers AFTER awaiting resumeAll() used to leave a
 *      window — tens of seconds with 7+ sessions, since resumeAll opens a
 *      WebSocket and runs a full Signal handshake per session, sequentially
 *      — where a SIGTERM hit Node's DEFAULT behaviour (instant exit, no
 *      handler installed yet): zero leases released, and the Signal-key
 *      flush that fixes the ratchet-desync incident (src/pending-writes.ts)
 *      never got to run either, since that flush lives in the SAME graceful
 *      path this default behaviour skipped entirely.
 *   4. resumeAll() — reopen every session with linked creds; per-coach
 *      failures are logged, never fatal. Registering handlers first (step 3)
 *      means a signal can now legitimately arrive WHILE this is still in
 *      flight — SessionManager's own `shuttingDown` flag (src/sessions.ts)
 *      is what makes that safe; see its JSDoc for the full race analysis.
 *   5. SIGTERM/SIGINT fire `shutdown`: graceful — close sockets, RELEASE
 *      every session lease (so the replacement deploy takes over immediately
 *      instead of waiting out WA_LOCK_TTL_MS), then exit. Railway sends
 *      SIGTERM on redeploy. `shutdown()` itself now also waits out any
 *      `SessionManager.startSession` call still in flight before resolving
 *      — see `SessionManager.shutdown`'s own JSDoc (src/sessions.ts) for the
 *      orphaned-lease incident that fixes, and note it is THIS function's
 *      `.finally(() => process.exit(0))` below whose timing that fix is
 *      actually protecting: an in-flight lease claim released a moment
 *      AFTER this file's own process.exit() would already have fired is no
 *      fix at all.
 */
import { pino } from "pino";
import { loadConfig } from "./config.js";
import { BridgeStore } from "./store.js";
import { SessionManager } from "./sessions.js";
import { createBridgeServer } from "./server.js";
import { PortalPoke } from "./poke.js";
import { installConsoleGuard } from "./console-guard.js";
import type { BridgeConfig } from "./config.js";
import type { SessionMediaDeps } from "./sessions.js";
import { probeFfmpeg, realFfmpegRunner, transcodeToVoiceNote, type FfmpegRunner } from "./voice-transcode.js";

export const FFMPEG_MISSING_LOG =
  "voice transcode enabled but ffmpeg with libopus was not found — voice notes will send as audio files";

/**
 * The voice-note transcoder for SessionManager, or null (transcoding off).
 * Flag off → null and ffmpeg is never run. Flag on → one probe; if ffmpeg
 * with libopus is missing, log once and return null, so sends behave exactly
 * as with the flag off (plain audio files; webm/wav still refused). Input is
 * capped at WA_MEDIA_MAX_AUDIO_BYTES, the same cap media-fetch applies.
 */
export async function voiceTranscodeFor(
  config: Pick<BridgeConfig, "voiceTranscodeEnabled" | "mediaMaxAudioBytes">,
  run: FfmpegRunner,
  log: { warn: (msg: string) => void }
): Promise<NonNullable<SessionMediaDeps["transcode"]> | null> {
  if (!config.voiceTranscodeEnabled) return null;
  if (!(await probeFfmpeg(run))) {
    log.warn(FFMPEG_MISSING_LOG);
    return null;
  }
  return (buf, mime) => transcodeToVoiceNote(buf, mime, { maxInputBytes: config.mediaMaxAudioBytes, run });
}

/**
 * The exact surface `wireGracefulShutdown` touches on `process` —
 * deliberately structural (same rationale as sessions.ts's
 * `ShutdownableSession`/`StoppableSession` etc.) so test/main.test.ts can
 * pin the registration-before-resume ordering with a plain fake object: no
 * real process-wide signal handler (which would leak across every other
 * test in the same `node:test` run), no real SessionManager, no Supabase, no
 * Baileys.
 */
export interface SignalTarget {
  on(event: "SIGTERM" | "SIGINT", handler: () => void): unknown;
}

/**
 * Registers SIGTERM/SIGINT and ONLY THEN awaits `resumeAll()` — extracted to
 * a standalone, directly-testable function specifically so this ordering
 * can be pinned without booting the real service (real Supabase, real
 * Baileys, a real HTTP listener). See this file's header, point 3, for the
 * incident this ordering fixes.
 *
 * This function owns ONLY the ordering. Registering the handlers earlier
 * reopens a different race, deliberately NOT handled here: a signal can now
 * arrive while `resumeAll()` — and everything it calls, including
 * `SessionManager.doStartSession` per coach — is still in flight. That
 * concurrency safety is entirely `SessionManager`'s responsibility, via its
 * own `shuttingDown` flag (see that field's JSDoc in src/sessions.ts for the
 * full happens-before argument for why no session can end up holding a
 * lease that no teardown pass will ever see). Splitting it this way keeps
 * the two concerns independently testable: this file proves the WIRING
 * order; sessions.ts proves the RACE is safe once both sides are live.
 */
export async function wireGracefulShutdown(
  target: SignalTarget,
  resumeAll: () => Promise<void>,
  shutdown: (signal: string) => void
): Promise<void> {
  target.on("SIGTERM", () => shutdown("SIGTERM"));
  target.on("SIGINT", () => shutdown("SIGINT"));
  await resumeAll();
}

/**
 * The actual boot sequence — see this file's own header for the ordering
 * rationale. Exported (not run here) so src/index.ts's thin entrypoint owns
 * the ONLY call site, and test/main.test.ts can import this module for its
 * exports without ever triggering that call.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });
  // Must come AFTER pino() above (so there's a logger to route through) and
  // is never uninstalled for the life of the process — see
  // src/console-guard.ts's file header for why libsignal needs this at all
  // (it bypasses pino entirely via the global console) and why this
  // ordering specifically leaves the earlier `loadConfig()` failure path
  // below in `main().catch(...)` — now in src/index.ts, this function's only
  // caller — using the native `console.error`.
  installConsoleGuard(log);

  const store = new BridgeStore(config);
  // Optional (hard rule 6): null until Charlie sets PORTAL_INBOUND_URL /
  // WA_INBOUND_POKE_SECRET on Railway — inbound replies are written to
  // Supabase either way; only the "poke the portal within seconds" latency
  // optimisation is gated on this being configured (see src/poke.ts).
  const poke = config.portalInboundUrl && config.waInboundPokeSecret
    ? new PortalPoke({ url: config.portalInboundUrl, secret: config.waInboundPokeSecret }, log.child({ module: "poke" }))
    : null;
  // GHL custom conversation provider, Phase 2 (docs/GHL-PROVIDER-PLAN.md,
  // file list #16) — the outbound delivery-status poke, a second PortalPoke
  // instance pointed at a different portal route but sharing the SAME
  // WA_INBOUND_POKE_SECRET as `poke` above (see config.ts). Same optional/
  // hard-rule-6 posture: null until PORTAL_OUTBOUND_URL is set.
  const outboundPoke = config.portalOutboundUrl && config.waInboundPokeSecret
    ? new PortalPoke({ url: config.portalOutboundUrl, secret: config.waInboundPokeSecret }, log.child({ module: "outbound-poke" }))
    : null;
  // One short ffmpeg probe, only with WA_VOICE_TRANSCODE_ENABLED on (bounded by its 10 s timeout).
  const transcode = await voiceTranscodeFor(config, realFfmpegRunner, log);
  const manager = new SessionManager(store, config, log, poke, outboundPoke, { transcode });
  const server = createBridgeServer({ manager, store, bridgeSecret: config.bridgeSecret, log, mediaOutboundEnabled: config.mediaOutboundEnabled });

  server.listen(config.port, () => {
    log.info({ port: config.port, instanceId: manager.instanceId }, "whatsapp-bridge listening");
  });

  // Built BEFORE resumeAll is awaited (see `wireGracefulShutdown` below) —
  // `shutdown` itself only closes over `server`/`manager`/`log`, all already
  // constructed above, so defining it here and registering it immediately
  // costs nothing and is what closes the incident window.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down — closing sessions and releasing leases");
    server.close();
    void manager
      .shutdown()
      .catch((err) => log.error({ err: (err as Error).message }, "shutdown error"))
      .finally(() => process.exit(0));
    // Hard stop if a hung socket keeps us alive past Railway's grace window.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  await wireGracefulShutdown(process, () => manager.resumeAll(), shutdown);
  log.info("session resume pass complete");
}
