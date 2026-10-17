/** Subscription webhook decision logic — offline, fake repo. */
import test from "node:test";
import assert from "node:assert/strict";

import { decideTriggerSubscription, type TriggerSubscriptionRepo } from "@/app/api/webhooks/ghl-trigger-subscription/logic";
import { isAllowedTriggerTargetUrl } from "@/lib/ghl-trigger-keys";
import type { GhlAccount } from "@/lib/types";

const SECRET = "test-webhook-secret";
const URL_OK = "https://services.leadconnectorhq.com/workflows-trigger/abc";

function fakeRepo(knownLocations: string[] = ["loc-1"]) {
  const subs = new Map<string, { id: string; locationId: string; targetUrl: string; triggerKey: string }>();
  const repo: TriggerSubscriptionRepo = {
    async getGhlAccountByLocationId(locationId: string) {
      return knownLocations.includes(locationId) ? ({ locationId } as GhlAccount) : null;
    },
    async upsertTriggerSubscription(sub) {
      subs.set(sub.id, { id: sub.id, locationId: sub.locationId, targetUrl: sub.targetUrl, triggerKey: sub.triggerKey });
    },
    async deleteTriggerSubscription(id: string) {
      subs.delete(id);
    },
  };
  return { repo, subs };
}

function body(over: { eventType?: string; key?: string; targetUrl?: unknown; locationId?: string; id?: string } = {}) {
  return {
    triggerData: {
      id: over.id ?? "sub-1",
      key: over.key ?? "whatsapp_disconnected",
      filters: [],
      eventType: over.eventType ?? "CREATED",
      targetUrl: "targetUrl" in over ? over.targetUrl : URL_OK,
    },
    extras: { locationId: over.locationId ?? "loc-1", workflowId: "wf-1", companyId: "co-1" },
  };
}

const env = { secret: SECRET };

test("missing or wrong secret -> 401", async () => {
  const { repo, subs } = fakeRepo();
  assert.equal((await decideTriggerSubscription(repo, null, body(), env)).status, 401);
  assert.equal((await decideTriggerSubscription(repo, "nope", body(), env)).status, 401);
  assert.equal((await decideTriggerSubscription(repo, SECRET + "x", body(), env)).status, 401);
  assert.equal(subs.size, 0);
});

test("secret unset -> 503", async () => {
  const { repo } = fakeRepo();
  assert.equal((await decideTriggerSubscription(repo, SECRET, body(), { secret: undefined })).status, 503);
  assert.equal((await decideTriggerSubscription(repo, "", body(), { secret: "" })).status, 503);
});

test("unknown trigger key -> 400", async () => {
  const { repo, subs } = fakeRepo();
  const r = await decideTriggerSubscription(repo, SECRET, body({ key: "whatsapp_other" }), env);
  assert.equal(r.status, 400);
  assert.equal(subs.size, 0);
});

test("non-https or foreign target hosts -> 400", async () => {
  const { repo, subs } = fakeRepo();
  for (const targetUrl of [
    "http://services.leadconnectorhq.com/x",
    "https://example.com/x",
    "https://leadconnectorhq.com.evil.example/x",
    "https://evil.example/?h=services.leadconnectorhq.com",
    "https://services.leadconnectorhq.com@evil.example/x",
    "https://notleadconnectorhq.com/x",
    "not a url",
    undefined,
    42,
  ]) {
    const r = await decideTriggerSubscription(repo, SECRET, body({ targetUrl }), env);
    assert.equal(r.status, 400, String(targetUrl));
  }
  assert.equal(subs.size, 0);
});

test("host rule accepts the exact host and subdomains only", () => {
  assert.equal(isAllowedTriggerTargetUrl("https://services.leadconnectorhq.com/a"), true);
  assert.equal(isAllowedTriggerTargetUrl("https://eu.leadconnectorhq.com/a"), true);
  assert.equal(isAllowedTriggerTargetUrl("https://leadconnectorhq.com/a"), false);
});

test("CREATED then DELETED leaves nothing; DELETED again is fine", async () => {
  const { repo, subs } = fakeRepo();
  assert.equal((await decideTriggerSubscription(repo, SECRET, body(), env)).status, 200);
  assert.equal(subs.size, 1);
  assert.equal((await decideTriggerSubscription(repo, SECRET, body({ eventType: "DELETED" }), env)).status, 200);
  assert.equal(subs.size, 0);
  assert.equal((await decideTriggerSubscription(repo, SECRET, body({ eventType: "DELETED" }), env)).status, 200);
});

test("a duplicate CREATED leaves one row", async () => {
  const { repo, subs } = fakeRepo();
  await decideTriggerSubscription(repo, SECRET, body(), env);
  await decideTriggerSubscription(repo, SECRET, body(), env);
  assert.equal(subs.size, 1);
});

test("UPDATED changes the target URL", async () => {
  const { repo, subs } = fakeRepo();
  await decideTriggerSubscription(repo, SECRET, body(), env);
  const next = "https://services.leadconnectorhq.com/workflows-trigger/new";
  assert.equal((await decideTriggerSubscription(repo, SECRET, body({ eventType: "UPDATED", targetUrl: next }), env)).status, 200);
  assert.equal(subs.size, 1);
  assert.equal(subs.get("sub-1")?.targetUrl, next);
});

test("unknown location -> 404", async () => {
  const { repo, subs } = fakeRepo();
  const r = await decideTriggerSubscription(repo, SECRET, body({ locationId: "nope" }), env);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "unknown_location");
  assert.equal(subs.size, 0);
});

test("malformed bodies -> 400", async () => {
  const { repo } = fakeRepo();
  for (const b of [null, "x", [], {}, { triggerData: {}, extras: {} }, { triggerData: body().triggerData }, body({ eventType: "NOPE" }), body({ id: "" })]) {
    assert.equal((await decideTriggerSubscription(repo, SECRET, b, env)).status, 400);
  }
});
