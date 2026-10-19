/**
 * src/inbound.ts — the phone-sent mirror ("PHONE-SENT MIRROR" in that file's
 * header): messages the business sends from the connected phone become
 * outbound rows for GHL, while the bridge's own sends, the business's own
 * chat, its group messages and its reactions stay exactly as before. Fabricated
 * WAMessage objects only — no network, no WhatsApp.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  classifyInboundMessage,
  OwnSendRegistry,
  processInboundBatch,
  type InboundDeps,
  type PhoneSentMirror,
  type RecordInboundInput,
} from "../src/inbound.js";

const log = pino({ level: "silent" });
const TENANT = "tenant-ghl";
const CONTACT_JID = "447700900123@s.whatsapp.net";
const CONTACT_PHONE = "+447700900123";
const OWN_PHONE = "+447700900999";
const OWN_PN_JID = "447700900999@s.whatsapp.net";
const CONTACT_LID = "159553891131584@lid";
const GROUP_JID = "120363040000000000@g.us";
const NO_GROUPS: ReadonlySet<string> = new Set();
const EVENTS_OFF = { events: false };
const MIRROR_ON = { events: false, includeFromMe: true };

function phoneSent(overrides: { remoteJid?: string; remoteJidAlt?: string; id?: string; message?: Record<string, unknown> } = {}): WAMessage {
  return {
    key: {
      remoteJid: overrides.remoteJid ?? CONTACT_JID,
      remoteJidAlt: overrides.remoteJidAlt,
      fromMe: true,
      id: overrides.id ?? "PHONE1",
    },
    message: overrides.message ?? { conversation: "on my way, see you at 3" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as unknown as WAMessage;
}

function makeDeps(mirror: PhoneSentMirror | undefined, extra: Partial<InboundDeps> = {}) {
  const recorded: RecordInboundInput[] = [];
  let pokes = 0;
  const deps: InboundDeps = {
    async recordInboundMessage(input) {
      recorded.push(input);
      return { fresh: true };
    },
    schedulePoke() {
      pokes += 1;
    },
    phoneSentMirror: mirror,
    log,
    ...extra,
  };
  return { deps, recorded, pokes: () => pokes };
}

function mirrorWith(ownIds: string[] = [], ownPhone: string | null = OWN_PHONE): PhoneSentMirror {
  const registry = new OwnSendRegistry();
  for (const id of ownIds) registry.add(id);
  return { isOwnSend: (id) => registry.has(id), ownPhone: () => ownPhone };
}

test("classify: fromMe is still dropped by default — the mirror is opt-in", () => {
  assert.deepEqual(classifyInboundMessage(phoneSent(), "notify", NO_GROUPS, EVENTS_OFF), { kind: "dropped", reason: "from_me" });
});

test("classify: with includeFromMe, a phone-sent text becomes an outbound row filed under the CHAT's number", () => {
  const result = classifyInboundMessage(phoneSent(), "notify", NO_GROUPS, MIRROR_ON);
  assert.equal(result.kind, "reply");
  if (result.kind !== "reply") return;
  assert.equal(result.reply.direction, "outbound");
  assert.equal(result.reply.fromPhone, CONTACT_PHONE);
  assert.equal(result.reply.body, "on my way, see you at 3");
});

test("classify: a phone-sent message to a LID chat NEVER trusts remoteJidAlt (Baileys fills it with the business's own number) — it goes to LID resolution", () => {
  const result = classifyInboundMessage(phoneSent({ remoteJid: CONTACT_LID, remoteJidAlt: OWN_PN_JID }), "notify", NO_GROUPS, MIRROR_ON);
  assert.equal(result.kind, "needs_lid_resolution");
  if (result.kind === "needs_lid_resolution") {
    assert.equal(result.lidJid, CONTACT_LID);
    assert.equal(result.pending.direction, "outbound");
  }
});

test("classify: phone-sent media is recorded as outbound but never queued for capture", () => {
  const result = classifyInboundMessage(
    phoneSent({ message: { imageMessage: { mimetype: "image/jpeg", mediaKey: new Uint8Array([1]), directPath: "/x", url: "https://x" } } }),
    "notify",
    NO_GROUPS,
    MIRROR_ON
  );
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.equal(result.reply.messageType, "imageMessage");
    assert.equal(result.reply.body, null);
    assert.equal(result.reply.mediaRef, null);
  }
});

test("classify: phone-sent reactions/edits are still dropped, and an old 'append' (history backfill) is never replayed", () => {
  assert.deepEqual(
    classifyInboundMessage(phoneSent({ message: { reactionMessage: { text: "👍" } } }), "notify", NO_GROUPS, MIRROR_ON),
    { kind: "dropped", reason: "from_me" }
  );
  const old = { ...phoneSent(), messageTimestamp: Math.floor((Date.now() - 30 * 86_400_000) / 1000) } as WAMessage;
  assert.deepEqual(classifyInboundMessage(old, "append", NO_GROUPS, MIRROR_ON), { kind: "dropped", reason: "stale_history_backfill" });
});

test("processInboundBatch: a phone-sent message is recorded with direction 'outbound' and pokes the portal", async () => {
  const fake = makeDeps(mirrorWith());
  await processInboundBatch([phoneSent()], "notify", TENANT, fake.deps);
  assert.equal(fake.recorded.length, 1);
  assert.equal(fake.recorded[0]?.direction, "outbound");
  assert.equal(fake.recorded[0]?.fromPhone, CONTACT_PHONE);
  assert.equal(fake.recorded[0]?.captureMedia, undefined);
  assert.equal(fake.pokes(), 1);
});

test("processInboundBatch: the echo of the bridge's OWN send (e.g. a GHL-originated message) is never mirrored back", async () => {
  const fake = makeDeps(mirrorWith(["BRIDGE1"]));
  await processInboundBatch([phoneSent({ id: "BRIDGE1" })], "append", TENANT, fake.deps);
  assert.equal(fake.recorded.length, 0);
  assert.equal(fake.pokes(), 0);
});

test("processInboundBatch: the business's 'message yourself' chat is never mirrored", async () => {
  const fake = makeDeps(mirrorWith([], OWN_PHONE));
  await processInboundBatch([phoneSent({ remoteJid: OWN_PN_JID })], "notify", TENANT, fake.deps);
  assert.equal(fake.recorded.length, 0);
});

test("processInboundBatch: a LID chat resolves through the LID-mapping store", async () => {
  const fake = makeDeps(mirrorWith(), { resolvePnForLid: async () => "447700900123:0@s.whatsapp.net" });
  await processInboundBatch([phoneSent({ remoteJid: CONTACT_LID, remoteJidAlt: OWN_PN_JID })], "notify", TENANT, fake.deps);
  assert.equal(fake.recorded.length, 1);
  assert.equal(fake.recorded[0]?.fromPhone, CONTACT_PHONE);
});

test("classify: the business's own message in an opted-in group, or its reaction with events on, is still dropped", () => {
  const groupMsg = { ...phoneSent({ remoteJid: GROUP_JID }), key: { remoteJid: GROUP_JID, fromMe: true, id: "G1", participant: OWN_PN_JID } } as unknown as WAMessage;
  assert.deepEqual(classifyInboundMessage(groupMsg, "notify", new Set([GROUP_JID]), MIRROR_ON), { kind: "dropped", reason: "from_me" });
  assert.deepEqual(
    classifyInboundMessage(phoneSent({ message: { reactionMessage: { text: "👍", key: { id: "X" } } } }), "notify", NO_GROUPS, { events: true, includeFromMe: true }),
    { kind: "dropped", reason: "from_me" }
  );
});

test("processInboundBatch: with no mirror wired, a fromMe message is dropped exactly as before", async () => {
  const fake = makeDeps(undefined);
  await processInboundBatch([phoneSent()], "notify", TENANT, fake.deps);
  assert.equal(fake.recorded.length, 0);
});

test("OwnSendRegistry: remembers ids within the TTL, forgets after it, and evicts the oldest past its cap", () => {
  const registry = new OwnSendRegistry(60_000, 2);
  registry.add("A");
  registry.add("B");
  registry.add("C");
  assert.equal(registry.has("A"), false, "evicted past the cap");
  assert.equal(registry.has("B"), true);
  assert.equal(registry.has("C"), true);
  const expired = new OwnSendRegistry(-1);
  expired.add("X");
  assert.equal(expired.has("X"), false);
});
