import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GhlRepository } from "@/lib/data/repository";
import { addSentTodayUnits, chooseGroupForContact, SupabaseGhlRepository } from "@/lib/data/supabase";

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
  "listHeldTenantIds",
  "listHeldGhlOutboundMessages",
  "listExpiredHeldGhlOutboundMessages",
  "countHeldByTenant",
  "markGhlOutboundReported",
  "listGhlOutboundAwaitingRead",
  "markGhlOutboundReadReported",
  "recordGhlOutboundAttachments",
  "listGhlOutboundAttachmentsForMessages",
  "updateGhlOutboundAttachmentSendState",
  "getWhatsappMessagesByTenantKeys",
  "getUnprocessedGhlInboundMessages",
  "getInboundBodyByWaMessageId",
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
  "recordCreatedWhatsappGroup",
  "renameWhatsappGroup",
  "getGroupInviteTemplate",
  "setGroupInviteTemplate",
  "hasInboundFromPhone",
  "getWhatsappGroupByContact",
  "setWhatsappGroupContact",
  "getAccountById",
  "getAccountByStripeCustomerId",
  "createAccount",
  "updateAccountBilling",
  "listAccountsForAdmin",
  "listAccountsCancelledBefore",
  "createProfile",
  "getProfileByEmail",
  "listGhlAccountsForAccount",
  "claimGhlAccount",
  "setGhlActivated",
  "countActivatedForAccount",
  "countActivatedAll",
  "getWhatsappSessionSummariesForTenants",
  "getLocationStats",
  "recordStripeEvent",
  "deleteStripeEvent",
  "recordOptOut",
  "clearOptOut",
  "isOptedOut",
  "countOptOutsByTenant",
] as const;

test("SupabaseGhlRepository implements all 73 GhlRepository methods", () => {
  assert.equal(METHODS.length, 73);
  assert.equal(new Set(METHODS).size, 73);
  for (const name of METHODS) {
    assert.equal(typeof SupabaseGhlRepository.prototype[name], "function", `missing method ${name}`);
  }
});

test("SupabaseGhlRepository exposes no methods beyond the 73", () => {
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

test("the owner health snapshot maps every number's tenant to its location", () => {
  const body = methodSource("getGhlHealthSnapshot");
  assert.match(body, /listAllLocationNumberTenants\(/);
  assert.match(body, /tenantIds: tenantIdsByLocation\.get\(/);
});

test("Sends today counts a group send as 5 units and a 1:1 send as 1, with or without the group_jid column", () => {
  const counts = new Map<string, number>();
  addSentTodayUnits(counts, [
    { coach_id: "a", group_jid: null },
    { coach_id: "a", group_jid: "120363000000000001@g.us" },
    { coach_id: "a" }, // a database before 0008 has no group_jid column
    { coach_id: "b", group_jid: "120363000000000002@g.us" },
  ]);
  addSentTodayUnits(counts, [{ coach_id: "b", group_jid: null }]);
  assert.equal(counts.get("a"), 7);
  assert.equal(counts.get("b"), 6);
});

function groupRow(tenantId: string, overrides: Partial<{ enabled: boolean; leftAt: string | null }> = {}) {
  return { tenantId, groupJid: "120363000000000001@g.us", name: "G", enabled: true, ghlContactId: "c-1", leftAt: null, ...overrides };
}

test("chooseGroupForContact: a group of one of the location's numbers wins, enabled and still-a-member first", () => {
  const picked = chooseGroupForContact(
    [groupRow("t-2", { enabled: false }), groupRow("t-1", { leftAt: "2026-10-01T00:00:00Z" }), groupRow("t-3")],
    new Set(["t-1", "t-2", "t-3"]),
    new Set()
  );
  assert.deepEqual(picked, { tenantId: "t-3", groupJid: "120363000000000001@g.us", enabled: true, left: false });
});

test("chooseGroupForContact: a group of a removed number (no longer any location's number) comes back switched off and flagged", () => {
  const picked = chooseGroupForContact([groupRow("t-removed")], new Set(["t-1"]), new Set());
  assert.deepEqual(picked, { tenantId: "t-removed", groupJid: "120363000000000001@g.us", enabled: false, left: false, numberRemoved: true });
});

test("chooseGroupForContact: a group of another location's current number is not this contact's group", () => {
  assert.equal(chooseGroupForContact([groupRow("t-elsewhere")], new Set(["t-1"]), new Set(["t-elsewhere"])), null);
  assert.equal(chooseGroupForContact([], new Set(["t-1"]), new Set()), null);
});

test("removeLocationNumber switches off the removed number's groups", () => {
  const body = methodSource("removeLocationNumber");
  assert.match(body, /from\("whatsapp_groups"\)\s*\.update\(\{ enabled: false \}\)\s*\.eq\("tenant_id", target\.tenantId\)/);
});
