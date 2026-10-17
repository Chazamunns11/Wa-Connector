import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GhlRepository } from "@/lib/data/repository";
import { SupabaseGhlRepository } from "@/lib/data/supabase";

// Type-level: the Supabase implementation must satisfy the whole contract.
const _check: GhlRepository = {} as import("@/lib/data/supabase").SupabaseGhlRepository;
void _check;

const METHODS = [
  "getGhlAccountByLocationId",
  "getGhlAccountByTenantId",
  "listLocationNumbers",
  "getLocationNumberBySlot",
  "addLocationNumber",
  "removeLocationNumber",
  "setDefaultLocationNumber",
  "setLocationNumberLabel",
  "getStickyTenant",
  "recordInboundForStickiness",
  "getGhlAccounts",
  "upsertGhlAccount",
  "updateGhlAccountBranding",
  "createGhlTenant",
  "saveGhlTokens",
  "markGhlNeedsReauth",
  "claimGhlTokenRefresh",
  "bumpGhlConnectLinkVersion",
  "recordGhlOutboundMessage",
  "updateGhlOutboundSendState",
  "listUnreportedGhlOutboundMessages",
  "markGhlOutboundReported",
  "recordGhlOutboundAttachments",
  "listGhlOutboundAttachmentsForMessages",
  "updateGhlOutboundAttachmentSendState",
  "getWhatsappMessagesByTenantKeys",
  "getUnprocessedGhlInboundMessages",
  "claimWhatsappInboundMessage",
  "resolveGhlInboundMessage",
  "recordGhlInboundPushFailure",
  "purgeOldWhatsappInboundMessages",
  "createWhatsappMediaSignedUrl",
  "getWhatsappSessionSummary",
  "getWhatsappSessionSummaries",
  "getGhlHealthSnapshot",
  "listWhatsappGroups",
  "setWhatsappGroupEnabled",
  "markWhatsappGroupLeft",
  "getWhatsappGroupByContact",
  "setWhatsappGroupContact",
] as const;

test("SupabaseGhlRepository implements all 40 GhlRepository methods", () => {
  assert.equal(METHODS.length, 40);
  assert.equal(new Set(METHODS).size, 40);
  for (const name of METHODS) {
    assert.equal(typeof SupabaseGhlRepository.prototype[name], "function", `missing method ${name}`);
  }
});

test("SupabaseGhlRepository exposes no methods beyond the 40", () => {
  const own = Object.getOwnPropertyNames(SupabaseGhlRepository.prototype).filter((n) => n !== "constructor");
  assert.deepEqual([...own].sort(), [...METHODS].sort());
});

test("importing the repo and constructing it does not require Supabase env (client is lazy)", async () => {
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const { repo } = await import("@/lib/data");
    assert.ok(repo instanceof SupabaseGhlRepository);
    await assert.rejects(() => repo.getGhlAccounts(), /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
});

test("getWhatsappSessionSummaries: non-owner scope resolves to [] without querying (no Supabase env needed)", async () => {
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = new SupabaseGhlRepository();
    // A query would throw on the missing env; resolving to [] proves none was attempted.
    assert.deepEqual(await r.getWhatsappSessionSummaries({ role: "account" }), []);
    assert.deepEqual(await r.getWhatsappSessionSummaries({ role: "client" } as never), []);
    await assert.rejects(() => r.getWhatsappSessionSummaries({ role: "owner" }), /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
});

/** The body of one `async name(` method of SupabaseGhlRepository, up to the next method. */
function methodSource(name: string): string {
  const source = readFileSync(new URL("../../src/lib/data/supabase.ts", import.meta.url), "utf8");
  const start = source.indexOf(`  async ${name}(`);
  assert.ok(start >= 0, `method ${name} not found`);
  const next = source.indexOf("\n  async ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test("the GHL inbound drain fences on every number of each active location, not only the default", () => {
  const body = methodSource("getUnprocessedGhlInboundMessages");
  assert.match(body, /listAllLocationNumberTenants\(/);
  assert.match(body, /locationTenantIds\(/);
  assert.match(body, /\.in\("coach_id", activeTenantIds\)/);
});
