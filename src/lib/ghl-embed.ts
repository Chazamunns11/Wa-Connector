/**
 * GHL Custom Page embed — SSO decryption + short-lived embed tokens
 * (docs/GHL-PROVIDER-PLAN.md follow-on: "GHL sub-account clients have no
 * login to our portal"). This is the only module that speaks GHL's
 * "user context" SSO protocol, CONFIRMED (not guessed) against GHL's own
 * marketplace docs on 4 Aug 2026:
 * https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps/index.html
 *
 *   1. The iframe posts `window.parent.postMessage({ message:
 *      "REQUEST_USER_DATA" }, "*")` to GHL's own frame.
 *   2. GHL replies with `{ message: "REQUEST_USER_DATA_RESPONSE", payload:
 *      <encrypted string> }`.
 *   3. `payload` is decrypted server-side with the marketplace app's Shared
 *      Secret. GHL's own sample code decrypts with
 *      `CryptoJS.AES.decrypt(encrypted, secretString)` — that is OpenSSL's
 *      classic "passphrase" format: base64 of `"Salted__" + 8-byte salt +
 *      ciphertext`, with the AES-256 key and IV derived from the secret via
 *      EVP_BytesToKey using MD5. `decryptGhlSsoPayload` below reimplements
 *      exactly that using Node's own `crypto`, not CryptoJS — see that
 *      function's own JSDoc for why no dependency was added.
 *   4. The decrypted JSON carries `userId`, `companyId`, `role`, `type`,
 *      `userName`, `email`, `isAgencyOwner`, `versionId`, and — ONLY when the
 *      Custom Page was opened inside a SUB-ACCOUNT (never agency context) —
 *      `activeLocation`, the GHL location id.
 *
 * SECURITY IS THE ENTIRE POINT OF THIS FILE. A WhatsApp QR is a device-link
 * grant — whoever scans it can read and send as that business, the same
 * severity as leaking a password (see
 * `src/components/whatsapp/WhatsappConnectionPanel.tsx`'s header for the
 * restated boundary this codebase already holds everywhere else that QR is
 * reachable). The location identity that decides WHICH tenant's QR a given
 * embed session can reach comes from EXACTLY ONE place: `activeLocation`
 * inside this decrypted, GHL-signed payload. It is never taken from a URL
 * query param, a `Referer`/`Origin` header, or anything else the iframe's
 * own JavaScript could hand this server — all of those are trivially
 * spoofable by whoever controls the page making the request, which under
 * GHL's whitelabel model could be any agency, not just FitClosers.
 * `parseGhlUserContext` is the ONE function downstream code is meant to
 * trust for "which location is this" — see its own JSDoc.
 */
import { createDecipheriv, createHash } from "crypto";
import { signKindedState, verifyKindedState } from "@/lib/signed-state";

// ---------------------------------------------------------------------------
// Config gate
// ---------------------------------------------------------------------------

/**
 * `GHL_SSO_SHARED_SECRET` — the marketplace app's Shared Secret, copied from
 * GHL's app settings page. Read STANDALONE here, deliberately NOT folded into
 * `src/lib/ghl.ts`'s all-or-nothing `ghlEnv()` triple (`GHL_CLIENT_ID` +
 * `GHL_CLIENT_SECRET` + `GHL_WEBHOOK_PUBLIC_KEY`) — mirrors how
 * `ghlConversationProviderId()` in that same file is kept standalone, and for
 * the identical reason stated in that function's own JSDoc: folding this into
 * `ghlEnv()` would retroactively 503 the ALREADY-WORKING outbound webhook
 * (Phase 2 — GHL sending a WhatsApp message out through the provider) on any
 * deployment that has the OAuth/webhook trio set but simply hasn't gotten
 * around to pasting in the Shared Secret yet. The embed feature and the
 * outbound provider are two genuinely independent pieces of GHL integration
 * that happen to live in sibling files; neither should be able to take the
 * other down by omission.
 */
export function ghlSsoSharedSecret(): string | null {
  return process.env.GHL_SSO_SHARED_SECRET || null;
}

/**
 * True iff `ONBOARD_STATE_SECRET` itself is set — NOT `getStateSecret()`'s
 * broader "this or CRON_SECRET" check (adversarial review lens 4, finding 1
 * — MAJOR). `mintGhlEmbedToken`/`verifyGhlEmbedToken` are thin wrappers over
 * `signKindedState`/`verifyKindedState` (src/lib/onboarding.ts), which sign
 * under `getStateSecret()` and so WOULD happily fall back to `CRON_SECRET`
 * with `ONBOARD_STATE_SECRET` unset — a state docs/RUNBOOK.md's §3b actually
 * recommends as a valid interim ("falls back to CRON_SECRET... works, set a
 * dedicated value once you're live") for the other four signed-state kinds.
 * It is NOT valid here: an embed token is the ONLY thing standing between one
 * GHL location's WhatsApp QR and another's (this file's header — a QR is a
 * device-link grant, same severity as a password), whereas `CRON_SECRET` is
 * an operational bearer token that gets pasted into `curl` commands in the
 * runbook and travels over the wire on every scheduled cron hit. Anyone
 * holding it — which is a materially larger and more casual set of people
 * than anyone holding a dedicated signing secret — could otherwise call
 * `signKindedState("ghl-embed", { locationId: "<any installed location>" })`
 * themselves and mint a valid embed token for a location they have never
 * touched, no SSO payload, no decrypt, no GHL involvement at all. This gate
 * is checked by `isGhlEmbedConfigured()` below (so the embed simply never
 * switches on without a dedicated secret) AND re-asserted directly inside
 * `mintGhlEmbedToken`/`verifyGhlEmbedToken` themselves, so the embed token
 * signer can never silently inherit `getStateSecret()`'s fallback even if a
 * future caller reaches either function without going through the config
 * gate first.
 */
function hasEmbedStateSecret(): boolean {
  return Boolean(process.env.ONBOARD_STATE_SECRET);
}

/** The single "is this switched on at all?" gate every embed surface checks before rendering or attempting anything — mirrors `isGhlConfigured`/`isWhatsappBridgeConfigured`. Fail-closed: unset means the embed page renders its "not switched on yet" card and never even starts the postMessage handshake. Requires BOTH the SSO decrypt secret AND a dedicated embed-token signing secret — see `hasEmbedStateSecret`'s JSDoc for why the latter may never be `CRON_SECRET` by fallback. */
export function isGhlEmbedConfigured(): boolean {
  return ghlSsoSharedSecret() !== null && hasEmbedStateSecret();
}

// ---------------------------------------------------------------------------
// SSO payload decryption — PURE, mirrors `verifyGhlSignature`'s testable
// shape (src/lib/ghl.ts): the secret is a parameter, never read from env
// inside this function, so a synthetic secret + a locally-encrypted fixture
// can exercise every branch with no live GHL round trip.
// ---------------------------------------------------------------------------

/** OpenSSL's own literal magic-header bytes for its "salted passphrase" container format — the same eight bytes `openssl enc -aes-256-cbc -salt` and CryptoJS's `AES.encrypt(text, passphrase)` both prepend. */
const OPENSSL_SALTED_MAGIC = "Salted__";
const SALT_LENGTH = 8;
/** AES-256-CBC: 32-byte key, 16-byte IV — EVP_BytesToKey(MD5) derives both from the secret + salt in one pass, most-significant bytes first (key, then IV). */
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

/**
 * OpenSSL's legacy EVP_BytesToKey key-derivation function, MD5 variant, one
 * iteration — this is what `openssl enc` (no `-md`/`-iter` flags) and
 * CryptoJS's `AES.encrypt(text, passphraseString)` both use under the hood
 * to turn a plain-text passphrase + salt into a key/IV pair. Not a modern
 * choice (PBKDF2/scrypt would be), but it is GHL's own documented sample
 * code's choice, not this codebase's — reimplemented byte-for-byte rather
 * than approximated, since a KDF that's even slightly off produces a key
 * that LOOKS valid-shaped but decrypts to garbage.
 *
 * Algorithm: repeatedly MD5-hash (previous digest || secret || salt),
 * concatenating digests, until there are enough bytes for the key + IV.
 */
function evpBytesToKeyMd5(secret: Buffer, salt: Buffer, totalLength: number): Buffer {
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(chunks).length < totalLength) {
    const hash = createHash("md5");
    hash.update(previous);
    hash.update(secret);
    hash.update(salt);
    previous = hash.digest();
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, totalLength);
}

/**
 * Decrypt one GHL SSO payload. PURE — `secret` is a parameter, not read from
 * env (see this file's header) — so this is independently unit-testable
 * against a fixture this module's own test suite encrypts locally, with no
 * live GHL payload ever needed.
 *
 * NEVER THROWS. Every failure mode (invalid base64, missing `Salted__`
 * header, truncated ciphertext, a wrong secret producing a PKCS#7 padding
 * error, valid decryption that isn't JSON, or JSON that isn't a plain
 * object) returns `null`. This function's only caller is a public HTTP
 * endpoint (`POST /api/crm/embed/session`) that receives whatever a message
 * event handed it — malformed, truncated, or actively hostile input is the
 * normal case for that boundary, not the exception, so a thrown exception
 * here must never be able to turn into an uncaught 500.
 *
 * NEVER LOGS the secret, the ciphertext, or the decrypted plaintext — the
 * plaintext carries a GHL user's id/email, and the ciphertext is
 * attacker-controlled-shaped input arriving over an unauthenticated route;
 * neither belongs in a log line at any log level, success or failure.
 */
export function decryptGhlSsoPayload(encrypted: string, secret: string): Record<string, unknown> | null {
  try {
    const raw = Buffer.from(encrypted, "base64");
    // A non-base64 string still "decodes" to something under Node's lenient
    // base64 parsing, but a well-formed OpenSSL container is always at least
    // "Salted__" (8) + salt (8) + one AES block (16) = 32 bytes.
    const magicLength = OPENSSL_SALTED_MAGIC.length;
    if (raw.length < magicLength + SALT_LENGTH + 16) return null;
    if (raw.toString("utf8", 0, magicLength) !== OPENSSL_SALTED_MAGIC) return null;

    const salt = raw.subarray(magicLength, magicLength + SALT_LENGTH);
    const ciphertext = raw.subarray(magicLength + SALT_LENGTH);
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null;

    const keyAndIv = evpBytesToKeyMd5(Buffer.from(secret, "utf8"), salt, KEY_LENGTH + IV_LENGTH);
    const key = keyAndIv.subarray(0, KEY_LENGTH);
    const iv = keyAndIv.subarray(KEY_LENGTH, KEY_LENGTH + IV_LENGTH);

    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Wrong secret (bad PKCS#7 padding -> `decipher.final()` throws),
    // truncated/corrupt ciphertext, non-JSON plaintext, or any other failure
    // — all fold into the same "couldn't read this" `null`. The caller has
    // no use for WHICH of those happened, and distinguishing them in a
    // public endpoint's response would just hand an attacker an oracle.
    return null;
  }
}

// ---------------------------------------------------------------------------
// User-context parsing — the ONE function that decides "which location is
// this embed session for". See this file's header for why `activeLocation`
// is the sole source of truth.
// ---------------------------------------------------------------------------

export interface GhlUserContext {
  activeLocation: string;
  userId: string | null;
  companyId: string | null;
  email: string | null;
}

/**
 * Generous upper bound on `activeLocation`'s length (adversarial review lens
 * 4, finding 11 — MINOR: "config hygiene"). Real GHL location ids are ~24
 * characters. This value becomes a DB lookup key (`getGhlAccountByLocationId`)
 * AND rides inside every embed token payload afterwards
 * (`mintGhlEmbedToken`) — nothing downstream ever re-checks its length, so an
 * unbounded string here is an unbounded string in both places. 128 is
 * headroom-generous over 24, not a tight fit — the point is refusing a
 * pathological multi-KB string, not pinning GHL's exact id format (which
 * this app does not otherwise validate and has no business enforcing).
 */
const MAX_ACTIVE_LOCATION_LENGTH = 128;

/**
 * Narrows a decrypted SSO payload to the fields this app actually trusts.
 * Requires `activeLocation` to be a non-empty string no longer than
 * `MAX_ACTIVE_LOCATION_LENGTH` — a payload with no `activeLocation` at all
 * (GHL's own documented shape for AGENCY-level context, i.e. the Custom Page
 * opened outside any sub-account), an empty/non-string one, or one that's
 * absurdly long returns `null`. There is deliberately no "fall back to some
 * other field" here: an agency-context payload proves someone is a GHL user,
 * but proves NOTHING about which sub-account's WhatsApp they may touch, and
 * this embed exists for exactly one job — a sub-account client reaching
 * their own location's QR.
 */
export function parseGhlUserContext(json: unknown): GhlUserContext | null {
  if (typeof json !== "object" || json === null) return null;
  const v = json as Record<string, unknown>;
  const activeLocation = v.activeLocation;
  if (typeof activeLocation !== "string" || activeLocation.length === 0 || activeLocation.length > MAX_ACTIVE_LOCATION_LENGTH) return null;
  const userId = typeof v.userId === "string" ? v.userId : null;
  const companyId = typeof v.companyId === "string" ? v.companyId : null;
  const email = typeof v.email === "string" ? v.email : null;
  return { activeLocation, userId, companyId, email };
}

// ---------------------------------------------------------------------------
// Embed token — a short-lived, server-minted proof that a specific browser
// tab just proved (via the postMessage handshake + decryption above) that
// GHL itself vouches for a specific `activeLocation`. Thin wrappers over
// `signKindedState`/`verifyKindedState`'s `"ghl-embed"` kind
// (src/lib/onboarding.ts) — same HMAC/TTL machinery every other signed-state
// purpose in this codebase already uses, kind-pinned so a `"ghl-install"`
// state (or any other kind) can never be replayed here and vice versa.
// ---------------------------------------------------------------------------

/**
 * 15 minutes — long enough to cover one GHL Custom Page session's worth of
 * connect/poll/logout calls (the panel polls every 2.5s while linking, per
 * `WhatsappConnectionPanel`'s `POLL_INTERVAL_MS`) without needing a refresh
 * mid-attempt in the common case, short enough that a token which somehow
 * leaked out of component state (never persisted anywhere — see
 * `CrmEmbedClient.tsx`'s header) is only ever good for a quarter of an hour.
 * `CrmEmbedClient.tsx` re-runs the handshake and re-mints silently on a 401,
 * so an expiry mid-attempt is invisible to the person on the other end.
 */
export const EMBED_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Mint a fresh embed token for one GHL location — the ONLY payload it
 * carries is the location id GHL's own signed SSO payload just vouched for.
 *
 * ASSERTS `ONBOARD_STATE_SECRET` ITSELF (adversarial review lens 4, finding
 * 1 — MAJOR; see `hasEmbedStateSecret`'s JSDoc above for the full rationale).
 * Throws rather than returning `null`/falling back, because this function's
 * only caller (`POST /api/crm/embed/session`) only ever reaches this line
 * AFTER its own `isGhlEmbedConfigured()` gate has already passed — so
 * reaching here with the secret missing means the gate was skipped
 * somewhere, which is a bug worth a loud failure, not a silent sign under
 * `CRON_SECRET` instead.
 */
export function mintGhlEmbedToken(locationId: string): string {
  if (!hasEmbedStateSecret()) {
    throw new Error(
      "mintGhlEmbedToken called with ONBOARD_STATE_SECRET unset — refusing to sign under getStateSecret()'s " +
        "CRON_SECRET fallback (src/lib/ghl-embed.ts). This should be unreachable: every caller must gate on " +
        "isGhlEmbedConfigured() first."
    );
  }
  return signKindedState("ghl-embed", { locationId }, EMBED_TOKEN_TTL_MS);
}

/**
 * Verify + decode an embed token. `null` on any tamper/format/expiry/wrong-kind
 * failure, or if the decoded payload's `locationId` is missing or not a
 * string — callers (the three embed WhatsApp routes, via
 * `src/app/api/crm/embed/guard.ts`) must treat `null` as 401, never throw.
 *
 * ASSERTS `ONBOARD_STATE_SECRET` ITSELF, same as `mintGhlEmbedToken`
 * (adversarial review lens 4, finding 1 — MAJOR): without this check,
 * `verifyKindedState` would happily verify a token signed under
 * `getStateSecret()`'s `CRON_SECRET` fallback — including one an attacker
 * minted themselves by hand with nothing more than `CRON_SECRET`, no GHL
 * involvement at all. Returns `null` here (not a throw) because, unlike
 * `mintGhlEmbedToken`, this IS reachable from an unauthenticated request
 * with no prior config gate (`authorizeGhlEmbedRequest` calls this directly)
 * — the correct shape for that boundary is "treat as invalid", matching
 * every other failure mode this function already folds into `null`.
 */
export function verifyGhlEmbedToken(token: string): { locationId: string } | null {
  if (!hasEmbedStateSecret()) return null;
  const data = verifyKindedState("ghl-embed", token);
  if (!data) return null;
  const locationId = data.locationId;
  if (typeof locationId !== "string" || locationId.length === 0) return null;
  return { locationId };
}
