/**
 * Conversation replies (src/sessions.ts `isConversationReply`, src/pacing.ts
 * file header). A 1:1 send to someone who messaged the number within
 * WA_REPLY_WINDOW_HOURS costs no cap units, is never refused at the cap,
 * and is dispatched ahead of queued cold sends. Drives the REAL
 * SessionManager accept + drain path against a fake session, socket and
 * store (the test/groups.test.ts pattern), plus the store queries behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import { SessionManager, nextQueueIndex } from "../src/sessions.js";
import { SessionPacer } from "../src/pacing.js";
import { PendingWrites } from "../src/pending-writes.js";
import { OwnSendRegistry } from "../src/inbound.js";
import { BridgeStore, type MessageRecord } from "../src/store.js";
import type { BridgeConfig } from "../src/config.js";

const silentLog = pino({ level: "silent" });
const TENANT = "11111111-1111-4111-8111-111111111111";
const LEAD = "+447700900123";
const COLD_A = "+447700900200";
const COLD_B = "+447700900201";
const GROUP_JID = "120363418570879210@g.us";
const HOUR = 60 * 60 * 1000;

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    credsKey: Buffer.alloc(32),
    credsKeyPrevious: null,
    bridgeSecret: "bridge-secret-0123456789-0123456789-0123456789",
    port: 8080,
    sendMinGapMs: 0,
    sendJitterMs: 0,
    dailyCap: 2,
    replyWindowHours: 24,
    replyMinGapMs: 0,
    replyJitterMs: 0,
    warmupEnabled: false,
    typingIndicatorEnabled: false,
    typingMaxMs: 0,
    lockHeartbeatMs: 60_000,
    lockTtlMs: 180_000,
    shutdownFlushTimeoutMs: 500,
    maxQrReconnectAttempts: 5,
    logLevel: "silent",
    portalInboundUrl: null,
    waInboundPokeSecret: null,
    portalOutboundUrl: null,
    mediaOutboundEnabled: false,
    mediaInboundEnabled: false,
    ...overrides,
  } as BridgeConfig;
}

function makeRecord(idempotencyKey: string, target: { toPhone: string } | { groupJid: string }): MessageRecord {
  return {
    id: `id-${idempotencyKey}`,
    coachId: TENANT,
    idempotencyKey,
    toPhone: "toPhone" in target ? target.toPhone : null,
    groupJid: "groupJid" in target ? target.groupJid : null,
    status: "accepted",
    waMessageId: null,
    error: null,
    dispatchAttempted: false,
    createdAt: "2026-11-02T10:00:00.000Z",
    sentAt: null,
    kind: "text",
  };
}

function makeHarness(opts: {
  sentToday?: number;
  leaseHeld?: boolean;
  /** Phones that messaged the number recently. */
  recent?: string[];
  lookupThrows?: boolean;
  config?: Partial<BridgeConfig>;
  pacer?: SessionPacer;
}) {
  const lookups: { phone: string; windowMs: number }[] = [];
  const sentTo: string[] = [];
  const store = {
    getMessage: async () => null,
    acceptMessage: async (_coachId: string, key: string, target: { toPhone: string } | { groupJid: string }) => ({ record: makeRecord(key, target), fresh: true }),
    hasInboundFromPhone: async (_tenant: string, phone: string, _now: number, windowMs: number) => {
      lookups.push({ phone, windowMs });
      if (opts.lookupThrows) throw Object.assign(new Error("boom"), { code: "57014" });
      return (opts.recent ?? []).includes(phone);
    },
    claimMessage: async () => true,
    markMessageFailed: async () => {},
    markMessageSent: async () => {},
    markMessageNotOnWhatsapp: async () => {},
    listEnabledGroupJids: async () => [],
  } as unknown as BridgeStore;
  const sock = {
    user: { id: "447700900001:12@s.whatsapp.net" },
    groupMetadata: async (jid: string) => ({ id: jid, subject: "x", participants: [{ id: "447700900001@s.whatsapp.net" }] }),
    onWhatsApp: async (phone: string) => [{ exists: true, jid: `${phone.slice(1)}@s.whatsapp.net` }],
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid: string) => {
      sentTo.push(jid);
      return { key: { id: `WAID${sentTo.length}` } };
    },
  };
  const manager = new SessionManager(store, makeConfig(opts.config), silentLog);
  let leaseHeld = opts.leaseHeld ?? true;
  const session = {
    coachId: TENANT,
    sock,
    lock: { isHeld: () => leaseHeld, confirmHeld: async () => true, release: async () => {} },
    pacer: opts.pacer ?? new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 2 }, opts.sentToday ?? 0, Date.now, () => 0),
    status: "connected",
    phoneNumber: "+447700900001",
    qr: null,
    qrAt: 0,
    queue: [] as { units: number; reply: boolean }[],
    draining: false,
    reconnectAttempts: 0,
    stopping: false,
    pendingWrites: new PendingWrites(),
    ownSends: new OwnSendRegistry(),
    mediaAbuseGate: null,
    recentlyCreated: new Map<string, number>(),
    enabledGroups: new Set([GROUP_JID]),
    enabledGroupsLoad: 0,
    inFlightUnits: 0,
  };
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(TENANT, session);
  return { manager, session, lookups, sentTo, setLeaseHeld: (held: boolean) => (leaseHeld = held) };
}

const jidOf = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;

test("reply: accepted at the daily cap, reserves 0 units, looks back WA_REPLY_WINDOW_HOURS", async () => {
  const h = makeHarness({ sentToday: 2, leaseHeld: false, recent: [LEAD] });
  assert.equal((await h.manager.send(TENANT, LEAD, "hi", "r-1")).kind, "accepted");
  assert.deepEqual(h.session.queue.map((q) => [q.units, q.reply]), [[0, true]]);
  assert.deepEqual(h.lookups, [{ phone: LEAD, windowMs: 24 * HOUR }]);
  // A cold send is still refused at the cap.
  assert.deepEqual(await h.manager.send(TENANT, COLD_A, "hi", "c-1"), { kind: "daily_cap_reached", cap: 2 });
});

test("reply: queued replies never use up the budget a cold send needs", async () => {
  const h = makeHarness({ sentToday: 1, leaseHeld: false, recent: [LEAD] });
  for (let i = 0; i < 5; i++) assert.equal((await h.manager.send(TENANT, LEAD, "hi", `r-${i}`)).kind, "accepted");
  assert.equal((await h.manager.send(TENANT, COLD_A, "hi", "c-1")).kind, "accepted"); // 1 + 0 + 1 = 2
  assert.deepEqual(await h.manager.send(TENANT, COLD_B, "hi", "c-2"), { kind: "daily_cap_reached", cap: 2 });
});

test("reply: dispatched replies are recorded at 0 units — sentToday only counts cold sends", async () => {
  const h = makeHarness({ recent: [LEAD] });
  await h.manager.send(TENANT, LEAD, "a", "r-1");
  await h.manager.send(TENANT, COLD_A, "b", "c-1");
  await h.manager.send(TENANT, LEAD, "c", "r-2");
  for (let i = 0; i < 50 && h.sentTo.length < 3; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.sentTo.length, 3);
  assert.equal(h.session.pacer.sentTodayCount(), 1);
});

test("reply: a failed reply-window lookup counts as cold (the safe side)", async () => {
  const h = makeHarness({ sentToday: 2, leaseHeld: false, recent: [LEAD], lookupThrows: true });
  assert.deepEqual(await h.manager.send(TENANT, LEAD, "hi", "r-1"), { kind: "daily_cap_reached", cap: 2 });
});

test("reply: WA_REPLY_WINDOW_HOURS=0 turns the exemption off — no lookup, capped as before", async () => {
  const h = makeHarness({ sentToday: 2, leaseHeld: false, recent: [LEAD], config: { replyWindowHours: 0 } });
  assert.deepEqual(await h.manager.send(TENANT, LEAD, "hi", "r-1"), { kind: "daily_cap_reached", cap: 2 });
  assert.equal(h.lookups.length, 0);
});

test("reply: a group send is never a reply — no lookup, 5 units as before", async () => {
  const h = makeHarness({ leaseHeld: false, config: { dailyCap: 10 }, pacer: new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 10 }, 0, Date.now, () => 0) });
  assert.equal((await h.manager.sendToGroup(TENANT, GROUP_JID, "hi", "g-1")).kind, "accepted");
  assert.deepEqual(h.session.queue.map((q) => [q.units, q.reply]), [[5, false]]);
  assert.equal(h.lookups.length, 0);
});

test("drain: a reply queued while the worker sleeps out a cold gap goes next, at the reply gap", async () => {
  // Cold gap 60s, reply gap 0: without the wake the reply would wait a minute behind COLD_B.
  const pacer = new SessionPacer({ minGapMs: 60_000, jitterMs: 0, dailyCap: 10, replyMinGapMs: 0, replyJitterMs: 0 }, 0, Date.now, () => 0);
  const h = makeHarness({ recent: [LEAD], pacer, config: { dailyCap: 10 } });
  await h.manager.send(TENANT, COLD_A, "a", "c-1");
  for (let i = 0; i < 50 && h.sentTo.length < 1; i++) await new Promise((r) => setImmediate(r));
  await h.manager.send(TENANT, COLD_B, "b", "c-2"); // waits 60s
  await h.manager.send(TENANT, LEAD, "c", "r-1");
  for (let i = 0; i < 50 && h.sentTo.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sentTo, [jidOf(COLD_A), jidOf(LEAD)]);
  assert.deepEqual(h.session.queue.map((q) => q.reply), [false], "COLD_B is still waiting its own gap");
  // Stop the drain: the sleeping worker wakes, sees no lease and leaves the queue alone.
  h.setLeaseHeld(false);
  (h.session as unknown as { wakeDrain?: (() => void) | null }).wakeDrain?.();
});

test("nextQueueIndex: the oldest reply jumps cold sends, unless an older send to the same phone is queued", () => {
  const item = (toPhone: string, reply: boolean) => ({ record: { toPhone } as MessageRecord, reply });
  assert.equal(nextQueueIndex([item(COLD_A, false), item(COLD_B, false)]), 0);
  assert.equal(nextQueueIndex([item(COLD_A, false), item(LEAD, true), item(COLD_B, true)]), 1);
  // A cold send to LEAD is queued before the reply: keep LEAD's order, take the next eligible reply.
  assert.equal(nextQueueIndex([item(LEAD, false), item(LEAD, true), item(COLD_B, true)]), 2);
  assert.equal(nextQueueIndex([item(LEAD, false), item(LEAD, true)]), 0);
});

// ---------------------------------------------------------------------------
// Store: the reply lookup and the restart seed.
// ---------------------------------------------------------------------------

/** A fake PostgREST client: records every call per table and serves `pages[table]` one `range` at a time. */
function fakeSupabase(pages: Record<string, unknown[][]>) {
  const calls: Record<string, unknown[][]> = {};
  return {
    calls,
    client: {
      from(table: string) {
        const log = (calls[table] ??= []);
        const builder: Record<string, unknown> = {};
        for (const method of ["select", "eq", "is", "gte", "order"]) {
          builder[method] = (...args: unknown[]) => {
            log.push([method, ...args]);
            return builder;
          };
        }
        builder.range = async (from: number, to: number) => {
          log.push(["range", from, to]);
          return { data: (pages[table] ?? []).shift() ?? [], error: null };
        };
        builder.limit = async () => ({ data: (pages[table] ?? []).shift() ?? [], error: null });
        return builder;
      },
    },
  };
}

test("store.hasInboundFromPhone: windowMs narrows the look-back to the reply window", async () => {
  const store = new BridgeStore(makeConfig());
  const fake = fakeSupabase({ whatsapp_inbound_messages: [[{ id: 1 }]] });
  (store as unknown as { supabase: unknown }).supabase = fake.client;
  assert.equal(await store.hasInboundFromPhone(TENANT, LEAD, Date.parse("2026-11-02T12:00:00.000Z"), 24 * HOUR), true);
  assert.deepEqual(fake.calls.whatsapp_inbound_messages.find((c) => c[0] === "gte"), ["gte", "received_at", "2026-11-01T12:00:00.000Z"]);
});

test("store.getDailyActivity: with a reply window, a 1:1 send to someone who messaged in the window before it counts 0 units", async () => {
  const store = new BridgeStore(makeConfig());
  const sent = (to: string | null, createdAt: string, group: string | null = null) => ({
    status: "sent",
    dispatch_attempted: true,
    sent_at: createdAt,
    created_at: createdAt,
    to_phone: to,
    group_jid: group,
  });
  const fake = fakeSupabase({
    whatsapp_messages: [
      [
        sent(LEAD, "2026-11-02T09:00:00.000Z"), // inbound 2h before -> reply, 0
        sent(COLD_A, "2026-11-02T09:05:00.000Z"), // inbound only AFTER it -> cold, 1
        sent(COLD_B, "2026-11-02T09:10:00.000Z"), // inbound 30h before -> outside 24h, 1
        sent(null, "2026-11-02T09:15:00.000Z", GROUP_JID), // group -> 5
        { ...sent(LEAD, "2026-11-02T09:20:00.000Z"), status: "failed", dispatch_attempted: false }, // never dispatched -> 0
      ],
    ],
    whatsapp_inbound_messages: [
      [
        { from_phone: LEAD, received_at: "2026-11-02T07:00:00.000Z" },
        { from_phone: COLD_A, received_at: "2026-11-02T09:30:00.000Z" },
        { from_phone: COLD_B, received_at: "2026-11-01T03:10:00.000Z" },
      ],
    ],
  });
  (store as unknown as { supabase: unknown }).supabase = fake.client;
  const activity = await store.getDailyActivity(TENANT, 24 * HOUR);
  assert.deepEqual(activity, { attemptCount: 0 + 1 + 1 + 5, lastAttemptAt: "2026-11-02T09:15:00.000Z" });
  // Same 1:1-message filters as hasInboundFromPhone.
  const inbound = fake.calls.whatsapp_inbound_messages;
  for (const filter of [["is", "group_jid", null], ["is", "event_kind", null], ["eq", "direction", "inbound"], ["eq", "coach_id", TENANT]]) {
    assert.ok(inbound.some((c) => JSON.stringify(c) === JSON.stringify(filter)), `missing ${JSON.stringify(filter)}`);
  }
});

test("store.getDailyActivity: no reply window -> no inbound read, every dispatched 1:1 send counts 1 (the pre-reply behaviour)", async () => {
  const store = new BridgeStore(makeConfig());
  const fake = fakeSupabase({
    whatsapp_messages: [[{ status: "sent", dispatch_attempted: true, sent_at: "2026-11-02T09:00:00.000Z", created_at: "2026-11-02T09:00:00.000Z", to_phone: LEAD, group_jid: null }]],
  });
  (store as unknown as { supabase: unknown }).supabase = fake.client;
  assert.equal((await store.getDailyActivity(TENANT)).attemptCount, 1);
  assert.equal(fake.calls.whatsapp_inbound_messages, undefined);
});

test("store.getDailyActivity: reads past PostgREST's 1000-row page", async () => {
  const store = new BridgeStore(makeConfig());
  const row = { status: "sent", dispatch_attempted: true, sent_at: "2026-11-02T09:00:00.000Z", created_at: "2026-11-02T09:00:00.000Z", to_phone: COLD_A, group_jid: null };
  const fake = fakeSupabase({ whatsapp_messages: [Array(1000).fill(row), Array(7).fill(row)] });
  (store as unknown as { supabase: unknown }).supabase = fake.client;
  assert.equal((await store.getDailyActivity(TENANT)).attemptCount, 1007);
  assert.deepEqual(
    fake.calls.whatsapp_messages.filter((c) => c[0] === "range"),
    [
      ["range", 0, 999],
      ["range", 1000, 1999],
    ]
  );
});
