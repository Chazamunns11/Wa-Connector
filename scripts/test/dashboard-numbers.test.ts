/**
 * Dashboard number management (agency owners): `ownsLocation` and
 * `runOwnedNumberAction` in src/lib/site/owned-whatsapp.ts. Every dashboard
 * number action goes through these, so an agency can only ever touch numbers
 * on its OWN sub-accounts, addressed by slot, never by tenant id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NOT_FOUND, ownsLocation, runOwnedNumberAction, type OwnedNumbersRepo } from "@/lib/site/owned-whatsapp";

function fakeRepo(): { repo: OwnedNumbersRepo; lookups: string[] } {
  const lookups: string[] = [];
  const owned: Record<string, string[]> = { "acc-1": ["loc-1"], "acc-2": ["loc-2"] };
  const numbers: Record<string, Record<number, string>> = { "loc-1": { 1: "tenant-1a", 2: "tenant-1b" }, "loc-2": { 1: "tenant-2a" } };
  const repo = {
    async listGhlAccountsForAccount(accountId: string) {
      return (owned[accountId] ?? []).map((locationId) => ({ locationId, tenantId: numbers[locationId][1] }));
    },
    async getLocationNumberBySlot(locationId: string, slot: number) {
      lookups.push(`${locationId}:${slot}`);
      const tenantId = numbers[locationId]?.[slot];
      return tenantId ? { tenantId, slot, isDefault: slot === 1, label: null } : null;
    },
  } as unknown as OwnedNumbersRepo;
  return { repo, lookups };
}

test("ownsLocation: true only for the account's own sub-accounts", async () => {
  const { repo } = fakeRepo();
  assert.equal(await ownsLocation(repo, "acc-1", "loc-1"), true);
  assert.equal(await ownsLocation(repo, "acc-1", "loc-2"), false);
  assert.equal(await ownsLocation(repo, "acc-unknown", "loc-1"), false);
});

test("runOwnedNumberAction: acts on the slot's own number of an owned sub-account", async () => {
  const { repo } = fakeRepo();
  const seen: string[] = [];
  const result = await runOwnedNumberAction(repo, "acc-1", "loc-1", 2, async (tenantId) => {
    seen.push(tenantId);
    return { ok: true as const };
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, ["tenant-1b"]);
});

test("runOwnedNumberAction: another agency's sub-account is NOT_FOUND, and its numbers are never even looked up", async () => {
  const { repo, lookups } = fakeRepo();
  let called = false;
  const result = await runOwnedNumberAction(repo, "acc-1", "loc-2", 1, async () => {
    called = true;
    return { ok: true as const };
  });
  assert.equal(result, NOT_FOUND);
  assert.equal(called, false);
  assert.deepEqual(lookups, []);
});

test("runOwnedNumberAction: an empty slot on an owned sub-account is NOT_FOUND, nothing called", async () => {
  const { repo } = fakeRepo();
  let called = false;
  const result = await runOwnedNumberAction(repo, "acc-1", "loc-1", 3, async () => {
    called = true;
    return { ok: true as const };
  });
  assert.equal(result, NOT_FOUND);
  assert.equal(called, false);
});
