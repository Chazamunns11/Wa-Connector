/**
 * The sub-account's reaction/delete switches (src/app/api/crm/embed/message-events/logic.ts).
 * Offline: fake repo. No tenant id may appear in any response.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decideMessageEventsRequest, type MessageEventsRepo } from "@/app/api/crm/embed/message-events/logic";
import type { GhlAccount } from "@/lib/types";

const TENANT = "77777777-aaaa-4aaa-8aaa-777777777777";
const LOC_A = "loc-a";
const LOC_B = "loc-b";

function fakeRepo(): { repo: MessageEventsRepo; writes: string[] } {
  const store = new Map<string, { showReactions: boolean; showDeletes: boolean }>([
    [LOC_A, { showReactions: false, showDeletes: false }],
    [LOC_B, { showReactions: false, showDeletes: false }],
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
  };
  return { repo, writes };
}

test("read defaults to both off", async () => {
  const { repo } = fakeRepo();
  const r = await decideMessageEventsRequest(repo, LOC_A, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, showReactions: false, showDeletes: false });
});

test("writing one leaves the other alone", async () => {
  const { repo } = fakeRepo();
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, { showReactions: true })).body, { ok: true, showReactions: true, showDeletes: false });
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, { showDeletes: true })).body, { ok: true, showReactions: true, showDeletes: true });
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_A, { showReactions: false })).body, { ok: true, showReactions: false, showDeletes: true });
});

test("a non-boolean is a 400 and writes nothing", async () => {
  const { repo, writes } = fakeRepo();
  for (const body of [{ showReactions: "true" }, { showDeletes: 1 }, { showReactions: null }, { showReactions: true, showDeletes: "no" }]) {
    const r = await decideMessageEventsRequest(repo, LOC_A, body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, code: "invalid_body", message: "Malformed request." });
  }
  assert.equal((await decideMessageEventsRequest(repo, LOC_A, null)).status, 400);
  assert.deepEqual(writes, []);
});

test("one sub-account's settings never change another's", async () => {
  const { repo } = fakeRepo();
  await decideMessageEventsRequest(repo, LOC_A, { showReactions: true, showDeletes: true });
  assert.deepEqual((await decideMessageEventsRequest(repo, LOC_B, {})).body, { ok: true, showReactions: false, showDeletes: false });
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
  for (const body of [{}, { showReactions: true }, { showDeletes: "x" }, null]) {
    assert.ok(!JSON.stringify(await decideMessageEventsRequest(repo, LOC_A, body)).includes(TENANT));
  }
});
