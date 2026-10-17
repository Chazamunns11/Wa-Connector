/**
 * The sub-account's reaction/delete switches (src/app/api/crm/embed/message-events/logic.ts).
 * Offline: fake repo. No tenant id may appear in any response.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decideMessageEventsRequest, type MessageEventsRepo } from "@/app/api/crm/embed/message-events/logic";
import type { GhlAccount } from "@/lib/types";

const TENANT = "77777777-aaaa-4aaa-8aaa-777777777777";
const LOC_A = "loc-a";
const LOC_B = "loc-b";

function fakeRepo() {
  type Row = { showReactions: boolean; showDeletes: boolean; smsFallbackEnabled: boolean; smsFallbackBlockedAt: string | null };
  const fresh = (): Row => ({ showReactions: false, showDeletes: false, smsFallbackEnabled: true, smsFallbackBlockedAt: null });
  const store = new Map<string, Row>([
    [LOC_A, fresh()],
    [LOC_B, fresh()],
  ]);
  const writes: string[] = [];
  const repo: MessageEventsRepo = {
    async getGhlAccountByLocationId(locationId) {
      const s = store.get(locationId);
      return s ? ({ locationId, tenantId: TENANT, ...s } as unknown as GhlAccount) : null;
    },
    async setMessageEventSettings(locationId, settings) {
      writes.push(locationId);
      const s = store.get(locationId);
      if (!s) return;
      if (settings.showReactions !== undefined) s.showReactions = settings.showReactions;
      if (settings.showDeletes !== undefined) s.showDeletes = settings.showDeletes;
    },
    async setSmsFallbackEnabled(locationId, enabled) {
      writes.push(`sms:${locationId}`);
      const s = store.get(locationId);
      if (!s) return;
      s.smsFallbackEnabled = enabled;
      if (enabled) s.smsFallbackBlockedAt = null;
    },
  };
  return { repo, writes, store };
}

test("read defaults: reactions and deletes off, SMS fallback on", async () => {
  const { repo } = fakeRepo();
  const r = await decideMessageEventsRequest(repo, LOC_A, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, showReactions: false, showDeletes: false, smsFallback: true, smsFallbackBlocked: false, smsFallbackAvailable: false });
});

test("writing one leaves the other alone", async () => {
  const { repo } = fakeRepo();
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, { showReactions: true })).body, { ok: true, showReactions: true, showDeletes: false, smsFallback: true, smsFallbackBlocked: false, smsFallbackAvailable: false });
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, { showDeletes: true, smsFallback: true, smsFallbackBlocked: false, smsFallbackAvailable: false })).body, { ok: true, showReactions: true, showDeletes: true, smsFallback: true, smsFallbackBlocked: false, smsFallbackAvailable: false });
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, { showReactions: false })).body, { ok: true, showReactions: false, showDeletes: true, smsFallback: true, smsFallbackBlocked: false, smsFallbackAvailable: false });
});

test("a non-boolean is a 400 and writes nothing", async () => {
  const { repo, writes } = fakeRepo();
  for (const body of [{ showReactions: "true" }, { showDeletes: 1 }, { showReactions: null }, { showReactions: true, showDeletes: "no" }, { smsFallback: "false" }, { smsFallback: 0 }]) {
    const r = await decideMessageEventsRequest(repo, LOC_A, body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, code: "invalid_body", message: "Malformed request." });
  }
  assert.equal((await decideMessageEventsRequest(repo, LOC_A, null)).status, 400);
  assert.deepEqual(writes, []);
});

test("one sub-account's settings never change another's", async () => {
  const { repo } = fakeRepo();
  await decideMessageEventsRequest(repo, LOC_A, { showReactions: true, showDeletes: true, smsFallback: true, smsFallbackBlocked: false, smsFallbackAvailable: false });
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_B, {})).body, { ok: true, showReactions: false, showDeletes: false, smsFallback: true, smsFallbackBlocked: false, smsFallbackAvailable: false });
});

test("an unknown location is a 404 and never written", async () => {
  const { repo, writes } = fakeRepo();
  const r = await decideMessageEventsRequest(repo, "loc-missing", { showReactions: true });
  assert.equal(r.status, 404);
  assert.deepEqual(writes, []);
  assert.equal((await decideMessageEventsRequest(repo, "loc-missing", {})).status, 404);
});

test("no tenant id in any response", async () => {
  const { repo } = fakeRepo();
  for (const body of [{}, { showReactions: true }, { showDeletes: "x" }, { smsFallback: false }, null]) {
    assert.ok(!JSON.stringify(await decideMessageEventsRequest(repo, LOC_A, body)).includes(TENANT));
  }
});

test("the SMS fallback setting reads and writes, and leaves the other switches alone", async () => {
  const { repo, writes } = fakeRepo();
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, { smsFallback: false })).body, {
    ok: true,
    showReactions: false,
    showDeletes: false,
    smsFallback: false,
    smsFallbackBlocked: false,
    smsFallbackAvailable: false,
  });
  assert.deepEqual(writes, [`sms:${LOC_A}`], "only the SMS switch is written");
  assert.equal((await decideMessageEventsRequest(repo, LOC_A, {})).body.smsFallback, false);
  assert.equal((await decideMessageEventsRequest(repo, LOC_A, { smsFallback: true })).body.smsFallback, true);
});

test("a blocked sub-account reads as off and blocked; switching it on again clears the block", async () => {
  const { repo, store } = fakeRepo();
  store.get(LOC_A)!.smsFallbackBlockedAt = "2026-10-17T10:00:00Z";
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, {})).body, {
    ok: true,
    showReactions: false,
    showDeletes: false,
    smsFallback: false,
    smsFallbackBlocked: true,
    smsFallbackAvailable: false,
  });
  const after = await decideMessageEventsRequest(repo, LOC_A, { smsFallback: true });
  assert.equal(after.body.smsFallback, true);
  assert.equal(after.body.smsFallbackBlocked, false);
  assert.equal(store.get(LOC_A)!.smsFallbackBlockedAt, null);
});

test("one sub-account's SMS fallback setting never changes another's", async () => {
  const { repo, store } = fakeRepo();
  store.get(LOC_B)!.smsFallbackBlockedAt = "2026-10-17T10:00:00Z";
  await decideMessageEventsRequest(repo, LOC_A, { smsFallback: false });
  await decideMessageEventsRequest(repo, LOC_A, { smsFallback: true });
  const b = (await decideMessageEventsRequest(repo, LOC_B, {})).body;
  assert.equal(b.smsFallback, false);
  assert.equal(b.smsFallbackBlocked, true, "B's block stands");
  await decideMessageEventsRequest(repo, LOC_B, { smsFallback: false });
  assert.equal((await decideMessageEventsRequest(repo, LOC_A, {})).body.smsFallback, true);
});

test("the settings card has the plan's exact SMS fallback wording", () => {
  const source = readFileSync(new URL("../../src/app/embed/crm/MessageEventSettings.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("Send as SMS when a contact isn't on WhatsApp"));
  assert.ok(source.includes("Uses this sub-account's own SMS provider, so normal SMS charges apply."));
  assert.ok(
    source.includes(
      "Turned off: this sub-account's SMS goes through PingWren. Connect another SMS provider (LC Phone or Twilio) in GHL, then switch it back on."
    )
  );
});

test("smsFallbackAvailable follows the global GHL_SMS_FALLBACK_ENABLED switch, so the toggle only shows when it can work", async () => {
  const before = process.env.GHL_SMS_FALLBACK_ENABLED;
  try {
    const { repo } = fakeRepo();
    delete process.env.GHL_SMS_FALLBACK_ENABLED;
    assert.equal((await decideMessageEventsRequest(repo, LOC_A, {})).body.smsFallbackAvailable, false);
    process.env.GHL_SMS_FALLBACK_ENABLED = "true";
    assert.equal((await decideMessageEventsRequest(repo, LOC_A, {})).body.smsFallbackAvailable, true);
  } finally {
    if (before === undefined) delete process.env.GHL_SMS_FALLBACK_ENABLED;
    else process.env.GHL_SMS_FALLBACK_ENABLED = before;
  }
});
