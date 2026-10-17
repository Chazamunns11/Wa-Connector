import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { listGhlContacts, type GhlContactLite, type ListGhlContactsResult } from "@/lib/ghl";
import { TAG_SCAN_MAX_PAGES, contactsByTag, searchContacts, tagsFrom } from "@/lib/groups/contacts";

type Seen = { url: URL; headers: Headers; method: string };
let seen: Seen[] = [];
let respond: (n: number) => { status?: number; body: unknown } = () => ({ body: {} });
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  respond = () => ({ body: {} });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    seen.push({ url: new URL(req.url), headers: req.headers, method: req.method });
    const r = respond(seen.length - 1);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("listGhlContacts: exact URL, headers, phone normalisation, name fallbacks", async () => {
  respond = () => ({
    body: {
      contacts: [
        { id: "c1", contactName: "Ann Lee", phone: "07700 900123", tags: ["vip", "lead"] },
        { id: "c2", firstName: "Bo", lastName: "Kay", phone: null },
        { id: "c3", phone: "garbage" },
      ],
    },
  });
  const r = await listGhlContacts("tok", "loc1", { query: "an", startAfterId: "zz" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url.origin + seen[0].url.pathname, "https://services.leadconnectorhq.com/contacts/");
  assert.equal(seen[0].url.searchParams.get("locationId"), "loc1");
  assert.equal(seen[0].url.searchParams.get("limit"), "100");
  assert.equal(seen[0].url.searchParams.get("query"), "an");
  assert.equal(seen[0].url.searchParams.get("startAfterId"), "zz");
  assert.equal(seen[0].headers.get("version"), "2021-07-28");
  assert.equal(seen[0].headers.get("authorization"), "Bearer tok");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.contacts[0], { id: "c1", name: "Ann Lee", phone: "+447700900123", tags: ["vip", "lead"] });
  assert.deepEqual(r.contacts[1], { id: "c2", name: "Bo Kay", phone: null, tags: [] });
  assert.equal(r.contacts[2].phone, null);
  assert.equal(r.nextStartAfterId, null);
});

test("listGhlContacts: omits optional params, paginates via meta or last id when page is full", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}` }));
  respond = () => ({ body: { contacts: full } });
  let r = await listGhlContacts("t", "l", {});
  assert.equal(seen[0].url.searchParams.has("query"), false);
  assert.equal(seen[0].url.searchParams.has("startAfterId"), false);
  assert.ok(r.ok && r.nextStartAfterId === "c99");
  respond = () => ({ body: { contacts: full, meta: { startAfterId: "meta1" } } });
  r = await listGhlContacts("t", "l", {});
  assert.ok(r.ok && r.nextStartAfterId === "meta1");
});

test("listGhlContacts: 429 rate_limited, 4xx rejected, throw unreachable; errors are fixed strings", async () => {
  respond = () => ({ status: 429, body: { message: "secret upstream text" } });
  let r = await listGhlContacts("t", "l", {});
  assert.ok(!r.ok && r.kind === "rate_limited" && !r.error.includes("secret"));
  respond = () => ({ status: 401, body: {} });
  r = await listGhlContacts("t", "l", {});
  assert.ok(!r.ok && r.kind === "rejected");
  globalThis.fetch = (async () => {
    throw new Error("boom +447700900123");
  }) as typeof fetch;
  r = await listGhlContacts("t", "l", {});
  assert.ok(!r.ok && r.kind === "unreachable" && !r.error.includes("447"));
});

const c = (id: string, tags: string[] = [], phone: string | null = "+447700900123"): GhlContactLite => ({ id, name: id, phone, tags });
const okPage = (contacts: GhlContactLite[], next: string | null): ListGhlContactsResult => ({ ok: true, contacts, nextStartAfterId: next });

test("searchContacts: trims, enforces 2..64, passes query", async () => {
  const calls: unknown[] = [];
  const list = async (_t: string, _l: string, opts: unknown) => {
    calls.push(opts);
    return okPage([c("a")], null);
  };
  assert.deepEqual(await searchContacts(list, "t", "l", " a "), []);
  assert.deepEqual(await searchContacts(list, "t", "l", "x".repeat(65)), []);
  assert.equal(calls.length, 0);
  assert.equal((await searchContacts(list, "t", "l", "  ann ")).length, 1);
  assert.deepEqual(calls[0], { query: "ann" });
  const bad = async () => ({ ok: false, kind: "rejected", error: "x" }) as ListGhlContactsResult;
  assert.deepEqual(await searchContacts(bad, "t", "l", "ann"), []);
});

test("contactsByTag: case-insensitive match, stops at last page", async () => {
  const list = async (_t: string, _l: string, opts: { startAfterId?: string }) =>
    opts.startAfterId ? okPage([c("c", ["VIP"])], null) : okPage([c("a", ["vip"]), c("b", ["other"])], "b");
  const r = await contactsByTag(list, "t", "l", "Vip");
  assert.deepEqual(r.contacts.map((x) => x.id), ["a", "c"]);
  assert.equal(r.truncated, false);
});

test("contactsByTag: stops at TAG_SCAN_MAX_PAGES and reports truncated", async () => {
  assert.equal(TAG_SCAN_MAX_PAGES, 5);
  let n = 0;
  const list = async () => okPage([c(`p${n++}`, ["vip"])], `next${n}`);
  const r = await contactsByTag(list, "t", "l", "vip");
  assert.equal(n, 5);
  assert.equal(r.contacts.length, 5);
  assert.equal(r.truncated, true);
});

test("contactsByTag: upstream failure returns what it has, truncated true", async () => {
  let n = 0;
  const list = async () => (n++ === 0 ? okPage([c("a", ["vip"])], "a") : ({ ok: false, kind: "rate_limited", error: "x" }) as ListGhlContactsResult);
  const r = await contactsByTag(list, "t", "l", "vip");
  assert.equal(r.contacts.length, 1);
  assert.equal(r.truncated, true);
});

test("tagsFrom: unique, sorted", () => {
  assert.deepEqual(tagsFrom([c("a", ["b", "a"]), c("b", ["a", "c"])]), ["a", "b", "c"]);
});
