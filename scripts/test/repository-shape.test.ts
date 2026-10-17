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
  "clearStaleOutboundPendingText",
  "getTenantPhone",
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
  "setMessageEventSettings",
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
  "upsertTriggerSubscription",
  "deleteTriggerSubscription",
  "listTriggerSubscriptions",
  "listLocationsWithTriggerKeys",
  "rememberNotOnWhatsapp",
  "isRememberedNotOnWhatsapp",
  "forgetNotOnWhatsapp",
  "setSessionTriggerState",
  "stampSessionTriggerPhone",
  "listSessionsForTriggers",
  "recordSmsFallbackEcho",
  "markSmsFallbackEchoSent",
  "findSmsFallbackEcho",
  "deleteSmsFallbackEcho",
  "purgeExpiredSmsFallbackEchoes",
  "blockSmsFallback",
  "setSmsFallbackEnabled",
  "claimSmsFallback",
  "setSmsFallbackResult",
  "failSmsFallback",
  "getGhlOutboundMessage",
] as const;

test("SupabaseGhlRepository implements all 97 GhlRepository methods", () => {
  assert.equal(METHODS.length, 97);
  assert.equal(new Set(METHODS).size, 97);
  for (const name of METHODS) {
    assert.equal(typeof SupabaseGhlRepository.prototype[name], "function", `missing method ${name}`);
  }
});

test("SupabaseGhlRepository exposes no methods beyond the 97", () => {
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

test("clearStaleOutboundPendingText clears only accepted, never-reported rows older than the cutoff", () => {
  const body = methodSource("clearStaleOutboundPendingText");
  assert.match(body, /\.update\(\{ pending_text: null \}\)/);
  assert.match(body, /\.eq\("send_state", "accepted"\)/);
  assert.match(body, /\.is\("reported_status", null\)/);
  assert.match(body, /\.lt\("created_at", olderThanIso\)/);
});

test("markGhlOutboundReported clears the kept text only when a status is stored", () => {
  const body = methodSource("markGhlOutboundReported");
  assert.match(body, /if \(patch\.reportedStatus !== null\) \{[\s\S]*update\.pending_text = null;[\s\S]*\}[\s\S]*const \{ data, error \}/);
});

test("markGhlOutboundReported only writes an unreported row and says whether it won", () => {
  const body = methodSource("markGhlOutboundReported");
  assert.match(body, /\.eq\("id", id\)\s*\.is\("reported_status", null\)\s*\.select\("id"\)/);
  assert.match(body, /return \(data \?\? \[\]\)\.length > 0;/);
});

test("getTenantPhone reads only the phone column of the tenant's session", () => {
  const body = methodSource("getTenantPhone");
  assert.match(body, /select\("phone_number"\)/);
  assert.match(body, /\.eq\("coach_id", tenantId\)/);
});

test("updateGhlOutboundSendState clears the text on accept unless workflow triggers or the SMS fallback are on", () => {
  const body = methodSource("updateGhlOutboundSendState");
  assert.match(
    body,
    /if \(patch\.sendState === "refused" \|\| \(patch\.sendState === "accepted" && !isWorkflowTriggersEnabled\(\) && !isSmsFallbackEnabled\(\)\)\) update\.pending_text = null;/
  );
});

test("recordSmsFallbackEcho: one echo per (location, contact), a conditional insert that says whether the cooldown was free", () => {
  const body = methodSource("recordSmsFallbackEcho");
  assert.match(body, /from\("ghl_sms_fallback_echoes"\)/);
  // Only this contact's expired echo is cleared first, so an unexpired one blocks the insert.
  assert.match(body, /\.delete\(\)\s*\.eq\("location_id", echo\.locationId\)\s*\.eq\("contact_id", echo\.contactId\)\s*\.lte\("expires_at", nowIso\)/);
  assert.match(
    body,
    /\{\s*location_id: echo\.locationId,\s*contact_id: echo\.contactId,\s*text_sha256: echo\.textSha256,\s*outbound_message_id: echo\.outboundMessageId,\s*ghl_message_id: null,\s*sent_at: null,\s*expires_at: echo\.expiresIso,\s*\}/
  );
  assert.match(body, /onConflict: "location_id,contact_id", ignoreDuplicates: true/);
  assert.match(body, /return \(data \?\? \[\]\)\.length > 0;/);
  assert.doesNotMatch(body, /message:|text:/);
});

test("markSmsFallbackEchoSent stamps sent_at and GHL's message id on that row's echo only", () => {
  const body = methodSource("markSmsFallbackEchoSent");
  assert.match(
    body,
    /\.update\(\{ sent_at: new Date\(\)\.toISOString\(\), ghl_message_id: ghlMessageId \}\)\s*\.eq\("location_id", locationId\)\s*\.eq\("contact_id", contactId\)\s*\.eq\("outbound_message_id", outboundMessageId\)/
  );
});

test("findSmsFallbackEcho reads one unexpired echo by its key", () => {
  const body = methodSource("findSmsFallbackEcho");
  assert.match(body, /\.select\("text_sha256, outbound_message_id, ghl_message_id, sent_at, expires_at"\)\s*\.eq\("location_id", locationId\)\s*\.eq\("contact_id", contactId\)\s*\.gt\("expires_at", nowIso\)/);
});

test("deleteSmsFallbackEcho deletes only the echo it read and says whether it did", () => {
  const body = methodSource("deleteSmsFallbackEcho");
  assert.match(body, /\.delete\(\)\s*\.eq\("location_id", locationId\)\s*\.eq\("contact_id", contactId\)\s*\.eq\("outbound_message_id", outboundMessageId\)\s*\.select\("location_id"\)/);
  assert.match(body, /return \(data \?\? \[\]\)\.length > 0;/);
});

test("purgeExpiredSmsFallbackEchoes deletes every expired echo", () => {
  const body = methodSource("purgeExpiredSmsFallbackEchoes");
  assert.match(body, /from\("ghl_sms_fallback_echoes"\)\s*\.delete\(\)\s*\.lte\("expires_at", nowIso\)\s*\.select\("location_id"\)/);
});

test("failSmsFallback marks a claimed or sent row failed (the loop guard's correction)", () => {
  const body = methodSource("failSmsFallback");
  assert.match(body, /\.update\(\{ sms_fallback: "failed" \}\)\s*\.eq\("id", id\)\s*\.in\("sms_fallback", \["claimed", "sent"\]\)\s*\.select\("id"\)/);
  assert.match(body, /return \(data \?\? \[\]\)\.length > 0;/);
});

test("getGhlOutboundMessage reads one row by id", () => {
  const body = methodSource("getGhlOutboundMessage");
  assert.match(body, /from\("ghl_outbound_messages"\)\s*\.select\("\*"\)\s*\.eq\("id", id\)\s*\.maybeSingle\(\)/);
  assert.match(body, /mapGhlOutboundMessage\(/);
});

test("blockSmsFallback stamps blocked_at on this sub-account only", () => {
  const body = methodSource("blockSmsFallback");
  assert.match(body, /from\("ghl_accounts"\)\s*\.update\(\{ sms_fallback_blocked_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("location_id", locationId\)\s*\.is\("sms_fallback_blocked_at", null\)/);
});

test("setSmsFallbackEnabled clears blocked_at only when switching on", () => {
  const body = methodSource("setSmsFallbackEnabled");
  assert.match(body, /const patch: Record<string, unknown> = \{ sms_fallback_enabled: enabled \};/);
  assert.match(body, /if \(enabled\) patch\.sms_fallback_blocked_at = null;/);
  assert.match(body, /\.update\(patch\)\s*\.eq\("location_id", locationId\)/);
});

test("claimSmsFallback wins only for a row never claimed and still unreported", () => {
  const body = methodSource("claimSmsFallback");
  assert.match(
    body,
    /\.update\(\{ sms_fallback: "claimed", sms_fallback_claimed_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("id", id\)\s*\.is\("sms_fallback", null\)\s*\.is\("reported_status", null\)\s*\.select\("id"\)/
  );
  assert.match(body, /return \(data \?\? \[\]\)\.length > 0;/);
});

test("setSmsFallbackResult writes only a claimed row", () => {
  const body = methodSource("setSmsFallbackResult");
  assert.match(body, /\.update\(\{ sms_fallback: result \}\)\s*\.eq\("id", id\)\s*\.eq\("sms_fallback", "claimed"\)/);
});

test("0014: the SMS fallback switch is on by default, blocked_at is nullable, the echo table holds only a hash and has RLS on with no policies", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0014_sms_fallback.sql", import.meta.url), "utf8");
  assert.match(sql, /add column if not exists sms_fallback_enabled boolean not null default true/);
  assert.match(sql, /add column if not exists sms_fallback_blocked_at timestamptz(,|;)/);
  assert.match(sql, /add column if not exists sms_fallback text\s+check \(sms_fallback is null or sms_fallback in \('claimed', 'sent', 'failed'\)\)/);
  assert.match(sql, /add column if not exists sms_fallback_claimed_at timestamptz/);
  assert.match(sql, /outbound_message_id\s+uuid not null references public\.ghl_outbound_messages \(id\) on delete cascade/);
  assert.match(sql, /ghl_message_id\s+text,/);
  assert.match(sql, /sent_at\s+timestamptz,/);
  assert.match(sql, /create index ghl_sms_fallback_echoes_expires_idx on public\.ghl_sms_fallback_echoes \(expires_at\)/);
  assert.match(sql, /create table public\.ghl_sms_fallback_echoes \(/);
  assert.match(sql, /location_id\s+text not null references public\.ghl_accounts \(location_id\) on delete cascade/);
  assert.match(sql, /contact_id\s+text not null/);
  assert.match(sql, /text_sha256\s+text not null/);
  assert.match(sql, /expires_at\s+timestamptz not null/);
  assert.match(sql, /primary key \(location_id, contact_id\)\n/);
  assert.match(sql, /alter table public\.ghl_sms_fallback_echoes enable row level security/);
  assert.doesNotMatch(sql, /create policy/);
});

test("the hourly cron purges expired SMS fallback echoes, best effort", () => {
  const src = readFileSync(new URL("../../src/app/api/cron/drain/route.ts", import.meta.url), "utf8");
  assert.match(src, /try \{\s*const purgedEchoes = await repo\.purgeExpiredSmsFallbackEchoes\(new Date\(\)\.toISOString\(\)\);/);
});
