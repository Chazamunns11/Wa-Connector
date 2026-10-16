/**
 * `src/app/api/crm/oauth/callback/logic.ts` — the install/reinstall write for
 * one GHL location (`installGhlLocation`) and the bulk-install loop built on
 * top of it (`runGhlBulkInstall`), the 4 Aug 2026 fix for the production
 * `no_location` bug (see `route.ts`'s own header and `src/lib/ghl.ts`'s
 * `GhlExchangeResult` JSDoc for the full diagnosis). Entirely offline — a
 * fake repo, no Supabase, no fetch, no `next/headers` (see `logic.ts`'s own
 * header for why that file has zero Next imports in the first place).
 * Mirrors `scripts/test/ghl-health.test.ts`'s shape: pure/deps-injected
 * functions, fixtures via plain object literals, no network stub needed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GHL_BULK_INSTALL_CAP,
  installGhlLocation,
  runGhlBulkInstall,
  type GhlOauthCallbackRepo,
} from "@/app/api/crm/oauth/callback/logic";
import type { GhlTokens } from "@/lib/ghl";

// ---------------------------------------------------------------------------
// Fixtures — a minimal fake `GhlOauthCallbackRepo`. Deliberately a PARTIAL
// `GhlAccount` shape on `getGhlAccountByLocationId`'s return (only the three
// fields `installGhlLocation` actually reads: `tenantId`/`label`, plus
// `locationId` for the map key) — this file sits under `scripts/` and is
// excluded from `npx tsc --noEmit` for exactly this reason (see
// tsconfig.json's own comment on `scripts` under `exclude`); Node's type
// stripping never checks it, only runs it.
// ---------------------------------------------------------------------------

interface FakeRow {
  locationId: string;
  tenantId: string;
  label: string;
}

interface UpsertCall {
  locationId: string;
  tenantId: string;
  label: string;
  companyId: string | null;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
}

function createFakeRepo(seed: FakeRow[] = []): {
  repo: GhlOauthCallbackRepo;
  byLocation: Map<string, FakeRow>;
  upsertCalls: UpsertCall[];
  createTenantCalls: number;
} {
  const byLocation = new Map(seed.map((r) => [r.locationId, r]));
  const upsertCalls: UpsertCall[] = [];
  let createTenantCalls = 0;
  let nextTenantId = 1;
  const repo = {
    async getGhlAccountByLocationId(locationId: string) {
      const row = byLocation.get(locationId);
      // Only the fields `installGhlLocation` reads — see this file's own
      // header on why a deliberately partial shape is fine here.
      return row ? ({ locationId: row.locationId, tenantId: row.tenantId, label: row.label } as unknown as Awaited<ReturnType<GhlOauthCallbackRepo["getGhlAccountByLocationId"]>>) : null;
    },
    async upsertGhlAccount(draft: UpsertCall) {
      upsertCalls.push(draft);
      byLocation.set(draft.locationId, { locationId: draft.locationId, tenantId: draft.tenantId, label: draft.label });
    },
    async createGhlTenant() {
      createTenantCalls++;
      return `tenant-${nextTenantId++}`;
    },
  } as unknown as GhlOauthCallbackRepo;
  return { repo, byLocation, upsertCalls, createTenantCalls };
}

function makeTokens(overrides: Partial<GhlTokens> = {}): GhlTokens {
  return {
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    locationId: "loc-1",
    companyId: "company-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// installGhlLocation
// ---------------------------------------------------------------------------

test("installGhlLocation: a genuinely new location mints a tenant and upserts, returns true", async () => {
  const bundle = createFakeRepo([]);
  const ok = await installGhlLocation(bundle.repo, makeTokens({ locationId: "loc-new" }));
  assert.equal(ok, true);
  assert.equal(bundle.upsertCalls.length, 1);
  assert.equal(bundle.upsertCalls[0].locationId, "loc-new");
  assert.equal(bundle.upsertCalls[0].tenantId, "tenant-1", "a genuinely new location must mint a fresh tenant");
  assert.equal(bundle.upsertCalls[0].label, "GHL location loc-new", "no existing row -> the location-id placeholder label");
});

test("installGhlLocation: a reinstall of a KNOWN location reuses the existing tenantId and label, never mints a second tenant", async () => {
  const bundle = createFakeRepo([{ locationId: "loc-1", tenantId: "tenant-existing", label: "Charlie's own label" }]);
  const ok = await installGhlLocation(bundle.repo, makeTokens({ locationId: "loc-1" }));
  assert.equal(ok, true);
  assert.equal(bundle.upsertCalls[0].tenantId, "tenant-existing");
  assert.equal(bundle.upsertCalls[0].label, "Charlie's own label", "a reinstall must never overwrite an existing label back to the placeholder");
});

// ---------------------------------------------------------------------------
// LABEL PRECEDENCE — existing label > GHL's business name > id placeholder.
//
// The middle rung is why the bulk path bothers reading
// `oauth/installedLocations` at all. Without it, a run that onboards a dozen
// sub-accounts lands a dozen rows called "GHL location <opaque id>" and the
// operator has to identify each one by hand afterwards — which happened for
// real on 4 Aug 2026 before this was wired up.
// ---------------------------------------------------------------------------

test("installGhlLocation: a new location uses GHL's business name when the caller supplies one", async () => {
  const bundle = createFakeRepo([]);
  const ok = await installGhlLocation(bundle.repo, makeTokens({ locationId: "loc-new" }), "12X Coaching");
  assert.equal(ok, true);
  assert.equal(bundle.upsertCalls[0].label, "12X Coaching", "GHL's own name must beat the id placeholder");
});

test("installGhlLocation: an existing label beats GHL's business name", async () => {
  const bundle = createFakeRepo([{ locationId: "loc-1", tenantId: "tenant-existing", label: "Charlie's own label" }]);
  await installGhlLocation(bundle.repo, makeTokens({ locationId: "loc-1" }), "12X Coaching");
  assert.equal(
    bundle.upsertCalls[0].label,
    "Charlie's own label",
    "a bulk re-run must never overwrite a name the owner typed themselves"
  );
});

test("installGhlLocation: a blank or whitespace-only name falls through to the placeholder, never a blank label", async () => {
  for (const blank of ["", "   ", "\t\n"]) {
    const bundle = createFakeRepo([]);
    await installGhlLocation(bundle.repo, makeTokens({ locationId: "loc-blank" }), blank);
    assert.equal(
      bundle.upsertCalls[0].label,
      "GHL location loc-blank",
      `a ${JSON.stringify(blank)} name must not produce a blank row in the owner panel`
    );
  }
});

test("installGhlLocation: a null name behaves exactly as an omitted one", async () => {
  const bundle = createFakeRepo([]);
  await installGhlLocation(bundle.repo, makeTokens({ locationId: "loc-null" }), null);
  assert.equal(bundle.upsertCalls[0].label, "GHL location loc-null");
});

test("installGhlLocation: tokens missing locationId return false without touching the repo", async () => {
  const bundle = createFakeRepo([]);
  const ok = await installGhlLocation(bundle.repo, makeTokens({ locationId: null }));
  assert.equal(ok, false);
  assert.equal(bundle.upsertCalls.length, 0);
});

test("installGhlLocation: tokens missing refreshToken return false without touching the repo", async () => {
  const bundle = createFakeRepo([]);
  const ok = await installGhlLocation(bundle.repo, makeTokens({ refreshToken: null }));
  assert.equal(ok, false);
  assert.equal(bundle.upsertCalls.length, 0);
});

test("installGhlLocation: a repo write that throws is caught and returns false, never throws", async () => {
  const bundle = createFakeRepo([]);
  bundle.repo.upsertGhlAccount = async () => {
    throw new Error("simulated transient Supabase error");
  };
  await assert.doesNotReject(async () => {
    const ok = await installGhlLocation(bundle.repo, makeTokens());
    assert.equal(ok, false);
  });
});

// ---------------------------------------------------------------------------
// runGhlBulkInstall
// ---------------------------------------------------------------------------

function loc(locationId: string, name: string | null = null) {
  return { locationId, name };
}

test("runGhlBulkInstall: every location succeeds -> installed matches, failed is zero, batch completes", async () => {
  const bundle = createFakeRepo([]);
  const locations = [loc("loc-1"), loc("loc-2"), loc("loc-3")];
  const result = await runGhlBulkInstall(
    bundle.repo,
    { getLocationToken: async (_companyId, locationId) => makeTokens({ locationId }) },
    "company-1",
    locations
  );
  assert.deepEqual(result, { totalFound: 3, installed: 3, failed: 0, skippedOverCap: 0 });
  assert.equal(bundle.upsertCalls.length, 3);
});

test("runGhlBulkInstall: some locations fail the token exchange (getLocationToken returns null) — counted, never abort the batch", async () => {
  const bundle = createFakeRepo([]);
  const locations = [loc("loc-1"), loc("loc-2"), loc("loc-3"), loc("loc-4")];
  const failing = new Set(["loc-2", "loc-4"]);
  const result = await runGhlBulkInstall(
    bundle.repo,
    { getLocationToken: async (_companyId, locationId) => (failing.has(locationId) ? null : makeTokens({ locationId })) },
    "company-1",
    locations
  );
  assert.equal(result.installed, 2, "a batch where SOME succeeded must say so, not claim total success");
  assert.equal(result.failed, 2);
  assert.equal(result.totalFound, 4);
  assert.equal(result.skippedOverCap, 0);
  // Both non-failing locations were still attempted — the two failures never
  // stopped the loop.
  assert.deepEqual(
    bundle.upsertCalls.map((c) => c.locationId).sort(),
    ["loc-1", "loc-3"]
  );
});

test("runGhlBulkInstall: some locations fail the SAVE (installGhlLocation itself fails) — also counted as failed, batch still completes", async () => {
  const bundle = createFakeRepo([]);
  bundle.repo.upsertGhlAccount = async (draft) => {
    if (draft.locationId === "loc-2") throw new Error("simulated write failure for loc-2 only");
    bundle.upsertCalls.push(draft);
  };
  const locations = [loc("loc-1"), loc("loc-2"), loc("loc-3")];
  const result = await runGhlBulkInstall(
    bundle.repo,
    { getLocationToken: async (_companyId, locationId) => makeTokens({ locationId }) },
    "company-1",
    locations
  );
  assert.equal(result.installed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.totalFound, 3);
});

test("runGhlBulkInstall: zero locations returned -> a completely empty, honest result, never an error", async () => {
  const bundle = createFakeRepo([]);
  const result = await runGhlBulkInstall(bundle.repo, { getLocationToken: async () => makeTokens() }, "company-1", []);
  assert.deepEqual(result, { totalFound: 0, installed: 0, failed: 0, skippedOverCap: 0 });
  assert.equal(bundle.upsertCalls.length, 0);
});

test("runGhlBulkInstall: more locations than the cap -> only `cap` are attempted, the rest are reported as skippedOverCap, never silently dropped", async () => {
  const bundle = createFakeRepo([]);
  const cap = 5;
  const locations = Array.from({ length: cap + 3 }, (_, i) => loc(`loc-${i + 1}`));
  let calls = 0;
  const result = await runGhlBulkInstall(
    bundle.repo,
    {
      getLocationToken: async (_companyId, locationId) => {
        calls++;
        return makeTokens({ locationId });
      },
    },
    "company-1",
    locations,
    cap
  );
  assert.equal(result.totalFound, cap + 3);
  assert.equal(result.installed, cap);
  assert.equal(result.skippedOverCap, 3, "the locations beyond the cap must be visible, not folded into `failed` (that would falsely claim GHL rejected them)");
  assert.equal(calls, cap, "a location beyond the cap must never even be attempted");
});

test("runGhlBulkInstall: with no explicit cap argument, defaults to GHL_BULK_INSTALL_CAP", async () => {
  const bundle = createFakeRepo([]);
  const locations = Array.from({ length: GHL_BULK_INSTALL_CAP + 2 }, (_, i) => loc(`loc-${i + 1}`));
  const result = await runGhlBulkInstall(bundle.repo, { getLocationToken: async (_companyId, locationId) => makeTokens({ locationId }) }, "company-1", locations);
  assert.equal(result.installed, GHL_BULK_INSTALL_CAP);
  assert.equal(result.skippedOverCap, 2);
});

test("runGhlBulkInstall: locations are exchanged SEQUENTIALLY, never overlapping — a slow location must fully finish before the next one starts", async () => {
  const bundle = createFakeRepo([]);
  const events: string[] = [];
  const locations = [loc("loc-1"), loc("loc-2"), loc("loc-3")];
  await runGhlBulkInstall(
    bundle.repo,
    {
      getLocationToken: async (_companyId, locationId) => {
        events.push(`start-${locationId}`);
        // loc-1 deliberately the slowest — if the loop were concurrent,
        // loc-2/loc-3's "start" events would land BEFORE loc-1's "end".
        await new Promise((resolve) => setTimeout(resolve, locationId === "loc-1" ? 20 : 0));
        events.push(`end-${locationId}`);
        return makeTokens({ locationId });
      },
    },
    "company-1",
    locations
  );
  assert.deepEqual(events, ["start-loc-1", "end-loc-1", "start-loc-2", "end-loc-2", "start-loc-3", "end-loc-3"]);
});
