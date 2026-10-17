/**
 * src/config.ts — the GHL provider Phase 2 addition to `loadConfig`'s
 * poke-config validation (docs/GHL-PROVIDER-PLAN.md §4 item 9):
 * `PORTAL_OUTBOUND_URL` shares `WA_INBOUND_POKE_SECRET` with the existing
 * `PORTAL_INBOUND_URL` rather than needing a second secret. Every other
 * required env var is set to a minimal-but-valid value so each test isolates
 * the ONE thing it's checking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  WA_CREDS_KEY: randomBytes(32).toString("base64"),
  WA_BRIDGE_SECRET: "bridge-secret-0123456789-0123456789-0123456789",
};

const POKE_SECRET = "poke-secret-0123456789-0123456789-0123456789";
const POKE_KEYS = ["PORTAL_INBOUND_URL", "PORTAL_OUTBOUND_URL", "WA_INBOUND_POKE_SECRET"];
/** Media plan (docs/MEDIA-PLAN.md §8) — every var `withEnv` must clear before each test so one test's override can never leak into the next. */
const MEDIA_KEYS = [
  "WA_MEDIA_OUTBOUND_ENABLED",
  "WA_MEDIA_INBOUND_ENABLED",
  "WA_MEDIA_FETCH_TIMEOUT_MS",
  "WA_MEDIA_MAX_IMAGE_BYTES",
  "WA_MEDIA_MAX_AUDIO_BYTES",
  "WA_MEDIA_MAX_VIDEO_BYTES",
  "WA_MEDIA_MAX_DOCUMENT_BYTES",
  "WA_INBOUND_MEDIA_MAX_BYTES",
  "WA_INBOUND_MEDIA_PER_SENDER_DAILY",
  "WA_INBOUND_MEDIA_PER_TENANT_DAILY",
  "WA_MEDIA_BUCKET",
  "WA_VOICE_TRANSCODE_ENABLED",
];
/** Ratchet-desync fix (src/pending-writes.ts) — the one new shutdown-flush tunable, same "clear before every test" discipline as the media/poke keys above. */
const SHUTDOWN_FLUSH_KEYS = ["WA_SHUTDOWN_FLUSH_TIMEOUT_MS"];
/** Session-lease heartbeat/TTL (src/lock.ts) — same "clear before every test" discipline as the keys above. */
const LOCK_KEYS = ["WA_LOCK_HEARTBEAT_MS", "WA_LOCK_TTL_MS"];
/** Group management daily limits (src/group-limits.ts). */
const GROUP_LIMIT_KEYS = ["WA_GROUP_CREATE_DAILY", "WA_GROUP_ADD_DAILY"];
const CLEARED_KEYS = [...POKE_KEYS, ...MEDIA_KEYS, ...SHUTDOWN_FLUSH_KEYS, ...LOCK_KEYS, ...GROUP_LIMIT_KEYS];

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(BASE_ENV)) previous[key] = process.env[key];
  for (const key of CLEARED_KEYS) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(BASE_ENV)) process.env[key] = value;
    for (const key of CLEARED_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("config: neither poke URL nor the shared secret set — boots fine, both poke targets null", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.portalInboundUrl, null);
    assert.equal(config.portalOutboundUrl, null);
    assert.equal(config.waInboundPokeSecret, null);
  });
});

test("config: PORTAL_OUTBOUND_URL without WA_INBOUND_POKE_SECRET refuses to boot", () => {
  withEnv({ PORTAL_OUTBOUND_URL: "https://portal.example.com/api/webhooks/crm-outbound-status" }, () => {
    assert.throws(() => loadConfig(), /WA_INBOUND_POKE_SECRET is not/);
  });
});

test("config: WA_INBOUND_POKE_SECRET with NEITHER poke URL refuses to boot", () => {
  withEnv({ WA_INBOUND_POKE_SECRET: POKE_SECRET }, () => {
    assert.throws(() => loadConfig(), /set at least one poke URL/);
  });
});

test("config: PORTAL_OUTBOUND_URL over http:// (not localhost) is refused even with the secret set", () => {
  withEnv({ PORTAL_OUTBOUND_URL: "http://portal.example.com/api/webhooks/crm-outbound-status", WA_INBOUND_POKE_SECRET: POKE_SECRET }, () => {
    assert.throws(() => loadConfig(), /PORTAL_OUTBOUND_URL must be https/);
  });
});

test("config: PORTAL_OUTBOUND_URL + the shared secret both set — configured", () => {
  withEnv(
    { PORTAL_OUTBOUND_URL: "https://portal.example.com/api/webhooks/crm-outbound-status", WA_INBOUND_POKE_SECRET: POKE_SECRET },
    () => {
      const config = loadConfig();
      assert.equal(config.portalOutboundUrl, "https://portal.example.com/api/webhooks/crm-outbound-status");
      assert.equal(config.waInboundPokeSecret, POKE_SECRET);
      assert.equal(config.portalInboundUrl, null, "the inbound URL stays independently optional");
    }
  );
});

test("config: BOTH poke URLs set alongside the one shared secret — both configured", () => {
  withEnv(
    {
      PORTAL_INBOUND_URL: "https://portal.example.com/api/webhooks/whatsapp-replies",
      PORTAL_OUTBOUND_URL: "https://portal.example.com/api/webhooks/crm-outbound-status",
      WA_INBOUND_POKE_SECRET: POKE_SECRET,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.portalInboundUrl, "https://portal.example.com/api/webhooks/whatsapp-replies");
      assert.equal(config.portalOutboundUrl, "https://portal.example.com/api/webhooks/crm-outbound-status");
      assert.equal(config.waInboundPokeSecret, POKE_SECRET);
    }
  );
});

test("config: PORTAL_INBOUND_URL alone (pre-existing behaviour) is untouched by the Phase 2 addition", () => {
  withEnv({ PORTAL_INBOUND_URL: "https://portal.example.com/api/webhooks/whatsapp-replies", WA_INBOUND_POKE_SECRET: POKE_SECRET }, () => {
    const config = loadConfig();
    assert.equal(config.portalInboundUrl, "https://portal.example.com/api/webhooks/whatsapp-replies");
    assert.equal(config.portalOutboundUrl, null);
  });
});

// ---------------------------------------------------------------------------
// Media plan (docs/MEDIA-PLAN.md §8) — every new var has a fail-safe default;
// nothing new is required to boot. Both master switches default false.
// ---------------------------------------------------------------------------

test("config: no WA_MEDIA_* vars set at all — every media default matches docs/MEDIA-PLAN.md §8 exactly, both switches off", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.mediaOutboundEnabled, false);
    assert.equal(config.mediaInboundEnabled, false);
    assert.equal(config.mediaFetchTimeoutMs, 30_000);
    assert.equal(config.mediaMaxImageBytes, 10 * 1024 * 1024);
    assert.equal(config.mediaMaxAudioBytes, 16 * 1024 * 1024);
    assert.equal(config.mediaMaxVideoBytes, 50 * 1024 * 1024);
    assert.equal(config.mediaMaxDocumentBytes, 100 * 1024 * 1024);
    assert.equal(config.inboundMediaMaxBytes, 25 * 1024 * 1024);
    assert.equal(config.inboundMediaPerSenderDaily, 20);
    assert.equal(config.inboundMediaPerTenantDaily, 300);
    assert.equal(config.mediaBucket, "wa-media");
  });
});

test("config: WA_MEDIA_INBOUND_ENABLED=true / WA_MEDIA_OUTBOUND_ENABLED=true are read correctly, independently of each other", () => {
  withEnv({ WA_MEDIA_INBOUND_ENABLED: "true" }, () => {
    const config = loadConfig();
    assert.equal(config.mediaInboundEnabled, true);
    assert.equal(config.mediaOutboundEnabled, false, "the two switches are independent");
  });
  withEnv({ WA_MEDIA_OUTBOUND_ENABLED: "true" }, () => {
    const config = loadConfig();
    assert.equal(config.mediaOutboundEnabled, true);
    assert.equal(config.mediaInboundEnabled, false);
  });
});

test("config: WA_MEDIA_INBOUND_ENABLED with an unrecognised value refuses to boot rather than guessing", () => {
  withEnv({ WA_MEDIA_INBOUND_ENABLED: "yes" }, () => {
    assert.throws(() => loadConfig(), /WA_MEDIA_INBOUND_ENABLED must be exactly "true" or "false"/);
  });
  withEnv({ WA_MEDIA_OUTBOUND_ENABLED: "1" }, () => {
    assert.throws(() => loadConfig(), /WA_MEDIA_OUTBOUND_ENABLED must be exactly "true" or "false"/);
  });
});

test("config: WA_MEDIA_INBOUND_ENABLED is case-insensitive for the two accepted values", () => {
  withEnv({ WA_MEDIA_INBOUND_ENABLED: "TRUE" }, () => {
    assert.equal(loadConfig().mediaInboundEnabled, true);
  });
  withEnv({ WA_MEDIA_INBOUND_ENABLED: "False" }, () => {
    assert.equal(loadConfig().mediaInboundEnabled, false);
  });
});

test("config: numeric media overrides are read (image/video/audio/document caps, inbound cap, abuse caps, fetch timeout, bucket name)", () => {
  withEnv(
    {
      WA_MEDIA_FETCH_TIMEOUT_MS: "9000",
      WA_MEDIA_MAX_IMAGE_BYTES: "1000",
      WA_MEDIA_MAX_AUDIO_BYTES: "2000",
      WA_MEDIA_MAX_VIDEO_BYTES: "3000",
      WA_MEDIA_MAX_DOCUMENT_BYTES: "4000",
      WA_INBOUND_MEDIA_MAX_BYTES: "5000",
      WA_INBOUND_MEDIA_PER_SENDER_DAILY: "7",
      WA_INBOUND_MEDIA_PER_TENANT_DAILY: "70",
      WA_MEDIA_BUCKET: "custom-bucket",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.mediaFetchTimeoutMs, 9000);
      assert.equal(config.mediaMaxImageBytes, 1000);
      assert.equal(config.mediaMaxAudioBytes, 2000);
      assert.equal(config.mediaMaxVideoBytes, 3000);
      assert.equal(config.mediaMaxDocumentBytes, 4000);
      assert.equal(config.inboundMediaMaxBytes, 5000);
      assert.equal(config.inboundMediaPerSenderDaily, 7);
      assert.equal(config.inboundMediaPerTenantDaily, 70);
      assert.equal(config.mediaBucket, "custom-bucket");
    }
  );
});

// ---------------------------------------------------------------------------
// Ratchet-desync fix (src/pending-writes.ts, src/sessions.ts's
// `shutdownOneSession`) — WA_SHUTDOWN_FLUSH_TIMEOUT_MS. Default 5000ms; boot
// refuses anything below 500 (near-zero silently defeats the fix — see
// loadConfig's floor check) or at/above 6000 (needs margin under src/main.ts's
// 10s hard stop for the lease-release round trip after flush, which is
// CORRELATED with a timed-out flush since both are slow exactly when
// Supabase is slow).
// ---------------------------------------------------------------------------

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS unset — defaults to 5000", () => {
  withEnv({}, () => {
    assert.equal(loadConfig().shutdownFlushTimeoutMs, 5_000);
  });
});

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS — a valid override under the ceiling is read correctly", () => {
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "3000" }, () => {
    assert.equal(loadConfig().shutdownFlushTimeoutMs, 3_000);
  });
});

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS — a non-numeric value refuses to boot", () => {
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "soon" }, () => {
    assert.throws(() => loadConfig(), /WA_SHUTDOWN_FLUSH_TIMEOUT_MS must be a non-negative integer/);
  });
});

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS — 0 refuses to boot (would silently disable the whole fix, not just boot with a tiny budget)", () => {
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "0" }, () => {
    assert.throws(() => loadConfig(), /WA_SHUTDOWN_FLUSH_TIMEOUT_MS \(0\) must be at least 500ms/);
  });
});

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS — below the 500ms floor refuses to boot", () => {
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "499" }, () => {
    assert.throws(() => loadConfig(), /WA_SHUTDOWN_FLUSH_TIMEOUT_MS \(499\) must be at least 500ms/);
  });
});

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS — exactly the 500ms floor boots fine", () => {
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "500" }, () => {
    assert.equal(loadConfig().shutdownFlushTimeoutMs, 500);
  });
});

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS — at or over the 6000ms ceiling refuses to boot, with an explanatory message", () => {
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "6000" }, () => {
    assert.throws(() => loadConfig(), /WA_SHUTDOWN_FLUSH_TIMEOUT_MS \(6000\) must be under 6000ms/);
  });
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "9999" }, () => {
    assert.throws(() => loadConfig(), /must be under 6000ms/);
  });
});

test("config: WA_SHUTDOWN_FLUSH_TIMEOUT_MS — just under the ceiling boots fine", () => {
  withEnv({ WA_SHUTDOWN_FLUSH_TIMEOUT_MS: "5999" }, () => {
    assert.equal(loadConfig().shutdownFlushTimeoutMs, 5_999);
  });
});

// ---------------------------------------------------------------------------
// Session lease heartbeat/TTL (src/lock.ts) — defaults were 30000/90000
// until the incident where a dead container's leases sat held for the FULL
// 90s TTL, per session, because SIGTERM never got a chance to run at all
// (see src/main.ts's `wireGracefulShutdown`). 10000/30000 keeps the same
// 3x safety ratio (a holder is declared dead only after missing 3
// consecutive beats) while cutting the worst-case takeover stall to a third
// — see src/config.ts's `lockTtlMs` JSDoc for the full writeup.
// ---------------------------------------------------------------------------

test("config: WA_LOCK_HEARTBEAT_MS / WA_LOCK_TTL_MS unset — default to 10000/30000 (not the pre-incident 30000/90000)", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.lockHeartbeatMs, 10_000);
    assert.equal(config.lockTtlMs, 30_000);
  });
});

test("config: WA_LOCK_HEARTBEAT_MS / WA_LOCK_TTL_MS — valid overrides are read correctly", () => {
  withEnv({ WA_LOCK_HEARTBEAT_MS: "5000", WA_LOCK_TTL_MS: "20000" }, () => {
    const config = loadConfig();
    assert.equal(config.lockHeartbeatMs, 5_000);
    assert.equal(config.lockTtlMs, 20_000);
  });
});

test("config: WA_LOCK_TTL_MS <= WA_LOCK_HEARTBEAT_MS refuses to boot — the ratio guard survives the new defaults unchanged", () => {
  withEnv({ WA_LOCK_HEARTBEAT_MS: "10000", WA_LOCK_TTL_MS: "10000" }, () => {
    assert.throws(() => loadConfig(), /WA_LOCK_TTL_MS \(10000\) must exceed WA_LOCK_HEARTBEAT_MS \(10000\)/);
  });
  withEnv({ WA_LOCK_HEARTBEAT_MS: "10000", WA_LOCK_TTL_MS: "9999" }, () => {
    assert.throws(() => loadConfig(), /must exceed WA_LOCK_HEARTBEAT_MS/);
  });
});

test("config: WA_LOCK_TTL_MS just above WA_LOCK_HEARTBEAT_MS boots fine — the guard is a strict inequality, not a minimum gap", () => {
  withEnv({ WA_LOCK_HEARTBEAT_MS: "10000", WA_LOCK_TTL_MS: "10001" }, () => {
    const config = loadConfig();
    assert.equal(config.lockHeartbeatMs, 10_000);
    assert.equal(config.lockTtlMs, 10_001);
  });
});

test("config: WA_VOICE_TRANSCODE_ENABLED defaults to false, reads true, and refuses anything but true/false", () => {
  withEnv({}, () => {
    assert.equal(loadConfig().voiceTranscodeEnabled, false);
  });
  withEnv({ WA_VOICE_TRANSCODE_ENABLED: "true" }, () => {
    assert.equal(loadConfig().voiceTranscodeEnabled, true);
  });
  withEnv({ WA_VOICE_TRANSCODE_ENABLED: "yes" }, () => {
    assert.throws(() => loadConfig(), /WA_VOICE_TRANSCODE_ENABLED must be exactly "true" or "false"/);
  });
});

test("config: group limits default to 3 creates and 50 direct adds a day, and read overrides", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.groupCreateDaily, 3);
    assert.equal(config.groupAddDaily, 50);
  });
  withEnv({ WA_GROUP_CREATE_DAILY: "1", WA_GROUP_ADD_DAILY: "10" }, () => {
    const config = loadConfig();
    assert.equal(config.groupCreateDaily, 1);
    assert.equal(config.groupAddDaily, 10);
  });
});
