/** Subscription webhook decision logic — offline, fake repo. */
import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizeTriggerSubscription,
  checkTriggerSubscriptionBodySize,
  decideTriggerSubscription,
  MAX_TRIGGER_SUBSCRIPTION_BODY_BYTES,
  refuseOversizeTriggerSubscription,
  type TriggerSubscriptionRepo,
} from "@/app/api/webhooks/ghl-trigger-subscription/logic";
import { isAllowedTriggerTargetUrl } from "@/lib/ghl-trigger-keys";
import type { GhlAccount } from "@/lib/types";

const SECRET = "test-webhook-secret";
const URL_OK = "https://services.leadconnectorhq.com/workflows-trigger/abc";
const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
};

function fakeRepo(knownLocations: string[] = ["loc-1"]) {
  const subs = new Map<string, { id: string; locationId: string; targetUrl: string; triggerKey: string }>();
  const repo: TriggerSubscriptionRepo = {
    async getGhlAccountByLocationId(locationId: string) {
      return knownLocations.includes(locationId) ? ({ locationId } as GhlAccount) : null;
    },
    async upsertTriggerSubscription(sub) {
      const existing = subs.get(sub.id);
      if (existing && existing.locationId !== sub.locationId) return "location_mismatch";
      subs.set(sub.id, { id: sub.id, locationId: sub.locationId, targetUrl: sub.targetUrl, triggerKey: sub.triggerKey });
      return "ok";
    },
    async deleteTriggerSubscription(id: string, locationId: string) {
      if (subs.get(id)?.locationId === locationId) subs.delete(id);
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
    "https://services.leadconnectorhq.com:8443/x",
    "https://services.leadconnectorhq.com:443/x",
    "https://services..leadconnectorhq.com/x",
    "https://a..services.leadconnectorhq.com/x",
    "https://services.leadconnectorhq.com./x",
    "https://eu.leadconnectorhq.com/x",
    "https://leadconnectorhq.com/x",
    "https://" + "a".repeat(2100) + ".services.leadconnectorhq.com/x",
    "not a url",
    undefined,
    42,
  ]) {
    const r = await decideTriggerSubscription(repo, SECRET, body({ targetUrl }), env);
    assert.equal(r.status, 400, String(targetUrl));
  }
  assert.equal(subs.size, 0);
});

test("host rule accepts the exact host and its subdomains only, normalised", () => {
  assert.equal(isAllowedTriggerTargetUrl("https://services.leadconnectorhq.com/a"), true);
  assert.equal(isAllowedTriggerTargetUrl("https://eu.services.leadconnectorhq.com/a"), true);
  assert.equal(isAllowedTriggerTargetUrl("https://eu.leadconnectorhq.com/a"), false);
  assert.equal(isAllowedTriggerTargetUrl("https://leadconnectorhq.com/a"), false);
});

test("uppercase host is accepted and stored normalised", async () => {
  const { repo, subs } = fakeRepo();
  const r = await decideTriggerSubscription(repo, SECRET, body({ targetUrl: "https://SERVICES.LeadConnectorHQ.com/Path" }), env);
  assert.equal(r.status, 200);
  assert.equal(subs.get("sub-1")?.targetUrl, "https://services.leadconnectorhq.com/Path");
});

test("a different location cannot take over or delete a subscription id", async () => {
  const { repo, subs } = fakeRepo(["loc-1", "loc-2"]);
  await decideTriggerSubscription(repo, SECRET, body(), env);
  const take = await decideTriggerSubscription(repo, SECRET, body({ locationId: "loc-2", eventType: "UPDATED" }), env);
  assert.equal(take.status, 409);
  assert.equal(take.body.error, "location_mismatch");
  assert.equal((await decideTriggerSubscription(repo, SECRET, body({ locationId: "loc-2", eventType: "DELETED" }), env)).status, 200);
  assert.equal(subs.get("sub-1")?.locationId, "loc-1");
});

test("DELETED for an unknown location is 200", async () => {
  const { repo } = fakeRepo();
  assert.equal((await decideTriggerSubscription(repo, SECRET, body({ locationId: "nope", eventType: "DELETED" }), env)).status, 200);
});

test("repository errors -> 500 internal", async () => {
  const restore = quiet();
  try {
    const { repo } = fakeRepo();
    repo.upsertTriggerSubscription = async () => {
      throw new Error("db down");
    };
    const r = await decideTriggerSubscription(repo, SECRET, body(), env);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { ok: false, error: "internal" });
  } finally {
    restore();
  }
});

test("auth gate runs on its own, before any body", () => {
  assert.equal(authorizeTriggerSubscription(null, env)?.status, 401);
  assert.equal(authorizeTriggerSubscription(SECRET, { secret: undefined })?.status, 503);
  assert.equal(authorizeTriggerSubscription(SECRET, env), null);
});

test("oversized fields and filters -> 400", async () => {
  const { repo, subs } = fakeRepo(["loc-1", "x".repeat(129)]);
  const long = "x".repeat(129);
  const withFilters = (filters: unknown) => {
    const b = body();
    (b.triggerData as Record<string, unknown>).filters = filters;
    return b;
  };
  const cases: unknown[] = [
    body({ id: long }),
    body({ locationId: long }),
    { ...body(), extras: { locationId: "loc-1", workflowId: long } },
    body({ targetUrl: "https://services.leadconnectorhq.com/" + "a".repeat(2048) }),
    withFilters("not an array"),
    withFilters(Array.from({ length: 51 }, () => 1)),
    withFilters([{ v: "y".repeat(9000) }]),
  ];
  for (const c of cases) assert.equal((await decideTriggerSubscription(repo, SECRET, c, env)).status, 400);
  assert.equal(subs.size, 0);
  assert.equal((await decideTriggerSubscription(repo, SECRET, withFilters([{ a: 1 }]), env)).status, 200);
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

// ---------------------------------------------------------------------------
// Body size: a declared content-length over 16 KB is refused before reading.
// ---------------------------------------------------------------------------

test("size gate: a declared content-length over 16 KB is a 413; at the limit or missing is allowed", () => {
  assert.equal(MAX_TRIGGER_SUBSCRIPTION_BODY_BYTES, 16 * 1024);
  assert.deepEqual(refuseOversizeTriggerSubscription(String(16 * 1024 + 1)), { status: 413, body: { ok: false, error: "payload_too_large" } });
  assert.equal(refuseOversizeTriggerSubscription("abc")?.status, 413);
  assert.equal(refuseOversizeTriggerSubscription(String(16 * 1024)), null);
  assert.equal(refuseOversizeTriggerSubscription("120"), null);
  assert.equal(refuseOversizeTriggerSubscription(null), null);
  assert.equal(checkTriggerSubscriptionBodySize("x".repeat(16 * 1024 + 1))?.status, 413);
  assert.equal(checkTriggerSubscriptionBodySize("{}"), null);
});

test("route: an oversize body is refused with 413 without being read", async () => {
  const before = process.env.GHL_WORKFLOW_WEBHOOK_SECRET;
  process.env.GHL_WORKFLOW_WEBHOOK_SECRET = SECRET;
  try {
    const { POST } = await import("@/app/api/webhooks/ghl-trigger-subscription/route");
    let read = false;
    const request = {
      headers: new Headers({ "x-pingwren-secret": SECRET, "content-length": String(20 * 1024) }),
      async text() { read = true; return ""; },
      async json() { read = true; return {}; },
    } as unknown as Request;
    const res = await POST(request);
    assert.equal(res.status, 413);
    assert.equal(read, false, "the body is never read");

    // Without a secret, auth still answers first.
    const unauth = { ...request, headers: new Headers({ "content-length": String(20 * 1024) }) } as unknown as Request;
    assert.equal((await POST(unauth)).status, 401);
  } finally {
    if (before === undefined) delete process.env.GHL_WORKFLOW_WEBHOOK_SECRET;
    else process.env.GHL_WORKFLOW_WEBHOOK_SECRET = before;
  }
});

test("route: an undeclared body over 16 KB is refused with 413 after reading", async () => {
  const before = process.env.GHL_WORKFLOW_WEBHOOK_SECRET;
  process.env.GHL_WORKFLOW_WEBHOOK_SECRET = SECRET;
  try {
    const { POST } = await import("@/app/api/webhooks/ghl-trigger-subscription/route");
    const request = {
      headers: new Headers({ "x-pingwren-secret": SECRET }),
      async text() { return "x".repeat(16 * 1024 + 1); },
    } as unknown as Request;
    assert.equal((await POST(request)).status, 413);
  } finally {
    if (before === undefined) delete process.env.GHL_WORKFLOW_WEBHOOK_SECRET;
    else process.env.GHL_WORKFLOW_WEBHOOK_SECRET = before;
  }
});
