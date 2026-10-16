import test from "node:test";
import assert from "node:assert/strict";
import type { GhlRepository } from "@/lib/data/repository";
import { SupabaseGhlRepository } from "@/lib/data/supabase";

// Type-level: the Supabase implementation must satisfy the whole contract.
const _check: GhlRepository = {} as import("@/lib/data/supabase").SupabaseGhlRepository;
void _check;

const METHODS = [
  "getGhlAccountByLocationId",
  "getGhlAccountByTenantId",
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
] as const;

test("SupabaseGhlRepository implements all 27 GhlRepository methods", () => {
  assert.equal(METHODS.length, 27);
  assert.equal(new Set(METHODS).size, 27);
  for (const name of METHODS) {
    assert.equal(typeof SupabaseGhlRepository.prototype[name], "function", `missing method ${name}`);
  }
});

test("SupabaseGhlRepository exposes no methods beyond the 27", () => {
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
