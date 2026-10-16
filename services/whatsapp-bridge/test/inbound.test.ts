/**
 * src/inbound.ts — the full filter chain (fabricated WAMessage objects, no
 * network, no WhatsApp, matching this package's existing test style), plus
 * the ledger-gate cache and the deps-injected batch processor's dedupe /
 * poke-scheduling behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  classifyInboundMessage,
  processInboundBatch,
  ProspectLedgerCache,
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
  }>;
  message?: Record<string, unknown> | null;
  messageTimestamp?: number;
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

test("classify: a group chat message is dropped", () => {
  const result = classifyInboundMessage(makeMsg({ key: { remoteJid: "120363000000000000@g.us" } }), "notify");
  assert.deepEqual(result, { kind: "dropped", reason: "not_one_to_one" });
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
// ProspectLedgerCache
// ---------------------------------------------------------------------------

test("ProspectLedgerCache: a positive result is cached forever (one lookup for many checks)", async () => {
  const cache = new ProspectLedgerCache();
  let calls = 0;
  const lookup = async () => {
    calls += 1;
    return true;
  };
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), true);
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), true);
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), true);
  assert.equal(calls, 1);
});

// Adversarial-review fix (lens 2, finding 5) — without `markSent`, a
// prospect who DMs cold moments before the portal's own send would have
// their very next reply swallowed by a stale cached negative for the rest
// of the TTL window, even though the send just made them genuinely eligible.
test("ProspectLedgerCache: markSent seeds a positive entry immediately, overriding a cached negative before its TTL would otherwise expire", async () => {
  const cache = new ProspectLedgerCache(10_000); // long TTL — would still be "negative" without the fix
  let calls = 0;
  const lookup = async () => {
    calls += 1;
    return false;
  };
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), false); // cold DM, cached negative
  assert.equal(calls, 1);

  cache.markSent(COACH_A, PROSPECT_PHONE); // the portal's own sequence just messaged this number

  // No further DB lookup needed — the cache already knows this number is
  // now eligible, well within what would otherwise still be the negative's TTL.
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), true);
  assert.equal(calls, 1);
});

test("ProspectLedgerCache: markSent is scoped per coach, like every other entry", async () => {
  const cache = new ProspectLedgerCache();
  cache.markSent("coach-yes", PROSPECT_PHONE);
  const lookup = async (coachId: string) => coachId === "coach-yes";
  assert.equal(await cache.check("coach-yes", PROSPECT_PHONE, lookup), true);
  assert.equal(await cache.check("coach-no", PROSPECT_PHONE, lookup), false);
});

test("ProspectLedgerCache: a negative result is cached only within its TTL, then re-checked", async () => {
  const cache = new ProspectLedgerCache(20); // 20ms TTL
  let calls = 0;
  let answer = false;
  const lookup = async () => {
    calls += 1;
    return answer;
  };
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), false);
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), false); // still within TTL — no second lookup.
  assert.equal(calls, 1);
  answer = true;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await cache.check(COACH_A, PROSPECT_PHONE, lookup), true); // TTL expired — re-checked, now eligible.
  assert.equal(calls, 2);
});

test("ProspectLedgerCache: different coaches for the same phone are scoped independently", async () => {
  const cache = new ProspectLedgerCache();
  const calls: string[] = [];
  const lookup = async (coachId: string) => {
    calls.push(coachId);
    return coachId === "coach-yes";
  };
  assert.equal(await cache.check("coach-yes", PROSPECT_PHONE, lookup), true);
  assert.equal(await cache.check("coach-no", PROSPECT_PHONE, lookup), false);
  assert.deepEqual(calls, ["coach-yes", "coach-no"]);
});

// ---------------------------------------------------------------------------
// processInboundBatch — deps-injected, no real store/HTTP.
// ---------------------------------------------------------------------------

interface FakeStore {
  wasProspectSentCalls: Array<[string, string]>;
  recordCalls: RecordInboundInput[];
  pokeCalls: number;
  seen: Set<string>;
  wasProspectSentAnswer: boolean;
  deps: InboundDeps;
}

function makeFakeStore(): FakeStore {
  const fake: FakeStore = {
    wasProspectSentCalls: [],
    recordCalls: [],
    pokeCalls: 0,
    seen: new Set(),
    wasProspectSentAnswer: true,
    deps: null as unknown as InboundDeps,
  };
  fake.deps = {
    async wasProspectSent(coachId, phone) {
      fake.wasProspectSentCalls.push([coachId, phone]);
      return fake.wasProspectSentAnswer;
    },
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
    // GHL custom conversation provider, Phase 3 — every EXISTING test in
    // this suite exercises the coach path, which must stay byte-identical
    // (plan's test 13 — a regression pin). `false` here reproduces exactly
    // that: `processInboundBatch`'s `deps.bypassLedgerGate ? true : await
    // cache.check(...)` branch takes the SAME `cache.check(...)` path this
    // whole suite was written against.
    bypassLedgerGate: false,
    log,
  };
  return fake;
}

test("processInboundBatch: a survivor is recorded and pokes the portal exactly once", async () => {
  const fake = makeFakeStore();
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg()], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.recordCalls.length, 1);
  assert.equal(fake.recordCalls[0]?.fromPhone, PROSPECT_PHONE);
  assert.equal(fake.pokeCalls, 1);
});

test("processInboundBatch: the ledger gate drops a sender the portal never messaged — no record, no poke", async () => {
  const fake = makeFakeStore();
  fake.wasProspectSentAnswer = false;
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg()], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.wasProspectSentCalls.length, 1);
  assert.equal(fake.recordCalls.length, 0);
  assert.equal(fake.pokeCalls, 0);
});

test("processInboundBatch: DUPLICATE DELIVERY — the same wa_message_id redelivered (e.g. Baileys reconnect resync) is recorded but never poked a second time", async () => {
  const fake = makeFakeStore();
  const cache = new ProspectLedgerCache();
  const msg = makeMsg({ key: { id: "DUP1" } });

  await processInboundBatch([msg], "notify", COACH_A, cache, fake.deps);
  await processInboundBatch([msg], "notify", COACH_A, cache, fake.deps); // redelivered

  assert.equal(fake.recordCalls.length, 2, "store is asked to record both times — dedupe is the DB's job, not skipped client-side");
  assert.equal(fake.pokeCalls, 1, "the second (duplicate) delivery must not trigger a second poke");
});

test("processInboundBatch: a filtered-out message (fromMe) never reaches the store at all", async () => {
  const fake = makeFakeStore();
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg({ key: { fromMe: true } })], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.wasProspectSentCalls.length, 0);
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
  const cache = new ProspectLedgerCache();
  await processInboundBatch(
    [makeMsg({ key: { id: "BOOM" } }), makeMsg({ key: { id: "OK1" } })],
    "notify",
    COACH_A,
    cache,
    fake.deps
  );
  assert.equal(fake.recordCalls.length, 1);
  assert.equal(fake.recordCalls[0]?.waMessageId, "OK1");
});

// ---------------------------------------------------------------------------
// GHL custom conversation provider, Phase 3 (docs/GHL-PROVIDER-PLAN.md,
// decision D4) — the ledger-gate bypass for `kind = 'ghl_location'` sessions.
// `sessions.ts`'s `openSocket` wiring is what actually derives
// `bypassLedgerGate` from `Session.tenantKind`; these tests exercise
// `processInboundBatch`/`classifyInboundMessage` directly, exactly like
// every other test in this file, with the flag passed in explicitly.
// ---------------------------------------------------------------------------

test("processInboundBatch: bypassLedgerGate true — wasProspectSent is NEVER invoked, a cold sender's message is still stored, and the portal is still poked", async () => {
  const fake = makeFakeStore();
  fake.deps = {
    ...fake.deps,
    bypassLedgerGate: true,
    // Throws if called at all — the strongest possible assertion that the
    // ledger-gate lookup is skipped entirely under the bypass, not merely
    // answered `true` by a permissive fake.
    wasProspectSent() {
      throw new Error("wasProspectSent must not be called when bypassLedgerGate is true");
    },
  };
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg()], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.recordCalls.length, 1, "a cold sender (never on the send ledger) must still be recorded under the bypass");
  assert.equal(fake.recordCalls[0]?.fromPhone, PROSPECT_PHONE);
  assert.equal(fake.pokeCalls, 1);
});

test("processInboundBatch: bypassLedgerGate false — behaviour is BYTE-IDENTICAL to the existing (default) suite above — a regression pin, not a new behaviour", async () => {
  // Deliberately re-runs the exact scenario the very first
  // `processInboundBatch` test above already covers (a survivor is recorded
  // and pokes exactly once), with `bypassLedgerGate: false` passed
  // EXPLICITLY rather than relying on `makeFakeStore`'s own default — this
  // is what pins "false takes the same cache.check(...) path every other
  // test in this file already exercises" as an intentional contract, not an
  // accident of a fake's default value.
  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, bypassLedgerGate: false };
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg()], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.wasProspectSentCalls.length, 1, "the ledger gate must still be consulted when bypassLedgerGate is false");
  assert.equal(fake.recordCalls.length, 1);
  assert.equal(fake.pokeCalls, 1);

  // And the negative case: a cold sender is STILL dropped when the bypass is off.
  const fakeCold = makeFakeStore();
  fakeCold.wasProspectSentAnswer = false;
  fakeCold.deps = { ...fakeCold.deps, bypassLedgerGate: false };
  const cache2 = new ProspectLedgerCache();
  await processInboundBatch([makeMsg({ key: { id: "COLD1" } })], "notify", COACH_A, cache2, fakeCold.deps);
  assert.equal(fakeCold.recordCalls.length, 0, "a cold sender must still be dropped when bypassLedgerGate is false");
  assert.equal(fakeCold.pokeCalls, 0);
});

test("processInboundBatch: the bypass skips EXACTLY the ledger-gate step — the rest of the filter chain (fromMe/group/reaction/stale-append) still applies identically under bypassLedgerGate: true", async () => {
  const cache = new ProspectLedgerCache();
  const monthOldSeconds = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

  const scenarios: { label: string; msg: WAMessage; batchType: "notify" | "append" }[] = [
    { label: "fromMe", msg: makeMsg({ key: { fromMe: true } }), batchType: "notify" },
    { label: "group JID", msg: makeMsg({ key: { remoteJid: "120363000000000000@g.us" } }), batchType: "notify" },
    { label: "reaction", msg: makeMsg({ message: { reactionMessage: { text: "👍", key: { id: "MSG0" } } } }), batchType: "notify" },
    { label: "stale 'append' (history backfill)", msg: makeMsg({ messageTimestamp: monthOldSeconds }), batchType: "append" },
  ];

  for (const { label, msg, batchType } of scenarios) {
    const fake = makeFakeStore();
    fake.deps = {
      ...fake.deps,
      bypassLedgerGate: true,
      wasProspectSent() {
        throw new Error(`wasProspectSent must not be called for ${label} — this message should be dropped before the ledger gate is ever reached`);
      },
    };
    await processInboundBatch([msg], batchType, COACH_A, cache, fake.deps);
    assert.equal(fake.recordCalls.length, 0, `${label} must still be dropped under the bypass`);
    assert.equal(fake.pokeCalls, 0, `${label} must not poke the portal under the bypass`);
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
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID } })], "notify", COACH_A, cache, fake.deps);
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
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID } })], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.recordCalls.length, 1);
  assert.equal(fake.recordCalls[0]?.fromPhone, "+447700900999");
  assert.equal(fake.pokeCalls, 1);
});

test("processInboundBatch: LID 1:1, no alt, resolver returns null -> dropped unmappable_sender", async () => {
  const fake = makeFakeStore();
  fake.deps = { ...fake.deps, async resolvePnForLid() { return null; } };
  const cache = new ProspectLedgerCache();
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID } })], "notify", COACH_A, cache, fake.deps);
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
  const cache = new ProspectLedgerCache();
  const okMsg = makeMsg({ key: { id: "OK1" } }); // ordinary PN message — must still be processed.
  await processInboundBatch([makeMsg({ key: { remoteJid: LID_JID, id: "BOOM" } }), okMsg], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.recordCalls.length, 1, "only the PN message was recorded — the throwing LID message never was");
  assert.equal(fake.recordCalls[0]?.waMessageId, "OK1");
  assert.equal(fake.pokeCalls, 1);
});

// Test plan item 10 — `remoteJidUsername` is never consulted for phone
// resolution at all (usernames never map to phones) — a LID message with no
// alt is dropped identically whether or not a username happens to be present.
test("processInboundBatch: remoteJidUsername present with no alt still drops unmappable_sender — usernames never map to phones", async () => {
  const fake = makeFakeStore();
  const cache = new ProspectLedgerCache();
  await processInboundBatch(
    [makeMsg({ key: { remoteJid: LID_JID, remoteJidUsername: "some.business.username" } })],
    "notify",
    COACH_A,
    cache,
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
  const cache = new ProspectLedgerCache();
  const msg = makeMsg({ key: { remoteJid: LID_JID, remoteJidAlt: "987654321098765@lid" } });
  await processInboundBatch([msg], "notify", COACH_A, cache, fake.deps);
  assert.equal(fake.recordCalls.length, 0, "must never reach the store under the fabricated LID-as-phone number");
  assert.equal(fake.pokeCalls, 0);
});
