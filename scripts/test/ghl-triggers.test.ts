/** Workflow trigger firing — offline, fake repo and fake fetch. */
import test from "node:test";
import assert from "node:assert/strict";

import { fireWorkflowTrigger, postTriggerEvent, toTriggerMessageType, type TriggerDeps, type TriggerRepo } from "@/lib/ghl-triggers";
import type { GhlAccount } from "@/lib/types";

const OK_URL_A = "https://services.leadconnectorhq.com/workflows-trigger/a";
const OK_URL_B = "https://services.leadconnectorhq.com/workflows-trigger/b";

function makeAccount(over: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: "loc-1",
    tenantId: "t-1",
    label: "Loc",
    status: "active",
    accessToken: "tok-1",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "r",
    ...over,
  } as GhlAccount;
}

function fakeRepo(subs: { id: string; targetUrl: string }[], account: GhlAccount | null = makeAccount()) {
  const reads: string[] = [];
  const repo = {
    async listTriggerSubscriptions() {
      reads.push("list");
      return subs;
    },
    async getGhlAccountByLocationId() {
      reads.push("account");
      return account;
    },
    async claimGhlTokenRefresh() {
      reads.push("claim");
      return true;
    },
    async saveGhlTokens() {},
    async markGhlNeedsReauth() {},
  } as unknown as TriggerRepo;
  return { repo, reads };
}

function fakeDeps(over: Partial<TriggerDeps> = {}) {
  const posts: { url: string; token: string; payload: object }[] = [];
  const deps: TriggerDeps = {
    refreshToken: async () => ({ ok: false, kind: "transient" }) as never,
    refreshWaitMs: 0,
    notify: () => {},
    enabled: () => true,
    postTriggerEvent: async (url, token, payload) => {
      posts.push({ url, token, payload });
      return { ok: true, status: 200 };
    },
    ...over,
  };
  return { deps, posts };
}

const payload = { number: "+447700900000", numberLabel: null, downMinutes: 7 };

test("flag off: no fetch, no repo reads", async () => {
  const { repo, reads } = fakeRepo([{ id: "1", targetUrl: OK_URL_A }]);
  const { deps, posts } = fakeDeps({ enabled: () => false });
  const r = await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload);
  assert.deepEqual(r, { fired: 0, failed: 0 });
  assert.equal(reads.length, 0);
  assert.equal(posts.length, 0);
});

test("fires to every subscription for the key", async () => {
  const { repo } = fakeRepo([
    { id: "1", targetUrl: OK_URL_A },
    { id: "2", targetUrl: OK_URL_B },
  ]);
  const { deps, posts } = fakeDeps();
  const r = await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload);
  assert.deepEqual(r, { fired: 2, failed: 0 });
  assert.deepEqual(posts.map((p) => p.url), [OK_URL_A, OK_URL_B]);
  assert.equal(posts[0].token, "tok-1");
});

test("foreign host at fire time is skipped", async () => {
  const { repo } = fakeRepo([
    { id: "1", targetUrl: "https://leadconnectorhq.com.evil.example/x" },
    { id: "2", targetUrl: "http://services.leadconnectorhq.com/x" },
    { id: "3", targetUrl: OK_URL_A },
  ]);
  const { deps, posts } = fakeDeps();
  const r = await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload);
  assert.deepEqual(r, { fired: 1, failed: 2 });
  assert.deepEqual(posts.map((p) => p.url), [OK_URL_A]);
});

test("a 500 from one target doesn't stop the others", async () => {
  const { repo } = fakeRepo([
    { id: "1", targetUrl: OK_URL_A },
    { id: "2", targetUrl: OK_URL_B },
  ]);
  const seen: string[] = [];
  const { deps } = fakeDeps({
    postTriggerEvent: async (url) => {
      seen.push(url);
      return url === OK_URL_A ? { ok: false, status: 500 } : { ok: true, status: 200 };
    },
  });
  const r = await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload);
  assert.deepEqual(r, { fired: 1, failed: 1 });
  assert.deepEqual(seen, [OK_URL_A, OK_URL_B]);
});

test("a throwing post counts as failed and does not throw", async () => {
  const { repo } = fakeRepo([{ id: "1", targetUrl: OK_URL_A }]);
  const { deps } = fakeDeps({
    postTriggerEvent: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload), { fired: 0, failed: 1 });
});

test("a throwing repo never throws out of fire", async () => {
  const repo = {
    async listTriggerSubscriptions() {
      throw new Error("db down");
    },
  } as unknown as TriggerRepo;
  const { deps } = fakeDeps();
  assert.deepEqual(await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload), { fired: 0, failed: 0 });
});

test("fire timeout never blocks", async () => {
  const { repo } = fakeRepo([{ id: "1", targetUrl: OK_URL_A }]);
  const never = (() => new Promise(() => {})) as unknown as typeof fetch;
  const { deps } = fakeDeps({
    postTriggerEvent: (url, token, p) => postTriggerEvent(url, token, p, { fetchImpl: never, timeoutMs: 30 }),
  });
  const started = Date.now();
  const r = await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload);
  assert.deepEqual(r, { fired: 0, failed: 1 });
  assert.ok(Date.now() - started < 2000);
});

test("no token -> failed, no throw, nothing posted", async () => {
  const { repo } = fakeRepo([{ id: "1", targetUrl: OK_URL_A }], makeAccount({ status: "needs_reauth", accessToken: null, accessTokenExpiresAt: null }));
  const { deps, posts } = fakeDeps();
  assert.deepEqual(await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload), { fired: 0, failed: 1 });
  assert.equal(posts.length, 0);
  const missing = fakeRepo([{ id: "1", targetUrl: OK_URL_A }], null);
  assert.deepEqual(await fireWorkflowTrigger(missing.repo, deps, "loc-1", "whatsapp_reconnected", payload), { fired: 0, failed: 1 });
});

test("payload sent is exactly the given object", async () => {
  const { repo } = fakeRepo([{ id: "1", targetUrl: OK_URL_A }]);
  const { deps, posts } = fakeDeps();
  await fireWorkflowTrigger(repo, deps, "loc-1", "whatsapp_reconnected", payload);
  assert.deepEqual(posts[0].payload, payload);
  assert.equal(posts[0].payload, payload);
});

test("postTriggerEvent sends method, headers and an exact JSON body", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;
  const r = await postTriggerEvent(OK_URL_A, "tok", payload, { fetchImpl: fake });
  assert.deepEqual(r, { ok: true, status: 201 });
  const c = captured as unknown as { url: string; init: RequestInit };
  assert.equal(c.url, OK_URL_A);
  assert.equal(c.init.method, "POST");
  const headers = c.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["Content-Type"], "application/json");
  assert.match(headers.Version, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(c.init.body, JSON.stringify(payload));
  assert.ok(c.init.signal);
});

test("postTriggerEvent: a 500 is not ok; a network error is status null", async () => {
  const f500 = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  assert.deepEqual(await postTriggerEvent(OK_URL_A, "t", {}, { fetchImpl: f500 }), { ok: false, status: 500 });
  const boom = (async () => {
    throw new Error("net");
  }) as unknown as typeof fetch;
  assert.deepEqual(await postTriggerEvent(OK_URL_A, "t", {}, { fetchImpl: boom }), { ok: false, status: null });
});

test("toTriggerMessageType mapping", () => {
  assert.equal(toTriggerMessageType("conversation"), "text");
  assert.equal(toTriggerMessageType("extendedTextMessage"), "text");
  assert.equal(toTriggerMessageType("audioMessage:ptt"), "voice_note");
  assert.equal(toTriggerMessageType("audioMessage"), "other");
  assert.equal(toTriggerMessageType("imageMessage"), "image");
  assert.equal(toTriggerMessageType("videoMessage"), "video");
  assert.equal(toTriggerMessageType("documentMessage"), "document");
  assert.equal(toTriggerMessageType("stickerMessage"), "other");
  assert.equal(toTriggerMessageType(""), "other");
});
