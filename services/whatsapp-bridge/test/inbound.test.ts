/**
 * src/inbound.ts — the full filter chain (fabricated WAMessage objects, no
 * network, no WhatsApp, matching this package's existing test style), plus
 * the deps-injected batch processor's dedupe / poke-scheduling behaviour.
 * The coach-only ledger gate (and its ProspectLedgerCache tests) were
 * removed with the gate itself — every session is a GHL location.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  classifyInboundMessage,
  renderQuotePrefix,
  processInboundBatch,
  type InboundDeps,
  type RecordInboundInput,
} from "../src/inbound.js";
import { isE164 } from "../src/phone.js";

const log = pino({ level: "silent" });
const COACH_A = "coach-a";
const PROSPECT_JID = "447700900123@s.whatsapp.net";
const PROSPECT_PHONE = "+447700900123";

function makeMsg(overrides: {
  key?: Partial<{
    remoteJid: string;
    fromMe: boolean;
    id: string;
    remoteJidAlt: string;
    addressingMode: string;
    remoteJidUsername: string;
    participant: string;
    participantAlt: string;
  }>;
  message?: Record<string, unknown> | null;
  messageTimestamp?: number;
  pushName?: string;
} = {}): WAMessage {
  return {
    key: {
      remoteJid: PROSPECT_JID,
      fromMe: false,
      id: "MSG1",
      ...overrides.key,
    },
    message: overrides.message === undefined ? { conversation: "hey, got your message" } : overrides.message,
    messageTimestamp: overrides.messageTimestamp ?? 1_800_000_000,
    ...(overrides.pushName !== undefined ? { pushName: overrides.pushName } : {}),
  } as unknown as WAMessage;
}

// ---------------------------------------------------------------------------
// 'append' recency gating — adversarial-review fix (lens 2, finding 1).
// 'append' covers BOTH first-link history backfill (old) AND genuine
// offline-resync (recent) — see file header step 1. `messageTimestamp` here
// is always computed relative to `Date.now()` at test time, never a fixed
// constant, so these assertions hold regardless of when the suite runs.
// ---------------------------------------------------------------------------

test("classify: type 'append' with an OLD messageTimestamp (history backfill) is still dropped", () => {
  const monthOldSeconds = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const result = classifyInboundMessage(makeMsg({ messageTimestamp: monthOldSeconds }), "append");
  assert.deepEqual(result, { kind: "dropped", reason: "stale_history_backfill" });
});

test("classify: type 'append' with NO messageTimestamp at all is treated as unusably old, not as 'now'", () => {
  const result = classifyInboundMessage(makeMsg({ messageTimestamp: 0 }), "append");
  assert.deepEqual(result, { kind: "dropped", reason: "stale_history_backfill" });
});

test("classify: type 'append' with a RECENT messageTimestamp (offline-resync, e.g. a bridge restart) is processed exactly like 'notify'", () => {
  const recentSeconds = Math.floor((Date.now() - 60_000) / 1000); // 1 minute ago
  const result = classifyInboundMessage(makeMsg({ messageTimestamp: recentSeconds }), "append");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.body, "hey, got your message");
});

test("classify: a fromMe / group / etc. filter still applies to a recent 'append' message — recency alone doesn't bypass the rest of the chain", () => {
  const recentSeconds = Math.floor((Date.now() - 60_000) / 1000);
  const result = classifyInboundMessage(makeMsg({ key: { fromMe: true }, messageTimestamp: recentSeconds }), "append");
  assert.deepEqual(result, { kind: "dropped", reason: "from_me" });
});

test("classify: fromMe (coach's own send, or our own bridge echo) is never a reply", () => {
  const result = classifyInboundMessage(makeMsg({ key: { fromMe: true } }), "notify");
  assert.deepEqual(result, { kind: "dropped", reason: "from_me" });
});

test("classify: a group chat message is dropped (no enabled groups passed — the default is fail closed)", () => {
  const result = classifyInboundMessage(makeMsg({ key: { remoteJid: "120363000000000000@g.us" } }), "notify");
  assert.deepEqual(result, { kind: "dropped", reason: "group_not_enabled" });
});

test("classify: the status broadcast is dropped", () => {
  const result = classifyInboundMessage(makeMsg({ key: { remoteJid: "status@broadcast" } }), "notify");
  assert.deepEqual(result, { kind: "dropped", reason: "not_one_to_one" });
});

test("classify: a reaction is dropped (not a reply)", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { reactionMessage: { text: "👍", key: { id: "MSG0" } } } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "edit_reaction_or_system" });
});

test("classify: a protocol message (revoke/app-state) is dropped", () => {
  const result = classifyInboundMessage(makeMsg({ message: { protocolMessage: { type: 0 } } }), "notify");
  assert.deepEqual(result, { kind: "dropped", reason: "edit_reaction_or_system" });
});

test("classify: an edit (editedMessage wrapper) is dropped BEFORE normalisation would unwrap it into fresh-looking text", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { editedMessage: { message: { conversation: "edited text" } } } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "edit_reaction_or_system" });
});

// Adversarial-review fix (lens 2, finding 4) — the raw pre-normalisation
// check only sees TOP-LEVEL keys, so an edit/protocol/reaction message
// hidden one layer inside an `ephemeralMessage` wrapper would previously
// survive step 5, get unwrapped by `normalizeMessageContent`, and masquerade
// as a fresh reply. The post-normalisation re-check closes this.
test("classify: an editedMessage HIDDEN INSIDE an ephemeralMessage wrapper is still dropped, not unwrapped into a fresh reply", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { ephemeralMessage: { message: { editedMessage: { message: { conversation: "edited text" } } } } } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "edit_reaction_or_system" });
});

test("classify: a protocolMessage HIDDEN INSIDE an ephemeralMessage wrapper is still dropped", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { ephemeralMessage: { message: { protocolMessage: { type: 0 } } } } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "edit_reaction_or_system" });
});

test("classify: a stub/system row with no message payload at all is dropped", () => {
  const result = classifyInboundMessage(makeMsg({ message: null }), "notify");
  assert.deepEqual(result, { kind: "dropped", reason: "no_content" });
});

test("classify: a message with no resolvable content type (bare key-distribution row) is dropped", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: "xyz" } } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "no_content" });
});

// A LID with no usable alt is NOT a bare "dropped" outcome from the pure
// classifier any more (Baileys 7.x) — see `ClassifyResult`'s own JSDoc.
// `classifyInboundMessage` hands back `needs_lid_resolution` instead, and
// only `processInboundBatch` (which can `await` `resolvePnForLid`) gets to
// turn that into a final drop. See the "LID resolution" section near the
// end of this file for the process-level coverage (test plan items 3-5/10).
test("classify: a LID-routed sender with no usable alt at all yields needs_lid_resolution, not a bare drop", () => {
  const result = classifyInboundMessage(makeMsg({ key: { remoteJid: "123456789012345@lid" } }), "notify");
  assert.equal(result.kind, "needs_lid_resolution");
  if (result.kind === "needs_lid_resolution") {
    assert.equal(result.lidJid, "123456789012345@lid");
    assert.equal(result.pending.waMessageId, "MSG1");
  }
});

test("classify: a genuine text reply survives the chain, extracted from 'conversation'", () => {
  const result = classifyInboundMessage(makeMsg(), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.equal(result.reply.fromPhone, PROSPECT_PHONE);
    assert.equal(result.reply.body, "hey, got your message");
    assert.equal(result.reply.messageType, "conversation");
    assert.equal(result.reply.waMessageId, "MSG1");
  }
});

test("classify: extendedTextMessage.text is also extracted as the body", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { extendedTextMessage: { text: "quoted reply text" } } }),
    "notify"
  );
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.body, "quoted reply text");
});

test("classify: a non-text reply (e.g. a voice note) is STILL a reply — body null, messageType records what it was", () => {
  const result = classifyInboundMessage(makeMsg({ message: { audioMessage: { ptt: true } } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.equal(result.reply.body, null);
    assert.equal(result.reply.messageType, "audioMessage");
  }
});

// Test plan item 2 — LID 1:1 + a PN-shaped alt resolves directly, no
// resolver needed at all (this is the common case: Baileys itself stamped
// `remoteJidAlt` from the stanza's `sender_pn` attribute — see file header
// step 7. `senderPn` — the 6.7.x field this used to read — no longer exists
// on `WAMessageKey`; `remoteJidAlt` is its 7.x replacement).
test("classify: a LID-routed sender IS mapped when remoteJidAlt carries a phone-JID", () => {
  const result = classifyInboundMessage(
    makeMsg({ key: { remoteJid: "123456789012345@lid", remoteJidAlt: "447700900999@s.whatsapp.net" } }),
    "notify"
  );
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.fromPhone, "+447700900999");
});

// Test plan item 7 — a PN-addressed message's `remoteJidAlt` holds the
// sender's LID (the field is BIDIRECTIONAL — file header step 7), and must
// NEVER be consulted when `remoteJid` is already phone-addressed. If this
// were read, the phone would come out wrong (or the LID's digits, entirely
// the wrong shape of "wrong").
test("classify: a PN 1:1 message carrying an @lid remoteJidAlt still resolves from remoteJid — the alt is ignored entirely", () => {
  const result = classifyInboundMessage(
    makeMsg({ key: { remoteJid: PROSPECT_JID, remoteJidAlt: "999999999999999@lid" } }),
    "notify"
  );
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.fromPhone, PROSPECT_PHONE);
});

// Test plan item 6 — THE TRAP TEST. A WhatsApp LID user string is <=15
// digits, so `+` + a bare LID digit-string PASSES this bridge's own strict
// `isE164` regex — proven directly below, tying this test to
// test/phone-contract.test.ts's own pinned regression case. A LID-routed
// message whose alt is ALSO `@lid` (never `@s.whatsapp.net`) must therefore
// NEVER resolve to that alt's digits as `fromPhone`, no matter how
// phone-shaped they look — only the JID's own server suffix can tell a real
// phone number from a fabricated one built out of a LID.
test("classify: THE TRAP — a LID whose alt is ITSELF @lid never becomes fromPhone, even though its digits alone would pass isE164", () => {
  const lidShapedAlt = "987654321098765"; // 15 digits, starts 1-9 — passes isE164 on its own.
  assert.equal(isE164(`+${lidShapedAlt}`), true, "sanity check: this IS what makes the trap dangerous");

  const result = classifyInboundMessage(
    makeMsg({ key: { remoteJid: "123456789012345@lid", remoteJidAlt: `${lidShapedAlt}@lid` } }),
    "notify"
  );
  // Never "reply" with the LID's digits smuggled in as a phone number —
  // falls through to needs_lid_resolution (see the process-level trap
  // coverage near the end of this file for the full drop).
  assert.notEqual(result.kind, "reply");
  assert.equal(result.kind, "needs_lid_resolution");
});

// Test plan item 8 — an alt that DOES decode to the right server but whose
// user digits don't pass isE164 (too short here) is a FIRM unmappable, not
// "no usable alt" — the wire already gave a definitive (if malformed)
// answer, so there is nothing for a LID-resolver lookup to usefully add.
test("classify: a LID alt that decodes to s.whatsapp.net but fails isE164 is dropped outright, not sent to LID resolution", () => {
  const result = classifyInboundMessage(
    makeMsg({ key: { remoteJid: "123456789012345@lid", remoteJidAlt: "123@s.whatsapp.net" } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "unmappable_sender" });
});

// Test plan item 9 — Baileys 7.x's `normalizeMessageContent` (verified
// against this bridge's installed `lib/Utils/messages.js`) transparently
// unwraps `associatedChildMessage`/`groupStatusMessage`/`groupStatusMessageV2`
// exactly like `ephemeralMessage` — an `editedMessage` hidden inside either
// must be caught at the pre-normalisation, any-depth check (file header step
// 5), same as the existing `ephemeralMessage`-wrapped case above.
test("classify: an editedMessage hidden inside an associatedChildMessage wrapper is still dropped (Baileys 7.x normalizeMessageContent unwraps it)", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { associatedChildMessage: { message: { editedMessage: { message: { conversation: "edited text" } } } } } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "edit_reaction_or_system" });
});

test("classify: an editedMessage hidden inside a groupStatusMessage wrapper is still dropped (Baileys 7.x normalizeMessageContent unwraps it)", () => {
  const result = classifyInboundMessage(
    makeMsg({ message: { groupStatusMessage: { message: { editedMessage: { message: { conversation: "edited text" } } } } } }),
    "notify"
  );
  assert.deepEqual(result, { kind: "dropped", reason: "edit_reaction_or_system" });
});

test("classify: a long body is truncated to 500 chars", () => {
  const long = "x".repeat(900);
  const result = classifyInboundMessage(makeMsg({ message: { conversation: long } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.body?.length, 500);
});

// Adversarial-review fix (lens 1, finding 1) — a NUL byte in the body used to
// make the Supabase INSERT itself fail (Postgres `text` cannot store one),
// which `processInboundBatch`'s catch-all then turned into a silent,
// permanent, un-redelivered loss of the whole reply (auto-stop included).
test("classify: a NUL byte in the body is stripped before it ever reaches the store", () => {
  const nul = String.fromCharCode(0);
  const result = classifyInboundMessage(makeMsg({ message: { conversation: `hello${nul}world` } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.body, "helloworld");
});

// Adversarial-review fix (lens 1, finding 1) — naive `.slice(0, 500)` on a
// UTF-16 string can split an astral character (e.g. an emoji outside the
// BMP) into a lone trailing surrogate, which Postgres's UTF-8 encoder also
// rejects — the same silent-loss failure mode as the NUL byte case. Placing
// a 2-UTF16-unit emoji exactly where the old truncation would have cut it in
// half (UTF-16 index 499) reproduces the exact scenario the review reported.
test("classify: truncation never splits a surrogate pair, even when the cut point lands mid-emoji", () => {
  const emoji = "\u{1F389}"; // single code point, TWO UTF-16 code units
  const long = "x".repeat(499) + emoji + "y".repeat(10); // old `.slice(0,500)` would cut mid-emoji here
  const result = classifyInboundMessage(makeMsg({ message: { conversation: long } }), "notify");
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    const body = result.reply.body!;
    // Code-point-based truncation (matching Postgres's own char_length
    // semantics) keeps the whole emoji as the 500th character rather than
    // splitting it — never ends on a lone leading (high) surrogate.
    assert.equal([...body].length, 500);
    assert.ok(!/[\uD800-\uDBFF]$/.test(body), "must never end on an unpaired leading surrogate");
    assert.ok(body.endsWith(emoji), "the emoji at the cut point must survive intact, not be split");
  }
});

// ---------------------------------------------------------------------------
// processInboundBatch — deps-injected, no real store/HTTP.
// ---------------------------------------------------------------------------

interface FakeStore {
  recordCalls: RecordInboundInput[];
  pokeCalls: number;
  seen: Set<string>;
  deps: InboundDeps;
}

function makeFakeStore(): FakeStore {
  const fake: FakeStore = {
    recordCalls: [],
    pokeCalls: 0,
    seen: new Set(),
    deps: null as unknown as InboundDeps,
  };
  fake.deps = {
    async recordInboundMessage(input) {
      fake.recordCalls.push(input);
      const key = `${input.coachId}:${input.waMessageId}`;
      if (fake.seen.has(key)) return { fresh: false };
      fake.seen.add(key);
      return { fresh: true };
    },
    schedulePoke() {
      fake.pokeCalls += 1;
    },
    log,
  };
  return fake;
}

test("processInboundBatch: a survivor is recorded and pokes the portal exactly once", async () => {
  const fake = makeFakeStore();
  await processInboundBatch([makeMsg()], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 1);
  assert.equal(fake.recordCalls[0]?.fromPhone, PROSPECT_PHONE);
  assert.equal(fake.pokeCalls, 1);
});

test("processInboundBatch: DUPLICATE DELIVERY — the same wa_message_id redelivered (e.g. Baileys reconnect resync) is recorded but never poked a second time", async () => {
  const fake = makeFakeStore();
  const msg = makeMsg({ key: { id: "DUP1" } });

  await processInboundBatch([msg], "notify", COACH_A, fake.deps);
  await processInboundBatch([msg], "notify", COACH_A, fake.deps); // redelivered

  assert.equal(fake.recordCalls.length, 2, "store is asked to record both times — dedupe is the DB's job, not skipped client-side");
  assert.equal(fake.pokeCalls, 1, "the second (duplicate) delivery must not trigger a second poke");
});

test("processInboundBatch: a filtered-out message (fromMe) never reaches the store at all", async () => {
  const fake = makeFakeStore();
  await processInboundBatch([makeMsg({ key: { fromMe: true } })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0);
  assert.equal(fake.pokeCalls, 0);
});

test("processInboundBatch: one throwing message does not stop the rest of the batch", async () => {
  const fake = makeFakeStore();
  fake.deps = {
    ...fake.deps,
    async recordInboundMessage(input) {
      if (input.waMessageId === "BOOM") throw new Error("simulated store failure");
      fake.recordCalls.push(input);
      return { fresh: true };
    },
  };
  await processInboundBatch(
    [makeMsg({ key: { id: "BOOM" } }), makeMsg({ key: { id: "OK1" } })],
    "notify",
    COACH_A,
    fake.deps
  );
  assert.equal(fake.recordCalls.length, 1);
  assert.equal(fake.recordCalls[0]?.waMessageId, "OK1");
});

// ---------------------------------------------------------------------------
// Every session is a GHL location (PortalHub's `kind = 'ghl_location'`
// branch, docs/GHL-PROVIDER-PLAN.md decision D4): cold inbound is the
// product, so there is no ledger gate at all. The coach-only cases (the gate
// dropping a never-messaged sender, the `bypassLedgerGate: false` regression
// pin) were removed with the gate.
// ---------------------------------------------------------------------------

test("processInboundBatch: every session — a cold sender's message is stored and the portal is poked (no ledger gate)", async () => {
  const fake = makeFakeStore();
  await processInboundBatch([makeMsg()], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 1, "a cold sender (never on the send ledger) must be recorded");
  assert.equal(fake.recordCalls[0]?.fromPhone, PROSPECT_PHONE);
  assert.equal(fake.pokeCalls, 1);
});

test("processInboundBatch: every session — the rest of the filter chain (fromMe/group/reaction/stale-append) still applies", async () => {
  const monthOldSeconds = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

  const scenarios: { label: string; msg: WAMessage; batchType: "notify" | "append" }[] = [
    { label: "fromMe", msg: makeMsg({ key: { fromMe: true } }), batchType: "notify" },
    { label: "group JID", msg: makeMsg({ key: { remoteJid: "120363000000000000@g.us" } }), batchType: "notify" },
    { label: "reaction", msg: makeMsg({ message: { reactionMessage: { text: "👍", key: { id: "MSG0" } } } }), batchType: "notify" },
    { label: "stale 'append' (history backfill)", msg: makeMsg({ messageTimestamp: monthOldSeconds }), batchType: "append" },
  ];

  for (const { label, msg, batchType } of scenarios) {
    const fake = makeFakeStore();
    await processInboundBatch([msg], batchType, COACH_A, fake.deps);
    assert.equal(fake.recordCalls.length, 0, `${label} must still be dropped`);
    assert.equal(fake.pokeCalls, 0, `${label} must not poke the portal`);
  }
});

// ---------------------------------------------------------------------------
// LID resolution (Baileys 7.x) — `processInboundBatch`'s handling of
// `classifyInboundMessage`'s `needs_lid_resolution` outcome via
// `InboundDeps.resolvePnForLid`. See src/inbound.ts's file header step 7 and
// `InboundDeps.resolvePnForLid`'s own JSDoc — in production this is
// `sock.signalRepository.lidMapping.getPNForLID` (sessions.ts), store/cache
// only, no network fallback. Test plan items 3, 4, 5, 10.
// ---------------------------------------------------------------------------

const LID_JID = "123456789012345@lid";

test("processInboundBatch: LID 1:1, no alt, no resolver wired at all -> dropped unmappable_sender", async () => {
  const fake = makeFakeStore();
  // deps.resolvePnForLid deliberately omitted — mirrors a session with no
  // live socket to read `signalRepository` off (or a test harness that
  // simply doesn't wire it), which must degrade to today's "unmappable"
  // behaviour, not throw.
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID } })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0);
  assert.equal(fake.pokeCalls, 0);
});

test("processInboundBatch: LID 1:1, no alt, resolver returns a PN JID WITH a :0 device part -> recorded under the bare E.164", async () => {
  const fake = makeFakeStore();
  fake.deps = {
    ...fake.deps,
    // `LIDMappingStore.getPNForLID`'s own reverse-lookup shape always
    // includes a device segment, even device 0 — this bridge must not choke
    // on it (see `pnJidToE164`, which decodes via `jidDecode` rather than a
    // naive string comparison).
    async resolvePnForLid(lidJid) {
      assert.equal(lidJid, LID_JID);
      return "447700900999:0@s.whatsapp.net";
    },
  };
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID } })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 1);
  assert.equal(fake.recordCalls[0]?.fromPhone, "+447700900999");
  assert.equal(fake.pokeCalls, 1);
});

test("processInboundBatch: LID 1:1, no alt, resolver returns null -> dropped unmappable_sender", async () => {
  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, async resolvePnForLid() { return null; } };
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID } })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0);
  assert.equal(fake.pokeCalls, 0);
});

test("processInboundBatch: LID 1:1, no alt, resolver THROWS -> that message is dropped and the rest of the batch still runs", async () => {
  const fake = makeFakeStore();
  fake.deps = {
    ...fake.deps,
    async resolvePnForLid(lidJid) {
      if (lidJid === LID_JID) throw new Error("simulated store failure");
      return null;
    },
  };
  const okMsg = makeMsg({ key: { id: "OK1" } }); // ordinary PN message — must still be processed.
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID, id: "BOOM" } }), okMsg], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 1, "only the PN message was recorded — the throwing LID message never was");
  assert.equal(fake.recordCalls[0]?.waMessageId, "OK1");
  assert.equal(fake.pokeCalls, 1);
});

// Test plan item 10 — `remoteJidUsername` is never consulted for phone
// resolution at all (usernames never map to phones) — a LID message with no
// alt is dropped identically whether or not a username happens to be present.
test("processInboundBatch: remoteJidUsername present with no alt still drops unmappable_sender — usernames never map to phones", async () => {
  const fake = makeFakeStore();
  await processInboundBatch(
    [makeMsg({ key: { remoteJid: LID_JID, remoteJidUsername: "some.business.username" } })],
    "notify",
    COACH_A,
    fake.deps
  );
  assert.equal(fake.recordCalls.length, 0);
  assert.equal(fake.pokeCalls, 0);
});

// Test plan item 6, continued — THE TRAP, followed all the way through
// `processInboundBatch` with no resolver wired: proves the 15-digit LID
// alt can NEVER end up as `fromPhone` in the actual recorded row, not just
// at the pure-classifier level (see the classify-level trap test above).
test("processInboundBatch: THE TRAP, end to end — a LID whose alt is itself @lid is never recorded under the alt's digits", async () => {
  const fake = makeFakeStore();
  const msg = makeMsg({ key: { remoteJid: LID_JID, remoteJidAlt: "987654321098765@lid" } });
  await processInboundBatch([msg], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0, "must never reach the store under the fabricated LID-as-phone number");
  assert.equal(fake.pokeCalls, 0);
});

// ---------------------------------------------------------------------------
// Opt-in WhatsApp groups (docs/superpowers/specs/2026-10-17-whatsapp-groups-
// design.md). A group JID passes step 3 only when it is in the session's
// enabled set; the sender comes from `key.participant`/`participantAlt`
// through the same `resolveSenderE164` rules a 1:1 sender uses.
// ---------------------------------------------------------------------------

const GROUP_JID = "120363418570879210@g.us";
const MEMBER_JID = "447700900555@s.whatsapp.net";
const MEMBER_PHONE = "+447700900555";

function groupMsg(overrides: Parameters<typeof makeMsg>[0] = {}): WAMessage {
  return makeMsg({
    ...overrides,
    key: { remoteJid: GROUP_JID, participant: MEMBER_JID, ...overrides.key },
    pushName: overrides.pushName ?? "Sam from the gym",
  });
}

test("groups: a message from a group NOT in the enabled set is dropped group_not_enabled and never reaches the store", async () => {
  const other = new Set(["120363000000000001@g.us"]);
  assert.deepEqual(classifyInboundMessage(groupMsg(), "notify", other), { kind: "dropped", reason: "group_not_enabled" });

  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, enabledGroups: other };
  await processInboundBatch([groupMsg()], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0, "a disabled group's message must never be written");
  assert.equal(fake.pokeCalls, 0);
});

test("groups: with no enabledGroups in the deps at all (not loaded yet), group traffic is dropped — fail closed", async () => {
  const fake = makeFakeStore();
  await processInboundBatch([groupMsg()], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0);
});

test("groups: an enabled group's message is stored with groupJid, senderName and the member's E.164", async () => {
  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, enabledGroups: new Set([GROUP_JID]) };
  await processInboundBatch([groupMsg()], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 1);
  const row = fake.recordCalls[0]!;
  assert.equal(row.groupJid, GROUP_JID);
  assert.equal(row.senderName, "Sam from the gym");
  assert.equal(row.fromPhone, MEMBER_PHONE);
  assert.equal(row.body, "hey, got your message");
  assert.equal(fake.pokeCalls, 1);
});

test("groups: a 1:1 reply records groupJid and senderName as null", async () => {
  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, enabledGroups: new Set([GROUP_JID]) };
  await processInboundBatch([makeMsg({ pushName: "Prospect" })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls[0]?.groupJid, null);
  assert.equal(fake.recordCalls[0]?.senderName, null);
});

test("groups: senderName is trimmed and cut to 60 characters (code points, never a split emoji)", () => {
  const long = "  " + "😀".repeat(70) + "  ";
  const result = classifyInboundMessage(groupMsg({ pushName: long }), "notify", new Set([GROUP_JID]));
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") {
    assert.equal(Array.from(result.reply.senderName ?? "").length, 60);
    assert.equal(result.reply.senderName, "😀".repeat(60));
  }
});

test("groups: a blank pushName records senderName null", () => {
  const result = classifyInboundMessage(groupMsg({ pushName: "   " }), "notify", new Set([GROUP_JID]));
  assert.equal(result.kind, "reply");
  if (result.kind === "reply") assert.equal(result.reply.senderName, null);
});

test("groups: a LID participant resolves only through a phone-JID participantAlt", () => {
  const enabled = new Set([GROUP_JID]);
  const viaAlt = classifyInboundMessage(groupMsg({ key: { participant: "123456789012345@lid", participantAlt: MEMBER_JID } }), "notify", enabled);
  assert.equal(viaAlt.kind, "reply");
  if (viaAlt.kind === "reply") assert.equal(viaAlt.reply.fromPhone, MEMBER_PHONE);

  // THE TRAP, group edition: an @lid alt is never read as a phone number.
  const trap = classifyInboundMessage(groupMsg({ key: { participant: "123456789012345@lid", participantAlt: "987654321098765@lid" } }), "notify", enabled);
  assert.notEqual(trap.kind, "reply");
});

test("groups: the group's own remoteJidAlt is never used as the sender", () => {
  const result = classifyInboundMessage(
    groupMsg({ key: { participant: undefined as unknown as string, remoteJidAlt: "447700900999@s.whatsapp.net" } }),
    "notify",
    new Set([GROUP_JID])
  );
  assert.deepEqual(result, { kind: "dropped", reason: "unmappable_sender" });
});

test("groups: an unattributable group sender is dropped, never stored", async () => {
  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, enabledGroups: new Set([GROUP_JID]) };
  await processInboundBatch([groupMsg({ key: { participant: "123456789012345@lid" } })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0);
});

test("groups: the rest of the filter chain still applies to an enabled group (fromMe, reactions)", () => {
  const enabled = new Set([GROUP_JID]);
  assert.deepEqual(classifyInboundMessage(groupMsg({ key: { fromMe: true } }), "notify", enabled), { kind: "dropped", reason: "from_me" });
  assert.deepEqual(
    classifyInboundMessage(groupMsg({ message: { reactionMessage: { text: "👍", key: { id: "MSG0" } } } }), "notify", enabled),
    { kind: "dropped", reason: "edit_reaction_or_system" }
  );
});

test("groups: a malformed @g.us JID is dropped even if it were somehow in the set", () => {
  const bad = "abc@g.us";
  assert.deepEqual(classifyInboundMessage(groupMsg({ key: { remoteJid: bad } }), "notify", new Set([bad])), { kind: "dropped", reason: "group_not_enabled" });
});

// ---------------------------------------------------------------------------
// Message events and quoted replies (WA_INBOUND_EVENTS_ENABLED) — the
// message-events plan, Task 2. Every test below passes `{ events: true }`;
// the flag-off behaviour is pinned by every test above (unedited) and by the
// "events flag off" test at the end of this section.
// ---------------------------------------------------------------------------

const EVENTS_ON = { events: true } as const;
const REVOKE = 0; // proto.Message.ProtocolMessage.Type.REVOKE
const MESSAGE_EDIT = 14; // proto.Message.ProtocolMessage.Type.MESSAGE_EDIT

function classifyEvent(message: Record<string, unknown>, key: NonNullable<Parameters<typeof makeMsg>[0]>["key"] = {}) {
  return classifyInboundMessage(makeMsg({ message, key: { id: "EVT1", ...key } }), "notify", undefined, EVENTS_ON);
}

function replyOf(result: ReturnType<typeof classifyInboundMessage>) {
  assert.equal(result.kind, "reply");
  if (result.kind !== "reply") throw new Error("unreachable");
  return result.reply;
}

const reactionPayload = { reactionMessage: { text: "👍", key: { id: "TARGET1", fromMe: false } } };
const revokePayload = { protocolMessage: { type: REVOKE, key: { id: "TARGET2", fromMe: true } } };
const editPayload = { protocolMessage: { type: MESSAGE_EDIT, key: { id: "TARGET3", fromMe: true }, editedMessage: { conversation: "new text" } } };

const WRAPPINGS: Array<[string, (inner: Record<string, unknown>) => Record<string, unknown>]> = [
  ["top level", (inner) => inner],
  ["inside ephemeralMessage", (inner) => ({ ephemeralMessage: { message: inner } })],
  ["inside viewOnceMessageV2", (inner) => ({ viewOnceMessageV2: { message: inner } })],
];

for (const [where, wrap] of WRAPPINGS) {
  test(`events: reaction ${where} is a reaction event`, () => {
    const reply = replyOf(classifyEvent(wrap(reactionPayload)));
    assert.equal(reply.eventKind, "reaction");
    assert.equal(reply.body, "👍");
    assert.equal(reply.targetWaMessageId, "TARGET1");
    assert.equal(reply.targetFromMe, false);
    assert.equal(reply.messageType, "event");
    assert.equal(reply.mediaRef, null);
    assert.equal(reply.waMessageId, "EVT1");
    assert.equal(reply.fromPhone, PROSPECT_PHONE);
  });

  test(`events: revoke ${where} is a delete event`, () => {
    const reply = replyOf(classifyEvent(wrap(revokePayload)));
    assert.equal(reply.eventKind, "delete");
    assert.equal(reply.body, null);
    assert.equal(reply.targetWaMessageId, "TARGET2");
    assert.equal(reply.messageType, "event");
    assert.equal(reply.mediaRef, null);
  });

  test(`events: edit ${where} is an edit event`, () => {
    const reply = replyOf(classifyEvent(wrap(editPayload)));
    assert.equal(reply.eventKind, "edit");
    assert.equal(reply.body, "new text");
    assert.equal(reply.targetWaMessageId, "TARGET3");
    assert.equal(reply.messageType, "event");
    assert.equal(reply.mediaRef, null);
  });
}

test("events: reaction removed (empty text) dropped as reaction_removed", () => {
  assert.deepEqual(classifyEvent({ reactionMessage: { text: "", key: { id: "TARGET1" } } }), { kind: "dropped", reason: "reaction_removed" });
  assert.deepEqual(
    classifyEvent({ ephemeralMessage: { message: { reactionMessage: { text: "", key: { id: "TARGET1" } } } } }),
    { kind: "dropped", reason: "reaction_removed" }
  );
});

test("events: reaction to our message sets targetFromMe true", () => {
  const reply = replyOf(classifyEvent({ reactionMessage: { text: "❤️", key: { id: "OURS1", fromMe: true } } }));
  assert.equal(reply.targetFromMe, true);
  assert.equal(reply.targetWaMessageId, "OURS1");
  assert.equal(reply.body, "❤️");
});

test("events: revoke → delete with target id", () => {
  const reply = replyOf(classifyEvent(revokePayload));
  assert.equal(reply.eventKind, "delete");
  assert.equal(reply.targetWaMessageId, "TARGET2");
  assert.equal(reply.waMessageId, "EVT1", "the event row keeps its own wa_message_id, so the dedupe still holds");
});

test("events: edit via protocolMessage MESSAGE_EDIT", () => {
  const reply = replyOf(classifyEvent(editPayload));
  assert.equal(reply.eventKind, "edit");
  assert.equal(reply.body, "new text");
  assert.equal(reply.targetWaMessageId, "TARGET3");
  assert.equal(reply.targetFromMe, false);
});

test("events: edit via editedMessage wrapper (the wire shape: editedMessage around a MESSAGE_EDIT protocolMessage)", () => {
  const reply = replyOf(classifyEvent({ editedMessage: { message: editPayload } }));
  assert.equal(reply.eventKind, "edit");
  assert.equal(reply.body, "new text");
  assert.equal(reply.targetWaMessageId, "TARGET3");
});

test("events: an editedMessage wrapper inside ephemeralMessage is still an edit, never fresh content", () => {
  const reply = replyOf(classifyEvent({ ephemeralMessage: { message: { editedMessage: { message: editPayload } } } }));
  assert.equal(reply.eventKind, "edit");
  assert.equal(reply.targetWaMessageId, "TARGET3");
});

test("events: a bare editedMessage wrapper with no MESSAGE_EDIT inside names no target, so it stays dropped (never fresh content)", () => {
  assert.deepEqual(
    classifyEvent({ editedMessage: { message: { conversation: "edited text" } } }),
    { kind: "dropped", reason: "edit_reaction_or_system" }
  );
});

test("events: an edit of a caption carries the new caption as the body", () => {
  const reply = replyOf(
    classifyEvent({ protocolMessage: { type: MESSAGE_EDIT, key: { id: "TARGET3" }, editedMessage: { imageMessage: { caption: "new caption" } } } })
  );
  assert.equal(reply.eventKind, "edit");
  assert.equal(reply.body, "new caption");
});

test("events: an edit with no text (caption-only edit with no caption) is dropped as no_content", () => {
  assert.deepEqual(
    classifyEvent({ protocolMessage: { type: MESSAGE_EDIT, key: { id: "TARGET3" }, editedMessage: { imageMessage: {} } } }),
    { kind: "dropped", reason: "no_content" }
  );
});

test("events: the edit body is sanitised (NUL stripped, 500 code points)", () => {
  const nul = String.fromCharCode(0);
  const long = `a${nul}` + "x".repeat(900);
  const reply = replyOf(classifyEvent({ protocolMessage: { type: MESSAGE_EDIT, key: { id: "T" }, editedMessage: { conversation: long } } }));
  assert.equal([...reply.body!].length, 500);
  assert.ok(!reply.body!.includes(nul));
});

test("events: other protocolMessage types stay dropped as edit_reaction_or_system", () => {
  assert.deepEqual(classifyEvent({ protocolMessage: { type: 3 } }), { kind: "dropped", reason: "edit_reaction_or_system" }); // EPHEMERAL_SETTING
  assert.deepEqual(classifyEvent({ protocolMessage: { type: 6 } }), { kind: "dropped", reason: "edit_reaction_or_system" }); // APP_STATE_SYNC_KEY_SHARE
});

test("events: a revoke with no target id is dropped, never stored without a target", () => {
  assert.deepEqual(classifyEvent({ protocolMessage: { type: REVOKE } }), { kind: "dropped", reason: "edit_reaction_or_system" });
});

test("events: poll update still dropped", () => {
  assert.deepEqual(classifyEvent({ pollUpdateMessage: { vote: {} } }), { kind: "dropped", reason: "edit_reaction_or_system" });
  assert.deepEqual(
    classifyEvent({ ephemeralMessage: { message: { pollUpdateMessage: { vote: {} } } } }),
    { kind: "dropped", reason: "edit_reaction_or_system" }
  );
});

test("events: fromMe reaction still dropped", () => {
  assert.deepEqual(classifyEvent(reactionPayload, { fromMe: true }), { kind: "dropped", reason: "from_me" });
  assert.deepEqual(classifyEvent(revokePayload, { fromMe: true }), { kind: "dropped", reason: "from_me" });
  assert.deepEqual(classifyEvent(editPayload, { fromMe: true }), { kind: "dropped", reason: "from_me" });
});

test("events: an enabled group's reaction is an event attributed to the member", () => {
  const result = classifyInboundMessage(
    groupMsg({ message: reactionPayload }),
    "notify",
    new Set([GROUP_JID]),
    EVENTS_ON
  );
  const reply = replyOf(result);
  assert.equal(reply.eventKind, "reaction");
  assert.equal(reply.groupJid, GROUP_JID);
});

test("events: a LID sender's event still goes through LID resolution", () => {
  const result = classifyInboundMessage(
    makeMsg({ key: { remoteJid: "123456789012345@lid" }, message: reactionPayload }),
    "notify",
    undefined,
    EVENTS_ON
  );
  assert.equal(result.kind, "needs_lid_resolution");
  if (result.kind === "needs_lid_resolution") assert.equal(result.pending.eventKind, "reaction");
});

// Quoted replies.

test("quote: renderQuotePrefix for quoted text", () => {
  assert.equal(renderQuotePrefix({ conversation: "are you free tomorrow?" }), '↩ "are you free tomorrow?"');
  assert.equal(renderQuotePrefix({ extendedTextMessage: { text: "see link" } }), '↩ "see link"');
});

test("quote: renderQuotePrefix keeps the first 80 code points of the quoted text", () => {
  const quoted = "😀".repeat(100);
  assert.equal(renderQuotePrefix({ conversation: quoted }), `↩ "${"😀".repeat(80)}"`);
});

test("quote: renderQuotePrefix keeps the prefix on one line", () => {
  assert.equal(renderQuotePrefix({ conversation: "line one\nline two" }), '↩ "line one line two"');
});

test("quote: renderQuotePrefix media placeholders", () => {
  assert.equal(renderQuotePrefix({ imageMessage: {} }), "↩ (photo)");
  assert.equal(renderQuotePrefix({ videoMessage: {} }), "↩ (video)");
  assert.equal(renderQuotePrefix({ audioMessage: { ptt: true } }), "↩ (voice note)");
  assert.equal(renderQuotePrefix({ audioMessage: {} }), "↩ (audio)");
  assert.equal(renderQuotePrefix({ audioMessage: { ptt: false } }), "↩ (audio)");
  assert.equal(renderQuotePrefix({ documentMessage: {} }), "↩ (document)");
  assert.equal(renderQuotePrefix({ stickerMessage: {} }), "↩ (sticker)");
  assert.equal(renderQuotePrefix({ locationMessage: {} }), "↩ (message)");
  assert.equal(renderQuotePrefix({}), "↩ (message)");
});

test("quote: a quoted text reply gets the prefix, a newline, then the reply", () => {
  const reply = replyOf(
    classifyEvent({ extendedTextMessage: { text: "yes I am", contextInfo: { stanzaId: "Q1", quotedMessage: { conversation: "are you free?" } } } })
  );
  assert.equal(reply.body, '↩ "are you free?"\nyes I am');
  assert.equal(reply.messageType, "extendedTextMessage");
  assert.equal(reply.eventKind, undefined);
});

for (const [quoted, prefix] of [
  [{ imageMessage: {} }, "↩ (photo)"],
  [{ videoMessage: {} }, "↩ (video)"],
  [{ audioMessage: { ptt: true } }, "↩ (voice note)"],
  [{ audioMessage: {} }, "↩ (audio)"],
  [{ documentMessage: {} }, "↩ (document)"],
  [{ stickerMessage: {} }, "↩ (sticker)"],
  [{ contactMessage: {} }, "↩ (message)"],
] as const) {
  test(`quote: a text reply to a quoted ${Object.keys(quoted)[0]} renders ${prefix}`, () => {
    const reply = replyOf(classifyEvent({ extendedTextMessage: { text: "nice", contextInfo: { quotedMessage: quoted } } }));
    assert.equal(reply.body, `${prefix}\nnice`);
  });
}

test("quote: a quoted reply inside ephemeralMessage still gets the prefix", () => {
  const reply = replyOf(
    classifyEvent({ ephemeralMessage: { message: { extendedTextMessage: { text: "ok", contextInfo: { quotedMessage: { conversation: "hi" } } } } } })
  );
  assert.equal(reply.body, '↩ "hi"\nok');
});

test("quote: a media reply with no caption keeps body null and its media placeholder", () => {
  const reply = replyOf(
    classifyEvent({ audioMessage: { ptt: true, mediaKey: new Uint8Array([1]), contextInfo: { quotedMessage: { conversation: "call me?" } } } })
  );
  assert.equal(reply.body, null);
  assert.equal(reply.messageType, "audioMessage");
});

test("quote: quote prefix survives truncation", () => {
  const text = "y".repeat(500);
  const reply = replyOf(classifyEvent({ extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: "q".repeat(200) } } } }));
  const prefix = `↩ "${"q".repeat(80)}"\n`;
  assert.equal([...reply.body!].length, 500);
  assert.ok(reply.body!.startsWith(prefix));
  assert.equal(reply.body, prefix + "y".repeat(500 - [...prefix].length));
});

test("quote: truncation of the reply text never splits an emoji", () => {
  const text = "😀".repeat(600);
  const reply = replyOf(classifyEvent({ extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: "hi" } } } }));
  assert.equal([...reply.body!].length, 500);
  assert.ok(!/[\uD800-\uDBFF]$/.test(reply.body!));
});

test("quote: a reply with no quotedMessage is unchanged", () => {
  const reply = replyOf(classifyEvent({ extendedTextMessage: { text: "plain", contextInfo: { stanzaId: "X" } } }));
  assert.equal(reply.body, "plain");
});

// The flag off.

test("events flag off: every event dropped as today, quotes ignored", () => {
  const payloads = [
    reactionPayload,
    revokePayload,
    editPayload,
    { editedMessage: { message: editPayload } },
    { ephemeralMessage: { message: reactionPayload } },
    { viewOnceMessageV2: { message: revokePayload } },
    { reactionMessage: { text: "", key: { id: "T" } } },
  ];
  for (const message of payloads) {
    const msg = makeMsg({ message });
    assert.deepEqual(classifyInboundMessage(msg, "notify"), { kind: "dropped", reason: "edit_reaction_or_system" });
    assert.deepEqual(classifyInboundMessage(msg, "notify", undefined, { events: false }), { kind: "dropped", reason: "edit_reaction_or_system" });
  }
  const quoted = makeMsg({ message: { extendedTextMessage: { text: "yes", contextInfo: { quotedMessage: { conversation: "free?" } } } } });
  const reply = replyOf(classifyInboundMessage(quoted, "notify"));
  assert.equal(reply.body, "yes");
  assert.ok(!("eventKind" in reply) && !("targetWaMessageId" in reply) && !("targetFromMe" in reply));
});

test("processInboundBatch: events flag off (deps.events omitted) records nothing for a reaction", async () => {
  const fake = makeFakeStore();
  await processInboundBatch([makeMsg({ message: reactionPayload })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 0);
  assert.equal(fake.pokeCalls, 0);
});

test("processInboundBatch: events on records an event row with its kind and target, and pokes", async () => {
  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, events: true };
  await processInboundBatch([makeMsg({ key: { id: "EVT9" }, message: reactionPayload })], "notify", COACH_A, fake.deps);
  assert.equal(fake.recordCalls.length, 1);
  const call = fake.recordCalls[0];
  assert.equal(call.eventKind, "reaction");
  assert.equal(call.targetWaMessageId, "TARGET1");
  assert.equal(call.targetFromMe, false);
  assert.equal(call.messageType, "event");
  assert.equal(call.body, "👍");
  assert.equal(call.waMessageId, "EVT9");
  assert.equal(call.captureMedia, false);
  assert.equal(fake.pokeCalls, 1);
});

test("processInboundBatch: an ordinary reply's record call names no event fields, flag on or off", async () => {
  for (const events of [false, true]) {
    const fake = makeFakeStore();
    fake.deps = { ...fake.deps, events };
    await processInboundBatch([makeMsg()], "notify", COACH_A, fake.deps);
    const call = fake.recordCalls[0];
    assert.ok(!("eventKind" in call) && !("targetWaMessageId" in call) && !("targetFromMe" in call));
  }
});

test("LOCKSTEP (SOURCE-LEVEL): inbound processing passes WA_INBOUND_EVENTS_ENABLED through", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
  const upsert = src.slice(src.indexOf('sock.ev.on("messages.upsert"'));
  assert.match(upsert.slice(0, 5000), /events: this\.config\.inboundEventsEnabled/);
});
