/**
 * Agency (bulk) installs, migration 0017 — `resolveGhlAccessToken` for a
 * location installed from the agency chooser. HighLevel's locationToken
 * response has no refresh token (apps/oauth.json), so such a location's
 * token is re-minted from the stored agency token in `ghl_companies`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveGhlAccessToken, type GhlTokenRefreshDeps, type GhlTokenRefreshRepo } from "@/lib/ghl-provider";
import type { GhlAccount, GhlCompany } from "@/lib/types";

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + HOUR).toISOString();
const past = () => new Date(Date.now() - HOUR).toISOString();

function account(overrides: Partial<GhlAccount> = {}): GhlAccount {
  return {
    locationId: "fiIgfPVIACqCyVDiDRuT",
    tenantId: "tenant-1",
    label: "Master Template",
    companyId: "company-1",
    conversationProviderId: null,
    accessToken: "old-location-token",
    accessTokenExpiresAt: past(),
    refreshToken: null,
    status: "active",
    lastError: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  } as GhlAccount;
}

function company(overrides: Partial<GhlCompany> = {}): GhlCompany {
  return {
    companyId: "company-1",
    accessToken: "agency-token",
    accessTokenExpiresAt: future(),
    refreshToken: "agency-refresh-1",
    scope: "oauth.readonly oauth.write",
    status: "active",
    lastError: null,
    ...overrides,
  };
}

function fakes(seed: GhlCompany | null, depOverrides: Partial<GhlTokenRefreshDeps> = {}) {
  let stored = seed;
  const calls: string[] = [];
  const saved: { locationId: string; refreshToken: string | null; accessToken: string }[] = [];
  const repo = {
    async getGhlAccountByLocationId() {
      return null;
    },
    async claimGhlTokenRefresh() {
      calls.push("claimLocation");
      return true;
    },
    async saveGhlTokens(locationId: string, t: { accessToken: string; refreshToken: string | null }) {
      saved.push({ locationId, refreshToken: t.refreshToken, accessToken: t.accessToken });
    },
    async markGhlNeedsReauth(locationId: string, reason: string) {
      calls.push(`needsReauth:${locationId}:${reason}`);
    },
    async getGhlCompany() {
      return stored;
    },
    async claimGhlCompanyTokenRefresh() {
      calls.push("claimCompany");
      return true;
    },
    async saveGhlCompanyTokens(_companyId: string, t: { accessToken: string; accessTokenExpiresAt: string; refreshToken: string }) {
      calls.push(`saveCompany:${t.refreshToken}`);
      if (stored) stored = { ...stored, ...t };
    },
    async markGhlCompanyNeedsReauth() {
      calls.push("companyNeedsReauth");
    },
  } as unknown as GhlTokenRefreshRepo;
  const minted: string[] = [];
  const deps: GhlTokenRefreshDeps = {
    refreshToken: async () => {
      throw new Error("a location refresh must never run for an agency-minted location");
    },
    refreshCompanyToken: async () => ({
      ok: true,
      tokens: { accessToken: "agency-token-2", refreshToken: "agency-refresh-2", expiresAt: future(), locationId: null, companyId: "company-1" },
    }),
    mintLocationToken: async (agencyToken, companyId, locationId) => {
      minted.push(`${agencyToken}:${companyId}:${locationId}`);
      return { ok: true, tokens: { accessToken: "new-location-token", refreshToken: null, expiresAt: future(), locationId, companyId } };
    },
    refreshWaitMs: 1,
    notify: () => {},
    ...depOverrides,
  };
  return { repo, deps, calls, saved, minted };
}

test("agency-minted location: an expired token is re-minted from a fresh agency token, no refresh spent", async () => {
  const f = fakes(company());
  const token = await resolveGhlAccessToken(f.repo, f.deps, account());
  assert.equal(token, "new-location-token");
  assert.deepEqual(f.minted, ["agency-token:company-1:fiIgfPVIACqCyVDiDRuT"]);
  assert.deepEqual(f.saved, [{ locationId: "fiIgfPVIACqCyVDiDRuT", refreshToken: null, accessToken: "new-location-token" }]);
  assert.ok(!f.calls.includes("claimCompany"), "a fresh agency token needs no refresh");
});

test("agency-minted location: an expired agency token is refreshed first (single-flight), the rotated refresh token saved", async () => {
  const f = fakes(company({ accessTokenExpiresAt: past() }));
  const token = await resolveGhlAccessToken(f.repo, f.deps, account());
  assert.equal(token, "new-location-token");
  assert.ok(f.calls.includes("claimCompany"));
  assert.ok(f.calls.includes("saveCompany:agency-refresh-2"));
  assert.deepEqual(f.minted, ["agency-token-2:company-1:fiIgfPVIACqCyVDiDRuT"]);
});

test("agency-minted location: a still-fresh location token is used as-is", async () => {
  const f = fakes(company());
  const token = await resolveGhlAccessToken(f.repo, f.deps, account({ accessToken: "still-good", accessTokenExpiresAt: future() }));
  assert.equal(token, "still-good");
  assert.deepEqual(f.minted, []);
});

test("agency-minted location: HighLevel rejecting the agency refresh token marks both needs_reauth", async () => {
  const f = fakes(company({ accessTokenExpiresAt: past() }), { refreshCompanyToken: async () => ({ ok: false, kind: "invalid_grant" }) });
  const token = await resolveGhlAccessToken(f.repo, f.deps, account());
  assert.equal(token, null);
  assert.ok(f.calls.includes("companyNeedsReauth"));
  assert.ok(f.calls.some((c) => c.startsWith("needsReauth:fiIgfPVIACqCyVDiDRuT")));
});

test("agency-minted location: a transient agency refresh failure changes no status", async () => {
  const f = fakes(company({ accessTokenExpiresAt: past() }), { refreshCompanyToken: async () => ({ ok: false, kind: "transient" }) });
  const token = await resolveGhlAccessToken(f.repo, f.deps, account());
  assert.equal(token, null);
  assert.ok(!f.calls.some((c) => c.includes("eedsReauth")));
});

test("agency-minted location: a refused mint returns null and leaves the location active (retried next pass)", async () => {
  const f = fakes(company(), { mintLocationToken: async () => ({ ok: false, error: "HighLevel refused a location token: HTTP 401" }) });
  const token = await resolveGhlAccessToken(f.repo, f.deps, account());
  assert.equal(token, null);
  assert.ok(!f.calls.some((c) => c.includes("eedsReauth")));
  assert.deepEqual(f.saved, []);
});

test("agency-minted location: no stored agency token -> needs_reauth (reinstall from the agency), never a crash", async () => {
  const f = fakes(null);
  const token = await resolveGhlAccessToken(f.repo, f.deps, account());
  assert.equal(token, null);
  assert.ok(f.calls.some((c) => c.startsWith("needsReauth:fiIgfPVIACqCyVDiDRuT")));
});

test("agency-minted location: a minted token that does carry a refresh token is saved, making the location self-refreshing", async () => {
  const f = fakes(company(), {
    mintLocationToken: async (_a, companyId, locationId) => ({
      ok: true,
      tokens: { accessToken: "new-location-token", refreshToken: "location-refresh", expiresAt: future(), locationId, companyId },
    }),
  });
  await resolveGhlAccessToken(f.repo, f.deps, account());
  assert.equal(f.saved[0].refreshToken, "location-refresh");
});
