/**
 * src/auth-state.ts — the WRITE GATE (`canWrite()`) and its two additions
 * from the ratchet-desync fix: every persist is now handed to a
 * `PendingWrites` tracker (src/pending-writes.ts), and a gated-out write
 * logs a warn instead of silently vanishing (the "tripwire" the file
 * header's WRITE GATE paragraph describes). No Baileys socket, no Supabase
 * — `store` is a fake matching only the methods this module calls (same
 * pattern as test/sessions-poke.test.ts's `makeFakeStore`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { pino } from "pino";
import { BufferJSON } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../src/auth-state.js";
import { PendingWrites } from "../src/pending-writes.js";
import type { BridgeStore } from "../src/store.js";

type SetKeysWrite = { category: string; keyId: string; valueJson: string | null };

function makeFakeStore(overrides: Partial<{
  loadCreds: (coachId: string) => Promise<string | null>;
  getKeys: (coachId: string, type: string, ids: string[]) => Promise<Record<string, string>>;
  setKeys: (coachId: string, writes: SetKeysWrite[]) => Promise<void>;
  saveCreds: (coachId: string, credsJson: string) => Promise<void>;
}> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = {
    loadCreds: overrides.loadCreds ?? (async () => null),
    getKeys: overrides.getKeys ?? (async () => ({})),
    setKeys:
      overrides.setKeys ??
      (async (coachId: string, writes: SetKeysWrite[]) => {
        calls.push({ method: "setKeys", args: [coachId, writes] });
      }),
    saveCreds:
      overrides.saveCreds ??
      (async (coachId: string, credsJson: string) => {
        calls.push({ method: "saveCreds", args: [coachId, credsJson] });
      }),
  } as unknown as BridgeStore;
  return { store, calls };
}

/** A pino destination that accumulates parsed JSON lines, for asserting exact log content (same technique as test/console-guard.test.ts). */
function makeCaptureStream(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const silentLog = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// keys.set
// ---------------------------------------------------------------------------

test("keys.set: canWrite()===true calls store.setKeys with BufferJSON-serialised writes, tracked and visible to flush while in flight", async () => {
  let resolveSetKeys!: () => void;
  const { store, calls } = makeFakeStore({
    setKeys: (coachId, writes) =>
      new Promise<void>((resolve) => {
        calls.push({ method: "setKeys", args: [coachId, writes] });
        resolveSetKeys = resolve;
      }),
  });
  const pending = new PendingWrites();
  const { state } = await useSupabaseAuthState(store, "coach-1", () => true, pending, silentLog);

  const writePromise = state.keys.set({ session: { "fake-session-id": new Uint8Array([1, 2, 3]) } });

  // `set`'s synchronous prefix (build `writes`, call store.setKeys, register
  // with `pending`) all runs before its own first internal `await`, so the
  // tracked write is visible here WITHOUT needing to await `writePromise`
  // first — exactly the property `shutdownOneSession`'s flush depends on.
  assert.equal(pending.size(), 1, "the write must be tracked before store.setKeys even resolves");
  assert.equal(calls.length, 1);
  const [{ args }] = calls;
  const writes = args[1] as SetKeysWrite[];
  assert.equal(writes.length, 1);
  assert.equal(writes[0].category, "session");
  assert.equal(writes[0].keyId, "fake-session-id");
  const revived = JSON.parse(writes[0].valueJson as string, BufferJSON.reviver) as Uint8Array;
  assert.deepEqual(Array.from(revived), [1, 2, 3]);

  resolveSetKeys();
  await writePromise;
  const flushResult = await pending.flush({ timeoutMs: 200, maxPasses: 5, settleGraceMs: 5 });
  assert.equal(flushResult.remaining, 0, "flush must observe the write draining once store.setKeys resolves");
});

test("keys.set: canWrite()===false calls store.setKeys ZERO times and emits exactly one warn with category names + count, no key ids, no values", async () => {
  const { store, calls } = makeFakeStore();
  const pending = new PendingWrites();
  const { stream, lines } = makeCaptureStream();
  const log = pino({ level: "debug" }, stream);
  const { state } = await useSupabaseAuthState(store, "coach-1", () => false, pending, log);

  // A 'session' key id shaped like Baileys' real ones — JID-derived, embeds
  // a phone number. This string must NEVER appear in the log output.
  const fakeKeyId = "447700900123@s.whatsapp.net";
  await state.keys.set({
    session: { [fakeKeyId]: new Uint8Array([9, 9, 9]) },
    "pre-key": { "1": { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
  });

  assert.equal(calls.length, 0, "store.setKeys must never be called when the lease isn't held");
  assert.equal(pending.size(), 0, "nothing gated-out should ever be tracked");

  const entries = lines();
  assert.equal(entries.length, 1, "exactly one warn line, not silent, not more than one");
  const [entry] = entries;
  assert.equal(entry.level, 40, "pino warn level");
  assert.deepEqual([...(entry.categories as string[])].sort(), ["pre-key", "session"]);
  assert.equal(entry.keyCount, 2);

  const raw = JSON.stringify(entry);
  assert.ok(!raw.includes(fakeKeyId), "the JID-derived key id must never appear in the log line");
  assert.ok(!raw.includes("9,9,9") && !raw.includes("[9,9,9]"), "key VALUES must never appear either");
});

test("keys.set: a null value produces a delete-shaped write (valueJson: null)", async () => {
  const { store, calls } = makeFakeStore();
  const pending = new PendingWrites();
  const { state } = await useSupabaseAuthState(store, "coach-1", () => true, pending, silentLog);

  await state.keys.set({ session: { "some-id": null } });

  assert.equal(calls.length, 1);
  const writes = calls[0].args[1] as SetKeysWrite[];
  assert.deepEqual(writes, [{ category: "session", keyId: "some-id", valueJson: null }]);
});

// ---------------------------------------------------------------------------
// saveCreds
// ---------------------------------------------------------------------------

test("saveCreds: canWrite()===true calls store.saveCreds and it is tracked", async () => {
  let resolveSaveCreds!: () => void;
  const { store, calls } = makeFakeStore({
    saveCreds: (coachId, credsJson) =>
      new Promise<void>((resolve) => {
        calls.push({ method: "saveCreds", args: [coachId, credsJson] });
        resolveSaveCreds = resolve;
      }),
  });
  const pending = new PendingWrites();
  const { saveCreds } = await useSupabaseAuthState(store, "coach-1", () => true, pending, silentLog);

  const p = saveCreds();
  assert.equal(pending.size(), 1, "saveCreds must be tracked before store.saveCreds resolves");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "coach-1");

  resolveSaveCreds();
  await p;
  const flushResult = await pending.flush({ timeoutMs: 200, maxPasses: 5, settleGraceMs: 5 });
  assert.equal(flushResult.remaining, 0);
});

test("saveCreds: canWrite()===false calls store.saveCreds ZERO times and emits exactly one warn with { coachId } and a fixed string, no creds content", async () => {
  const { store, calls } = makeFakeStore();
  const pending = new PendingWrites();
  const { stream, lines } = makeCaptureStream();
  const log = pino({ level: "debug" }, stream);
  const { saveCreds } = await useSupabaseAuthState(store, "coach-42", () => false, pending, log);

  await saveCreds();

  assert.equal(calls.length, 0, "store.saveCreds must never be called when the lease isn't held");
  const entries = lines();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.level, 40);
  assert.equal(entry.coachId, "coach-42");
  assert.match(entry.msg as string, /signal key write dropped — lease no longer held/);
});

// ---------------------------------------------------------------------------
// keys.get — reads stay ungated
// ---------------------------------------------------------------------------

test("keys.get: reads are ungated — resolves normally even when canWrite()===false", async () => {
  const encoded = JSON.stringify(new Uint8Array([7, 7, 7]), BufferJSON.replacer);
  const { store } = makeFakeStore({
    getKeys: async (_coachId, _type, ids) => {
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = encoded;
      return out;
    },
  });
  const pending = new PendingWrites();
  const { state } = await useSupabaseAuthState(store, "coach-1", () => false, pending, silentLog);

  const result = await state.keys.get("session", ["some-id"]);
  assert.ok(result["some-id"], "a read must still succeed while the lease is not held");
  assert.deepEqual(Array.from(result["some-id"] as Uint8Array), [7, 7, 7]);
});
