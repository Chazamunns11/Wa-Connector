/** T10 — optional GoHighLevel DND sync client (`setGhlContactDnd`, `isGhlDndSyncEnabled`). Offline: `fetch` is injected via globalThis. */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { isGhlDndSyncEnabled, setGhlContactDnd } from "@/lib/ghl";

const realFetch = globalThis.fetch;
const realFlag = process.env.GHL_SYNC_DND;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realFlag === undefined) delete process.env.GHL_SYNC_DND;
  else process.env.GHL_SYNC_DND = realFlag;
});

test("isGhlDndSyncEnabled: only the exact string 'true'", () => {
  delete process.env.GHL_SYNC_DND;
  assert.equal(isGhlDndSyncEnabled(), false);
  for (const v of ["", "false", "1", "TRUE", "yes"]) {
    process.env.GHL_SYNC_DND = v;
    assert.equal(isGhlDndSyncEnabled(), false, v);
  }
  process.env.GHL_SYNC_DND = "true";
  assert.equal(isGhlDndSyncEnabled(), true);
});

test("setGhlContactDnd(true): PUT /contacts/{id} with WhatsApp+SMS dndSettings active", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const out = await setGhlContactDnd("tok-secret", "c/1", true);
  assert.deepEqual(out, { ok: true });
  assert.equal(seen!.url, "https://services.leadconnectorhq.com/contacts/c%2F1");
  assert.equal(seen!.init.method, "PUT");
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer tok-secret");
  const body = JSON.parse(seen!.init.body as string);
  assert.equal(body.dndSettings.WhatsApp.status, "active");
  assert.equal(body.dndSettings.SMS.status, "active");
  assert.equal(body.dnd, undefined);
  assert.equal(body.dndSettings.Email, undefined);
});

test("setGhlContactDnd(false): statuses inactive", async () => {
  let body: { dndSettings: Record<string, { status: string }> } | null = null;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await setGhlContactDnd("t", "c1", false), { ok: true });
  assert.equal(body!.dndSettings.WhatsApp.status, "inactive");
  assert.equal(body!.dndSettings.SMS.status, "inactive");
});

test("setGhlContactDnd: HTTP error -> fixed string, nothing logged containing the token", async () => {
  const logged: unknown[][] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  globalThis.fetch = (async () => new Response('{"echo":"tok-secret"}', { status: 422 })) as unknown as typeof fetch;
  try {
    assert.deepEqual(await setGhlContactDnd("tok-secret", "c1", true), { ok: false, error: "dnd update rejected: HTTP 422" });
  } finally {
    console.error = realErr;
  }
  assert.equal(JSON.stringify(logged).includes("tok-secret"), false);
});

test("setGhlContactDnd: network failure -> 'dnd update unreachable', never throws", async () => {
  const realErr = console.error;
  console.error = () => {};
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  try {
    assert.deepEqual(await setGhlContactDnd("t", "c1", true), { ok: false, error: "dnd update unreachable" });
  } finally {
    console.error = realErr;
  }
});
