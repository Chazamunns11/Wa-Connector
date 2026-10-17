/**
 * Bridge configuration — every tunable in ONE place, every safety limit an
 * env var with a documented default (hard rule 4: pacing is configuration,
 * not magic numbers buried in code).
 *
 * Fail-fast contract: `loadConfig()` throws at BOOT for anything the bridge
 * cannot run safely without (Supabase creds, the encryption key, the API
 * secret). A bridge that starts without its encryption key would either
 * crash on first session or — far worse — tempt a fallback to plaintext
 * storage; neither is acceptable, so it refuses to start at all. Optional
 * tunables fall back to the defaults documented in .env.example.
 */

export interface BridgeConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** 32-byte AES-256-GCM key (active) — see src/crypto.ts for the scheme. */
  credsKey: Buffer;
  /** Optional decrypt-only previous key, present only mid-rotation (README.md "Key rotation"). */
  credsKeyPrevious: Buffer | null;
  /** Shared secret the portal presents as `Authorization: Bearer …` on every route except /health. */
  bridgeSecret: string;
  port: number;
  /** Minimum gap between two sends on one coach's session (ms). */
  sendMinGapMs: number;
  /** Uniform random jitter added on top of the gap (ms). */
  sendJitterMs: number;
  /** Max sends per coach per UTC day. */
  dailyCap: number;
  /** Ramp a newly linked number's daily cap up over 14 days (src/pacing.ts WARMUP_SCHEDULE). Off by default. */
  warmupEnabled: boolean;
  /** Max groups one number may create per UTC day (src/group-limits.ts). Mass group creation is a ban trigger. */
  groupCreateDaily: number;
  /** Max people one number may add directly to groups per UTC day (src/group-limits.ts); the rest get an invite link. Mass adds are a ban trigger. */
  groupAddDaily: number;
  /** Show "typing…" before each outbound text part (src/typing.ts). */
  typingIndicatorEnabled: boolean;
  /** Longest single typing window (ms); 0 disables typing like the flag does. */
  typingMaxMs: number;
  /**
   * Session-lease heartbeat interval (ms) — see src/lock.ts. Default 10s.
   * `lockTtlMs` is 3x this: a holder is declared dead only after missing 3
   * consecutive beats, so shrinking this (rather than just shrinking the
   * TTL alone) is what keeps a healthy instance's lease from ever looking
   * stealable between beats — see loadConfig's ratio validation below.
   */
  lockHeartbeatMs: number;
  /**
   * Lease staleness TTL a rival instance may steal at (ms) — must be >
   * heartbeat. Default 30s (was 90s until the incident this fixes: a deploy
   * left every live session's lease held by a dead container — the old
   * container's SIGTERM handler never got a chance to run at all (see
   * src/main.ts's `wireGracefulShutdown`), so nothing released, and the
   * replacement container had to sit out the FULL 90s TTL, per session it
   * needed, before it could take over — a multi-minute recovery for a
   * handful of sessions. 30s keeps the same 3x safety ratio against
   * `lockHeartbeatMs` (a holder is declared dead only after missing 3
   * beats — never a false eviction from a single slow/dropped heartbeat)
   * while cutting the worst-case takeover stall to a third. The cost is 3x
   * more heartbeat writes at the new interval — trivial at single-digit
   * sessions per instance (tens of writes/minute, not hundreds).
   */
  lockTtlMs: number;
  /**
   * Ceiling (ms) `shutdownOneSession` (src/sessions.ts) waits for a
   * session's in-flight Signal key/creds writes to settle before releasing
   * that session's lease — the fix for the ratchet-desync incident (see
   * src/pending-writes.ts's file header). Bounded well under the 10s hard
   * stop at src/main.ts's `setTimeout(() => process.exit(1), 10_000)` — every
   * session's flush now runs CONCURRENTLY with every other session's
   * (src/sessions.ts's `shutdown()`), so this ceiling only needs margin for
   * ONE session's flush plus its own `lock.release()` round trip, not the
   * sum across all of them. See `loadConfig`'s boot validation for the
   * enforced ceiling.
   */
  shutdownFlushTimeoutMs: number;
  /**
   * Max automatic reconnect attempts for a session that has NEVER completed
   * pairing (phoneNumber still null — i.e. stuck at 'waiting_qr'). An
   * unscanned QR would otherwise re-register with WhatsApp roughly every
   * reconnect cycle forever: an external `fetchLatestBaileysVersion` call
   * plus two Supabase writes per cycle, indefinitely, for a coach who simply
   * hasn't scanned yet. After this many attempts the bridge gives up and
   * requires an explicit /connect to try again — see sessions.ts's
   * `handleClose`.
   */
  maxQrReconnectAttempts: number;
  logLevel: string;
  /**
   * Inbound-reply poke target (src/poke.ts) — BOTH optional, and the bridge
   * MUST run without them (hard rule 6: this deploys before the portal side
   * even exists). Unset means inbound replies are still written to
   * `whatsapp_inbound_messages` (the service-role Supabase write does not
   * depend on this at all) — they simply wait for the portal's hourly cron
   * drain instead of being poked within seconds. https-only, same refusal
   * rule as every other bridge->portal call in this codebase.
   */
  portalInboundUrl: string | null;
  /** Bearer secret for BOTH poke directions (see `portalOutboundUrl` below) — required to be set together with at least one of `portalInboundUrl`/`portalOutboundUrl` (see loadConfig). */
  waInboundPokeSecret: string | null;
  /**
   * GHL custom conversation provider, Phase 2 (docs/GHL-PROVIDER-PLAN.md,
   * file list #16) — outbound delivery-status poke target
   * (`POST /api/webhooks/crm-outbound-status`). Optional, same hard-rule-6
   * posture as `portalInboundUrl`: unset means a GHL send's eventual
   * sent/failed/not_on_whatsapp outcome still reaches GHL, just via the
   * portal's hourly cron drain instead of within seconds of dispatch
   * resolving (`src/sessions.ts`'s `drainQueue`). PAIRS WITH THE EXISTING
   * `waInboundPokeSecret` — deliberately NOT a second secret: one
   * bridge->portal trust link authorises both poke directions (see
   * loadConfig's validation below).
   */
  portalOutboundUrl: string | null;

  // ---------------------------------------------------------------------------
  // Media / attachment support (docs/MEDIA-PLAN.md §8) — BOTH master switches
  // default FALSE. With both off, behaviour is byte-identical to today: no
  // new outbound frame shape, no inbound download, ever. Every other tunable
  // below has a fail-safe default (nothing new is required to boot) and only
  // takes effect once its master switch is on.
  // ---------------------------------------------------------------------------
  /** Master switch — off = today's behaviour exactly (portal falls back to URL-lines; no bridge code path reads this today). */
  mediaOutboundEnabled: boolean;
  /** Master switch — off = placeholder-only, no downloads, ever (docs/MEDIA-PLAN.md §2 rule 4 / §8). */
  mediaInboundEnabled: boolean;
  /** Outbound attachment fetch cap (dispatch-time, plan §5.4). */
  mediaFetchTimeoutMs: number;
  /** Outbound per-type caps (plan §5.4's table) — image/video/audio/document. */
  mediaMaxImageBytes: number;
  mediaMaxAudioBytes: number;
  mediaMaxVideoBytes: number;
  mediaMaxDocumentBytes: number;
  /** Inbound per-file cap (plan §6.1/§9) — ONE flat cap regardless of type, unlike the outbound per-type table. */
  inboundMediaMaxBytes: number;
  /** Abuse caps (plan §9) — per (tenant, sender phone, UTC day) and per (tenant, UTC day). */
  inboundMediaPerSenderDaily: number;
  inboundMediaPerTenantDaily: number;
  /** Supabase Storage bucket for inbound media (plan §6.2/§7d). */
  mediaBucket: string;
  /**
   * Voice notes (docs/superpowers/plans/2026-10-17-voice-notes.md) — transcode a
   * non-ogg/opus outbound audio attachment to an ogg/opus voice note with
   * ffmpeg (src/voice-transcode.ts). Default off; needs ffmpeg with libopus in
   * the image, probed at boot. Off (or ffmpeg missing) = audio sends as a file.
   */
  voiceTranscodeEnabled: boolean;
  /** Log missed WhatsApp calls as inbound rows (src/calls.ts). Default off until the real-device check passes. */
  missedCallsEnabled: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[config] ${name} is not set — the bridge refuses to start without it. See .env.example.`);
  }
  return value;
}

/**
 * Decodes a base64 32-byte key, failing loudly on anything else: a truncated
 * or mistyped key must never silently become "a different key" (which would
 * present as every session failing to decrypt, indistinguishable from data
 * corruption).
 */
function decodeKey(name: string, value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(`[config] ${name} must be exactly 32 bytes of base64 (got ${key.length} bytes) — see .env.example for the generator one-liner.`);
  }
  return key;
}

function intWithDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`[config] ${name} must be a non-negative integer (got ${JSON.stringify(raw)}).`);
  }
  return parsed;
}

/** Strict boolean parser — anything other than exactly "true"/"false" (case-insensitive) refuses to boot rather than silently guessing, since these two flags gate whether media is ever downloaded/sent at all (docs/MEDIA-PLAN.md §8). Unset -> the fallback (always `false` at both call sites below). */
function boolWithDefault(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "true") return true;
  if (normalised === "false") return false;
  throw new Error(`[config] ${name} must be exactly "true" or "false" (got ${JSON.stringify(raw)}).`);
}

export function loadConfig(): BridgeConfig {
  const config: BridgeConfig = {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    credsKey: decodeKey("WA_CREDS_KEY", required("WA_CREDS_KEY")),
    credsKeyPrevious: process.env.WA_CREDS_KEY_PREVIOUS
      ? decodeKey("WA_CREDS_KEY_PREVIOUS", process.env.WA_CREDS_KEY_PREVIOUS)
      : null,
    bridgeSecret: required("WA_BRIDGE_SECRET"),
    port: intWithDefault("PORT", 8080),
    sendMinGapMs: intWithDefault("WA_SEND_MIN_GAP_MS", 45_000),
    sendJitterMs: intWithDefault("WA_SEND_JITTER_MS", 30_000),
    dailyCap: intWithDefault("WA_DAILY_CAP", 150),
    warmupEnabled: boolWithDefault("WA_WARMUP_ENABLED", false),
    groupCreateDaily: intWithDefault("WA_GROUP_CREATE_DAILY", 3),
    groupAddDaily: intWithDefault("WA_GROUP_ADD_DAILY", 50),
    typingIndicatorEnabled: boolWithDefault("WA_TYPING_INDICATOR_ENABLED", true),
    typingMaxMs: intWithDefault("WA_TYPING_MAX_MS", 4_000),
    lockHeartbeatMs: intWithDefault("WA_LOCK_HEARTBEAT_MS", 10_000),
    lockTtlMs: intWithDefault("WA_LOCK_TTL_MS", 30_000),
    shutdownFlushTimeoutMs: intWithDefault("WA_SHUTDOWN_FLUSH_TIMEOUT_MS", 5_000),
    maxQrReconnectAttempts: intWithDefault("WA_MAX_QR_RECONNECT_ATTEMPTS", 5),
    logLevel: process.env.LOG_LEVEL ?? "info",
    portalInboundUrl: null,
    waInboundPokeSecret: null,
    portalOutboundUrl: null,
    mediaOutboundEnabled: boolWithDefault("WA_MEDIA_OUTBOUND_ENABLED", false),
    mediaInboundEnabled: boolWithDefault("WA_MEDIA_INBOUND_ENABLED", false),
    mediaFetchTimeoutMs: intWithDefault("WA_MEDIA_FETCH_TIMEOUT_MS", 30_000),
    mediaMaxImageBytes: intWithDefault("WA_MEDIA_MAX_IMAGE_BYTES", 10 * 1024 * 1024),
    mediaMaxAudioBytes: intWithDefault("WA_MEDIA_MAX_AUDIO_BYTES", 16 * 1024 * 1024),
    mediaMaxVideoBytes: intWithDefault("WA_MEDIA_MAX_VIDEO_BYTES", 50 * 1024 * 1024),
    mediaMaxDocumentBytes: intWithDefault("WA_MEDIA_MAX_DOCUMENT_BYTES", 100 * 1024 * 1024),
    inboundMediaMaxBytes: intWithDefault("WA_INBOUND_MEDIA_MAX_BYTES", 25 * 1024 * 1024),
    inboundMediaPerSenderDaily: intWithDefault("WA_INBOUND_MEDIA_PER_SENDER_DAILY", 20),
    inboundMediaPerTenantDaily: intWithDefault("WA_INBOUND_MEDIA_PER_TENANT_DAILY", 300),
    mediaBucket: process.env.WA_MEDIA_BUCKET?.trim() || "wa-media",
    voiceTranscodeEnabled: boolWithDefault("WA_VOICE_TRANSCODE_ENABLED", false),
    missedCallsEnabled: boolWithDefault("WA_MISSED_CALLS_ENABLED", false),
  };

  if (config.lockTtlMs <= config.lockHeartbeatMs) {
    throw new Error(
      `[config] WA_LOCK_TTL_MS (${config.lockTtlMs}) must exceed WA_LOCK_HEARTBEAT_MS (${config.lockHeartbeatMs}) — ` +
        "a TTL at or below the heartbeat interval means a healthy instance's lease looks stealable between beats."
    );
  }
  if (config.shutdownFlushTimeoutMs < 500) {
    throw new Error(
      `[config] WA_SHUTDOWN_FLUSH_TIMEOUT_MS (${config.shutdownFlushTimeoutMs}) must be at least 500ms — ` +
        "0 boots fine and silently disables the entire ratchet-desync fix: flush()'s budgetMs <= 0 check " +
        "(src/pending-writes.ts) returns `timedOut: true` immediately, without awaiting a single write, reverting " +
        "to exactly the pre-fix incident behaviour (src/pending-writes.ts's file header) while this var LOOKS " +
        "configured and deployed. A layer that loudly refuses anything at or above the ceiling below must equally " +
        "refuse a value that quietly defeats the fix near zero."
    );
  }
  if (config.shutdownFlushTimeoutMs >= 6_000) {
    throw new Error(
      `[config] WA_SHUTDOWN_FLUSH_TIMEOUT_MS (${config.shutdownFlushTimeoutMs}) must be under 6000ms — ` +
        "src/main.ts's hard stop fires at 10s past SIGTERM, and this ceiling still needs margin for the lease-release " +
        "round trip that runs AFTER a session's flush completes (sessions now shut down concurrently, so this is " +
        "margin for one session's slowest path, not a sum across all of them). A flush timing out is CORRELATED " +
        "with Supabase being slow — exactly when that release round trip is slowest too — so the ceiling stays " +
        "close to the default (5000ms, already sized with a healthy margin) rather than eating most of the 10s " +
        "budget: at the old 8000ms ceiling, a fully-timed-out flush left only ~2s for releases to complete before " +
        "the hard stop, which meant all leases waiting out the full WA_LOCK_TTL_MS instead."
    );
  }
  if (config.bridgeSecret.length < 32) {
    throw new Error("[config] WA_BRIDGE_SECRET must be at least 32 characters — this secret alone authorises sends from every client's WhatsApp.");
  }

  // Inbound-reply poke config, extended by GHL provider Phase 2's outbound
  // poke (docs/GHL-PROVIDER-PLAN.md, file list #16) — THREE knobs, ONE shared
  // secret. A URL with no secret would poke an endpoint with no auth (or,
  // worse, invites "just leave the secret off for now"); a secret with
  // neither URL set is dead config nobody will notice is doing nothing.
  // Require the secret together with AT LEAST ONE of the two URLs — the two
  // URLs are otherwise fully independent (either, both, or neither may be
  // set) since they poke two unrelated portal routes.
  const portalInboundUrlRaw = process.env.PORTAL_INBOUND_URL;
  const portalOutboundUrlRaw = process.env.PORTAL_OUTBOUND_URL;
  const waInboundPokeSecretRaw = process.env.WA_INBOUND_POKE_SECRET;
  if ((portalInboundUrlRaw || portalOutboundUrlRaw) && !waInboundPokeSecretRaw) {
    throw new Error(
      "[config] PORTAL_INBOUND_URL/PORTAL_OUTBOUND_URL is set but WA_INBOUND_POKE_SECRET is not — the shared secret is required whenever either poke URL is set."
    );
  }
  if (waInboundPokeSecretRaw && !portalInboundUrlRaw && !portalOutboundUrlRaw) {
    throw new Error(
      "[config] WA_INBOUND_POKE_SECRET is set but neither PORTAL_INBOUND_URL nor PORTAL_OUTBOUND_URL is — set at least one poke URL, or unset the secret."
    );
  }
  if (portalInboundUrlRaw) {
    if (!portalInboundUrlRaw.startsWith("https://")) {
      throw new Error("[config] PORTAL_INBOUND_URL must be https:// — same refusal rule as every other bridge->portal call.");
    }
    config.portalInboundUrl = portalInboundUrlRaw;
  }
  if (portalOutboundUrlRaw) {
    if (!portalOutboundUrlRaw.startsWith("https://")) {
      throw new Error("[config] PORTAL_OUTBOUND_URL must be https:// — same refusal rule as every other bridge->portal call.");
    }
    config.portalOutboundUrl = portalOutboundUrlRaw;
  }
  if (waInboundPokeSecretRaw) {
    if (waInboundPokeSecretRaw.length < 32) {
      throw new Error("[config] WA_INBOUND_POKE_SECRET must be at least 32 characters when set.");
    }
    config.waInboundPokeSecret = waInboundPokeSecretRaw;
  }

  return config;
}
