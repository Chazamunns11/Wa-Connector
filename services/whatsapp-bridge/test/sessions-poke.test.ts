/**
 * src/sessions.ts's dispatch-path outbound poke (docs/GHL-PROVIDER-PLAN.md
 * §4 item 10) — `recordSent`/`recordFailed`/`recordNotOnWhatsapp`, the three
 * small module-level functions `drainQueue` calls instead of
 * `store.markMessageX` directly, extracted specifically so this behaviour is
 * testable without a live Baileys socket (see sessions.ts's own comment
 * immediately above these three functions). Each pairs "mark the ledger row"
 * with "schedule the outbound poke (no-op if unconfigured)".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFailed, recordNotOnWhatsapp, recordReconnected, recordSent } from "../src/sessions.js";
import type { BridgeStore } from "../src/store.js";
import type { PortalPoke } from "../src/poke.js";

function makeFakeStore() {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = {
    markMessageSent: async (messageId: string, waMessageId: string | null) => {
      calls.push({ method: "markMessageSent", args: [messageId, waMessageId] });
    },
    markMessageFailed: async (messageId: string, errorMessage: string, dispatchAttempted: boolean) => {
      calls.push({ method: "markMessageFailed", args: [messageId, errorMessage, dispatchAttempted] });
    },
    markMessageNotOnWhatsapp: async (messageId: string) => {
      calls.push({ method: "markMessageNotOnWhatsapp", args: [messageId] });
    },
  } as unknown as BridgeStore;
  return { store, calls };
}

function makeFakePoke() {
  let scheduleCount = 0;
  const poke = { schedule: () => { scheduleCount++; } } as unknown as PortalPoke;
  return { poke, scheduleCount: () => scheduleCount };
}

test("recordSent: marks the store AND schedules exactly one poke", async () => {
  const { store, calls } = makeFakeStore();
  const { poke, scheduleCount } = makeFakePoke();
  await recordSent(store, poke, "msg-1", "wamid-1");
  assert.deepEqual(calls, [{ method: "markMessageSent", args: ["msg-1", "wamid-1"] }]);
  assert.equal(scheduleCount(), 1);
});

test("recordFailed: marks the store AND schedules exactly one poke", async () => {
  const { store, calls } = makeFakeStore();
  const { poke, scheduleCount } = makeFakePoke();
  await recordFailed(store, poke, "msg-2", "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key", true);
  assert.deepEqual(calls, [
    { method: "markMessageFailed", args: ["msg-2", "send attempt failed after reaching WhatsApp — delivery uncertain, do not blindly retry with a new key", true] },
  ]);
  assert.equal(scheduleCount(), 1);
});

test("recordNotOnWhatsapp: marks the store AND schedules exactly one poke", async () => {
  const { store, calls } = makeFakeStore();
  const { poke, scheduleCount } = makeFakePoke();
  await recordNotOnWhatsapp(store, poke, "msg-3");
  assert.deepEqual(calls, [{ method: "markMessageNotOnWhatsapp", args: ["msg-3"] }]);
  assert.equal(scheduleCount(), 1);
});

test("all three: an unconfigured (null) poke marks the store but schedules ZERO pokes, and never throws", async () => {
  const { store, calls } = makeFakeStore();
  await assert.doesNotReject(recordSent(store, null, "msg-4", null));
  await assert.doesNotReject(recordFailed(store, null, "msg-5", "could not verify WhatsApp registration before sending — not dispatched", false));
  await assert.doesNotReject(recordNotOnWhatsapp(store, null, "msg-6"));
  assert.equal(calls.length, 3);
});

test("each call schedules exactly once — not once per terminal outcome type combined, not zero, not twice", async () => {
  const { store } = makeFakeStore();
  const { poke, scheduleCount } = makeFakePoke();
  await recordSent(store, poke, "a", null);
  await recordFailed(store, poke, "b", "internal error before dispatch — not sent", false);
  await recordNotOnWhatsapp(store, poke, "c");
  assert.equal(scheduleCount(), 3, "three terminal outcomes must produce exactly three poke schedules, one each");
});

test("recordReconnected: schedules exactly one poke", () => {
  const { poke, scheduleCount } = makeFakePoke();
  recordReconnected(poke);
  assert.equal(scheduleCount(), 1);
});

test("recordReconnected: null poke is a no-op and does not throw", () => {
  assert.doesNotThrow(() => recordReconnected(null));
});
