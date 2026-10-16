/**
 * Best-effort in-process rate limiting for the per-client connect-link
 * feature's two public, unauthenticated-until-proven surfaces
 * (docs/GHL-PROVIDER-CLIENT-MIGRATION.md): `POST /api/connect/session` (the
 * token-exchange endpoint) AND `/connect/[token]` itself (adversarial review
 * lens 5, finding 7a — MINOR, fixed; see below). Mirrors
 * `src/lib/signup-throttle.ts`'s pattern and posture almost exactly; read
 * that file's own header first, this one restates only what differs.
 *
 * WHAT THIS IS AND IS NOT — same as `signup-throttle.ts`'s own framing. This
 * is a cheap first line, not the real one: state lives in a module-level Map,
 * per-serverless-instance, evaporating on cold start. THE REAL SECURITY
 * BOUNDARY IS THE HMAC SIGNATURE `verifyConnectLinkToken` checks
 * (src/lib/ghl-connect-link.ts) — an attacker spraying guesses across many
 * instances routes around this Map entirely, and that is fine, because
 * guessing a valid 32-byte-signed token by brute force is not a realistically
 * reachable attack regardless of how many guesses this limiter lets through.
 * What this layer actually buys: a single leaked/guessed-adjacent token being
 * hammered from one source is slowed down before it burns unnecessary HMAC
 * verify + database re-read work on every attempt, and the endpoint degrades
 * to a human "wait a minute" instead of quietly absorbing an unbounded loop.
 *
 * `x-forwarded-for` IS SPOOFABLE — stated plainly, not glossed over.
 * `clientIpFromHeaders` (src/lib/signup-throttle.ts) trusts a header any
 * client can set to anything, so a determined attacker can trivially mint a
 * fresh IP per request and walk straight past this limiter's per-IP buckets.
 * That is exactly why the HMAC signature, not this Map, is the real boundary
 * (previous paragraph) — this module buys convenience-cost throttling against
 * ORDINARY hammering, not a guarantee against a spoofing-capable attacker.
 *
 * PER-(IP, TOKEN) — adversarial review lens 5, finding 7b (MINOR, fixed).
 * This used to be per-IP ONLY, on the reasoning that rate-limiting by the
 * token's own value would mean logging/keying on a bearer credential. That
 * reasoning held for a single-client deployment but broke down for THIS
 * feature's real usage pattern: Charlie tests/sends 11-15 DIFFERENT clients'
 * links from the SAME office IP, and a shared IP-only bucket meant testing
 * link #1 through #7 could exhaust the whole window's budget for links #8
 * through #15 too, from an IP that never did anything wrong — the exact
 * false-positive this limiter must never cause. Keying by `(ip, token)`
 * instead gives EVERY link its own budget regardless of how many OTHER links
 * share its IP, which is what actually matches the threat model: the thing
 * worth bounding is hammering attempts against ONE captured/guessed token
 * from one source, not aggregate traffic from a legitimate office network.
 * The token itself is never logged or persisted anywhere by this — it only
 * ever exists as one half of an in-memory Map key that evaporates with the
 * process, same exposure as the IP half already had.
 *
 * APPLIED BEFORE ANY HMAC WORK — `checkConnectSessionThrottle` runs before
 * `verifyConnectLinkToken` is ever called on either surface. For
 * `POST /api/connect/session` specifically it runs AFTER the body is parsed
 * far enough to read the token string out (a plain `JSON.parse` and a
 * `typeof` check — no cryptography) but BEFORE that string is ever HMAC
 * verified — seed `decideConnectSession`'s own header
 * (src/app/api/connect/session/logic.ts) for why "before any HMAC work" and
 * "keyed by token" both being true requires that specific ordering. For
 * `/connect/[token]` the token is a route param, trivially available before
 * ANY work at all, so no such ordering trade exists there.
 */

/** Sliding window — same 15 minutes as `signup-throttle.ts`, same reasoning: long enough to blunt a burst, short enough that a genuine client fumbling their own link isn't locked out all evening. */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Attempts per (IP, token) pair per window. Higher than `signup-throttle.ts`'s
 * `IP_LIMIT` of 5 — deliberately: this endpoint is hit by ORDINARY,
 * EXPECTED, repeated polling-adjacent traffic from a single real client
 * opening `/connect/[token]` (the page's own session-mint call, plus a
 * transparent re-mint on any 401 from a WhatsApp route — mirrors
 * `CrmEmbedClient.tsx`'s identical retry shape), not just a one-shot form
 * submit, PLUS the page route itself now sharing this same limiter (finding
 * 7a above) — every page reload while linking is in progress is a second
 * hit against the SAME budget. 30 (raised from 20 — adversarial review lens
 * 5, finding 7b) comfortably covers a legitimate client reloading the page a
 * handful of times AND retrying a stalled QR scan within one window, while
 * still refusing a genuinely automated hammering loop against one token.
 * Raising this is now safe in a way it wasn't before finding 7b's fix: the
 * limit only ever bounds attempts against ONE token from ONE IP, never the
 * aggregate across every link Charlie or a client's staff might touch.
 */
const IP_LIMIT = 30;

/** Hard ceiling on tracked keys — identical overflow behaviour to `signup-throttle.ts`'s own `MAX_TRACKED_KEYS`: on overflow the whole Map is cleared (fails OPEN), the correct direction for a best-effort limiter that must never be the reason a legitimate client's link stops working. Higher than before (was 5000) since keying by `(ip, token)` rather than `ip` alone means the same real traffic now produces more distinct keys — 11-15 clients' links, each visited from a handful of IPs, is nowhere near this ceiling even so. */
const MAX_TRACKED_KEYS = 20000;

/** key -> epoch-ms timestamps of allowed attempts inside the current window. */
const buckets = new Map<string, number[]>();

export interface ConnectThrottleDecision {
  allowed: boolean;
  /** Seconds until the caller may retry. 0 when `allowed`. Rounded UP so the UI never tells someone to retry a moment too early. */
  retryAfterSeconds: number;
}

const ALLOWED: ConnectThrottleDecision = { allowed: true, retryAfterSeconds: 0 };

/** Drop timestamps that have aged out of the window; returns what's left. Identical logic to `signup-throttle.ts`'s `liveHits` — not shared as a common helper, matching that file's own "each limiter owns its state" independence (the two are deliberately uncoupled so a future change to one's window/limits can never silently affect the other). */
function liveHits(key: string, now: number): number[] {
  const hits = buckets.get(key);
  if (!hits) return [];
  const fresh = hits.filter((t) => now - t < WINDOW_MS);
  if (fresh.length === 0) {
    buckets.delete(key);
    return [];
  }
  if (fresh.length !== hits.length) buckets.set(key, fresh);
  return fresh;
}

function retryAfterFor(hits: number[], now: number): number {
  const oldest = hits[0] ?? now;
  return Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
}

/**
 * Check (and, when allowed, consume) one attempt against ONE `/connect/*`
 * surface — `POST /api/connect/session`'s token exchange OR a
 * `/connect/[token]` page load — for this `(ip, token)` pair. Call ONCE per
 * attempt, BEFORE any HMAC verify or database read — see this file's header,
 * "APPLIED BEFORE ANY HMAC WORK".
 *
 * `ip` may be `null` (no usable client-IP header) — a `null` ip is refused
 * OPEN (always allowed), same "degrade to no limiting rather than one shared
 * bucket every visitor fights over" choice `signup-throttle.ts` makes,
 * restated here because this endpoint has no per-email fallback bucket to
 * fall back to the way that one does. `token` may also be `null` (this file's
 * header's "before any HMAC work" note covers the one caller that can reach
 * this before a token is in hand at all — none, currently, but the type
 * allows it defensively) — a `null` token falls back to an IP-only bucket
 * rather than refusing open, so a request that genuinely can't produce a
 * token is still bounded by something. Never throws — a limiter that can 500
 * a route is worse than no limiter.
 */
export function checkConnectSessionThrottle(ip: string | null, token: string | null = null): ConnectThrottleDecision {
  if (!ip) return ALLOWED;
  const now = Date.now();

  if (buckets.size > MAX_TRACKED_KEYS) buckets.clear();

  const key = token ? `ip:${ip}|token:${token}` : `ip:${ip}`;
  const hits = liveHits(key, now);
  if (hits.length >= IP_LIMIT) {
    return { allowed: false, retryAfterSeconds: retryAfterFor(hits, now) };
  }

  buckets.set(key, [...hits, now]);
  return ALLOWED;
}
