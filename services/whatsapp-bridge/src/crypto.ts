/**
 * Credential encryption (hard rule 1) — the reason a Supabase breach alone
 * cannot hijack a client's WhatsApp.
 *
 * WHAT IS ENCRYPTED: every Baileys credential the bridge persists — the
 * `creds` blob on whatsapp_sessions.creds_enc and every SignalKeyStore value
 * on whatsapp_session_keys.value_enc (see src/auth-state.ts). A Baileys auth
 * state is a linked-device credential: whoever holds the PLAINTEXT can read
 * and send that client's WhatsApp. The plaintext therefore exists only in
 * this process's memory; the database holds ciphertext.
 *
 * THE SCHEME — AES-256-GCM via node:crypto, chosen deliberately:
 *   - AUTHENTICATED encryption: GCM's tag means a Supabase-side tamper
 *     (bit-flipped ciphertext, hand-edited row) fails decryption loudly
 *     instead of yielding garbage creds that Baileys then half-accepts.
 *     Plain AES-CBC would not give us that.
 *   - AAD BINDING: the coach id + storage location are fed in as GCM
 *     additional authenticated data, so a ciphertext is only valid at the
 *     exact row it was written to. Even an attacker with Supabase WRITE
 *     access cannot copy coach A's creds_enc onto coach B's row (a
 *     cross-coach session graft) — decryption fails because the AAD differs.
 *   - Native `node:crypto`: no third-party crypto dependency to audit or
 *     supply-chain-attack; libsodium/AES-SIV would add a dep for no gain at
 *     this threat model.
 *   - Random 96-bit IV per encryption (the GCM-standard size), generated
 *     from crypto.randomBytes. Key reuse across records is safe because the
 *     IV is unique per ciphertext; at bridge volumes (thousands of writes a
 *     day, not billions) random-IV collision risk is negligible.
 *
 * KEY MANAGEMENT: the 32-byte key lives ONLY in the bridge's Railway env
 * (`WA_CREDS_KEY`) — not in Supabase, not in Vercel, not in the repo.
 * ROTATION: set `WA_CREDS_KEY` to the new key and `WA_CREDS_KEY_PREVIOUS` to
 * the old one; the bridge decrypts with whichever the envelope's key id
 * names, and re-encrypts under the ACTIVE key on every write — Baileys
 * rewrites creds/keys constantly during normal operation, so rows migrate to
 * the new key organically within hours of running. Once no envelope still
 * says `k0` (README.md shows the SQL to check), remove the previous key.
 * KEY LOSS is recoverable-by-humans: wipe the affected rows and have each
 * client re-scan a QR — annoying, never dangerous.
 *
 * ENVELOPE FORMAT (versioned so a future scheme change can coexist):
 *   v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * keyId is a FINGERPRINT of the key that wrote the envelope (first 8 hex
 * chars of SHA-256 over the key bytes) — it identifies the KEY, not a slot.
 * A slot label ('active'/'previous') would silently point old envelopes at
 * the NEW key after a rotation swaps the slots; a fingerprint stays glued to
 * the key that actually encrypted the row, whatever env slot it sits in
 * today. 8 hex chars is an identifier, not a secret: SHA-256 is one-way and
 * a 32-bit prefix of it reveals nothing usable about 256 bits of key.
 *
 * NEVER LOGGED: nothing in this module logs plaintext, ciphertext, or key
 * bytes; decrypt failures throw a fixed-string error that names the row
 * location (safe) and nothing else.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_BYTES = 12; // GCM standard 96-bit IV.
const VERSION = "v1";

/** Envelope key id — a short one-way fingerprint of the key bytes (see file header). Exported for the README's rotation-progress SQL. */
export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export interface CredsCipher {
  encrypt(plaintext: string, aad: string): string;
  decrypt(envelope: string, aad: string): string;
}

/**
 * Builds the cipher from the active (and optional previous) key. `aad` at
 * both call sites is `whatsappCredsAad(...)`/`whatsappKeyAad(...)` below —
 * the row-binding described in the file header.
 */
export function createCredsCipher(activeKey: Buffer, previousKey: Buffer | null): CredsCipher {
  const activeKeyId = keyFingerprint(activeKey);
  const keys = new Map<string, Buffer>([[activeKeyId, activeKey]]);
  if (previousKey) keys.set(keyFingerprint(previousKey), previousKey);

  return {
    encrypt(plaintext: string, aad: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", activeKey, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, activeKeyId, b64url(iv), b64url(tag), b64url(ciphertext)].join(".");
    },

    decrypt(envelope: string, aad: string): string {
      const parts = envelope.split(".");
      if (parts.length !== 5 || parts[0] !== VERSION) {
        throw new Error("[crypto] unrecognised credential envelope format");
      }
      const [, keyId, ivB64, tagB64, ctB64] = parts;
      const key = keys.get(keyId);
      if (!key) {
        throw new Error(`[crypto] envelope was written by key '${keyId}', which is not configured (rotation finished too early? see README.md "Key rotation")`);
      }
      const decipher = createDecipheriv("aes-256-gcm", key, fromB64url(ivB64));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(fromB64url(tagB64));
      // Throws on tag mismatch (tamper, wrong key, or wrong AAD/row) — the
      // caller treats that as "credentials unusable", never as empty creds.
      return Buffer.concat([decipher.update(fromB64url(ctB64)), decipher.final()]).toString("utf8");
    },
  };
}

/** AAD for whatsapp_sessions.creds_enc — binds the blob to its coach row. */
export function whatsappCredsAad(coachId: string): string {
  return `whatsapp_sessions.creds_enc:${coachId}`;
}

/** AAD for whatsapp_session_keys.value_enc — binds each Signal key to its exact (coach, category, id) row. */
export function whatsappKeyAad(coachId: string, category: string, keyId: string): string {
  return `whatsapp_session_keys.value_enc:${coachId}:${category}:${keyId}`;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
