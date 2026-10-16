/**
 * Custom Baileys auth state backed by Supabase (encrypted at rest) —
 * the production replacement for `useMultiFileAuthState`, which Baileys'
 * own docs say not to rely on in prod (and which writes PLAINTEXT creds to
 * local disk — a double disqualifier here: Railway containers lose their
 * disk on redeploy, and hard rule 1 forbids plaintext at rest anywhere).
 *
 * INTERFACE IMPLEMENTED (verified against @whiskeysockets/baileys
 * 7.0.0-rc14, lib/Types/Auth.d.ts in the actually-installed package — see
 * the package README's "Baileys version" note):
 *   AuthenticationState = { creds: AuthenticationCreds, keys: SignalKeyStore }
 *   SignalKeyStore.get(type, ids) -> { [id]: value } for TEN categories, not
 *   six — 7.x's LID/multi-device work added four:
 *     'pre-key' | 'session' | 'sender-key' | 'sender-key-memory' |
 *     'app-state-sync-key' | 'app-state-sync-version' (the original six)
 *     'lid-mapping' | 'device-list' | 'identity-key' | 'tctoken'   (new in 7.x)
 *   SignalKeyStore.set(data)      -> batch upsert/delete (null = delete)
 * plus a `saveCreds` callback wired to the socket's 'creds.update' event —
 * exactly the shape `useMultiFileAuthState` returns, so `makeWASocket` usage
 * is identical.
 *
 * THE FOUR NEW CATEGORIES, THEIR SHAPES, AND WHY NONE OF THEM NEEDED A CODE
 * CHANGE HERE (`SignalDataTypeMap`, lib/Types/Auth.d.ts):
 *   'lid-mapping'   — plain `string` (a bare user-id half of a LID<->PN
 *                     pair, keyed both forwards and as a `${lidUser}_reverse`
 *                     row — see `LIDMappingStore.storeLIDPNMappings`,
 *                     lib/Signal/lid-mapping.js). Read at send time by
 *                     `sessions.ts`'s `resolvePnForLid` wiring.
 *   'device-list'   — `string[]` (the multi-device fan-out list `migrateSession`
 *                     walks when copying a coach's PN sessions to their LID
 *                     address — lib/Signal/libsignal.js).
 *   'identity-key'  — `Uint8Array` (a Signal identity key, same shape family
 *                     as 'session'/'sender-key').
 *   'tctoken'       — `{ token: Buffer, timestamp?: string, senderTimestamp?:
 *                     number }` — a small object with ONE Buffer field, not a
 *                     bare Buffer.
 * Every one of these round-trips through the EXACT SAME generic
 * `JSON.stringify(value, BufferJSON.replacer)` / `JSON.parse(json,
 * BufferJSON.reviver)` path below as `'session'`/`'sender-key'` always have
 * — `BufferJSON`'s codec is shape-agnostic (it walks whatever object graph
 * it's given and round-trips any `Buffer`/`Uint8Array` it finds, nested or
 * not), so a plain string, a string array, a bare byte array, and an object
 * with one nested Buffer field all serialise and revive correctly with ZERO
 * category-specific code. `'app-state-sync-key'` remains the sole exception
 * needing the explicit `proto.Message.AppStateSyncKeyData.fromObject` revival
 * below — it is the only category Baileys requires as a TYPED protobuf
 * object rather than a plain deserialised one.
 *
 * SERIALISATION mirrors useMultiFileAuthState precisely: values go through
 * JSON with `BufferJSON.replacer`/`reviver` (Baileys' own Buffer-safe
 * codec), and 'app-state-sync-key' values are revived through
 * `proto.Message.AppStateSyncKeyData.fromObject` on read — the one category
 * Baileys requires as a typed protobuf object, not a plain object.
 *
 * PRIVACY NOTE, the new categories (added here on the 7.x bump — see
 * README's "Baileys version" section for the incident that motivated it):
 * `'lid-mapping'` key ids, like `'session'` key ids, ARE PHONE NUMBERS — a
 * `'lid-mapping'` id is the PN user-id half of a stored LID<->PN pair (see
 * above), not an opaque identifier. Checked directly against this bridge's
 * installed source, the same is true of `'device-list'` (keyed by a bare PN
 * user string — `lib/Signal/libsignal.js`'s `migrateSession`) and
 * `'identity-key'` (keyed by a full JID — `lib/Signal/libsignal.js`'s
 * identity get/set); `'tctoken'` is ALSO JID-keyed for every entry except
 * one fixed sentinel row (`__index`, `lib/Utils/tc-token-utils.js`) used only
 * to track which JIDs have an entry. The drop-log's "never log keyId" rule
 * (below) therefore now protects `'session'` PLUS THREE more categories
 * whose ids are unconditionally phone/JID-derived (`'lid-mapping'`,
 * `'device-list'`, `'identity-key'`), with `'tctoken'` a near-total fourth —
 * category NAMES and counts remain the only shapes ever safe to log for ANY
 * category, every one of them, no exceptions.
 *
 * WRITE GATE (split-brain half 2): every persist checks `canWrite()` — the
 * session's lease-held flag (src/lock.ts). An instance that lost its lease
 * keeps decrypting what it already has in memory but persists NOTHING, so a
 * stale instance can never clobber the rows the new lease-holder is now
 * writing. Reads are ungated: they're harmless and the socket needs them to
 * finish any in-flight decryption during teardown.
 *
 * THE GATE'S OTHER HALF — FLUSH (src/pending-writes.ts): the gate alone only
 * makes writes CORRECT (a stale instance can never clobber the new owner's
 * rows); it says nothing about writes that are allowed through but then get
 * killed mid-persist by a shutdown that doesn't wait for them — which is
 * exactly the production incident this pairing fixes (see
 * src/pending-writes.ts's file header). So every persist below also hands
 * its promise to `pending.track(...)`, which makes writes COMPLETE: an
 * in-flight `setKeys`/`saveCreds` from the moment the lease was still held
 * is never abandoned, because `shutdownOneSession` (src/sessions.ts) awaits
 * `pending.flush()` before it ever calls `lock.release()`. The GATE is
 * correctness, the FLUSH is completeness, and the DROP LOG below (fired the
 * moment `canWrite()` is false) is the tripwire BETWEEN them — a write
 * gated out only ever belongs in one of two expected windows (the tail end
 * of a graceful release, once flush has already claimed everything that was
 * in flight at release time, or a genuine lease loss to a rival instance);
 * seeing this log fire OUTSIDE those windows (e.g. steadily mid-session) is
 * the signal that something upstream is calling into a session after it
 * should already be gone.
 */
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import type { BridgeStore } from "./store.js";
import type { PendingWrites } from "./pending-writes.js";

// Baileys 7.0.0-rc14 is pure ESM (package.json's "type": "module", verified
// against this bridge's installed lib/index.js) with a REAL default export
// (`export default makeWASocket`) alongside its named exports — plain named
// imports, no interop shim needed. 6.7.x shipped CJS, which under this
// project's `moduleResolution: "NodeNext"` used to need `esModuleInterop`'s
// default-import + destructure dance (`import baileys, { BufferJSON, ... }`,
// then `void baileys;` to silence the unused-import warning on the part only
// there for interop) to resolve named imports reliably from a CJS module.
// That workaround is now dead weight, not just stale prose — removed
// alongside this comment rather than left importing something nothing here
// uses.

export interface SupabaseAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export async function useSupabaseAuthState(
  store: BridgeStore,
  coachId: string,
  /** The session lease gate — src/lock.ts's `isHeld`. */
  canWrite: () => boolean,
  /** Every persist below is tracked here so a graceful shutdown can wait for it — see file header's "GATE'S OTHER HALF" paragraph and src/pending-writes.ts. Lives on the Session, not per-call (see sessions.ts's `Session.pendingWrites` JSDoc for why). */
  pending: PendingWrites,
  /** Only caller is `openSocket` (src/sessions.ts), passing a `{ coachId, module: "auth-state" }` child. Used solely for the drop-log warns below — never for anything credential-adjacent. */
  log: Logger
): Promise<SupabaseAuthState> {
  const existing = await store.loadCreds(coachId);
  const creds: AuthenticationCreds = existing
    ? (JSON.parse(existing, BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const raw = await store.getKeys(coachId, type, ids);
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const json = raw[id];
          if (json === undefined) continue;
          let value = JSON.parse(json, BufferJSON.reviver);
          if (type === "app-state-sync-key" && value) {
            // Mirrors useMultiFileAuthState — this one category must be a
            // typed protobuf object or app-state sync silently breaks.
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          out[id] = value as SignalDataTypeMap[T];
        }
        return out;
      },

      async set(data) {
        const writes: { category: string; keyId: string; valueJson: string | null }[] = [];
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const entries = data[category];
          if (!entries) continue;
          for (const keyId of Object.keys(entries)) {
            const value = entries[keyId];
            writes.push({
              category,
              keyId,
              valueJson: value ? JSON.stringify(value, BufferJSON.replacer) : null,
            });
          }
        }
        if (!canWrite()) {
          // Lease lost — the new holder owns these rows now (see file
          // header's WRITE GATE / "GATE'S OTHER HALF" paragraphs). Logged,
          // not silent, so this is the tripwire described there rather than
          // an invisible drop. NEVER log `keyId`: 'session' key ids are
          // JID-derived and embed the remote party's phone number, and (as
          // of the 7.x bump) so do 'lid-mapping', 'device-list',
          // 'identity-key', and almost every 'tctoken' id too — see file
          // header's PRIVACY NOTE paragraph. Category NAMES (TEN of them
          // now, not a fixed six-value enum — see file header's INTERFACE
          // IMPLEMENTED note) and a raw count are the only shapes safe to
          // put in a log line here, for any category.
          const categories = [...new Set(writes.map((w) => w.category))];
          log.warn(
            { coachId, categories, keyCount: writes.length },
            "signal key write dropped — lease no longer held (expected only after graceful release or lease loss; if this appears mid-session, investigate)"
          );
          return;
        }
        if (writes.length > 0) await pending.track(store.setKeys(coachId, writes));
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      if (!canWrite()) {
        // Same lease gate and tripwire rationale as keys.set above — no
        // per-key detail here at all, creds are a single row per coach.
        log.warn(
          { coachId },
          "signal key write dropped — lease no longer held (expected only after graceful release or lease loss; if this appears mid-session, investigate)"
        );
        return;
      }
      await pending.track(store.saveCreds(coachId, JSON.stringify(state.creds, BufferJSON.replacer)));
    },
  };
}
