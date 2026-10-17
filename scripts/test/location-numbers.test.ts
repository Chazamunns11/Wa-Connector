import test from "node:test";
import assert from "node:assert/strict";
import { locationTenantIds, nextFreeSlot, promoteAfterRemoval, shouldReplaceSticky } from "@/lib/location-numbers";

test("nextFreeSlot returns the lowest free slot, or null when full", () => {
  assert.equal(nextFreeSlot([]), 1);
  assert.equal(nextFreeSlot([1]), 2);
  assert.equal(nextFreeSlot([1, 3]), 2);
  assert.equal(nextFreeSlot([2, 3]), 1);
  assert.equal(nextFreeSlot([1, 2]), 3);
  assert.equal(nextFreeSlot([1, 2, 3]), null);
});

test("promoteAfterRemoval promotes the lowest remaining slot only when the default goes", () => {
  const all = [
    { slot: 1, isDefault: true },
    { slot: 2, isDefault: false },
    { slot: 3, isDefault: false },
  ];
  assert.equal(promoteAfterRemoval(all, 1), 2);
  assert.equal(promoteAfterRemoval(all, 2), null);
  assert.equal(promoteAfterRemoval(all, 3), null);
  assert.equal(
    promoteAfterRemoval(
      [
        { slot: 1, isDefault: false },
        { slot: 2, isDefault: true },
        { slot: 3, isDefault: false },
      ],
      2
    ),
    1
  );
});

test("promoteAfterRemoval refuses to remove the only number or an unknown slot", () => {
  assert.throws(() => promoteAfterRemoval([{ slot: 1, isDefault: true }], 1), /last number/);
  assert.throws(() => promoteAfterRemoval(all2(), 3), /not found/);
});

function all2() {
  return [
    { slot: 1, isDefault: true },
    { slot: 2, isDefault: false },
  ];
}

test("shouldReplaceSticky only replaces with a strictly newer inbound", () => {
  assert.equal(shouldReplaceSticky(null, "2026-10-17T10:00:00.000Z"), true);
  assert.equal(shouldReplaceSticky("2026-10-17T09:00:00.000Z", "2026-10-17T10:00:00.000Z"), true);
  assert.equal(shouldReplaceSticky("2026-10-17T10:00:00.000Z", "2026-10-17T10:00:00.000Z"), false);
  assert.equal(shouldReplaceSticky("2026-10-17T11:00:00.000Z", "2026-10-17T10:00:00.000Z"), false);
  // Postgres returns +00:00 offsets; compare instants, not strings.
  assert.equal(shouldReplaceSticky("2026-10-17T10:00:00+00:00", "2026-10-17T10:00:00.000Z"), false);
});

test("locationTenantIds lists every number of each account's location, plus the account tenant", () => {
  const accounts = [
    { locationId: "loc-1", tenantId: "t-default-1" },
    { locationId: "loc-2", tenantId: "t-only-2" },
  ];
  const numbers = [
    { locationId: "loc-1", tenantId: "t-default-1" },
    { locationId: "loc-1", tenantId: "t-slot2-1" },
    { locationId: "loc-1", tenantId: "t-old-default-1" },
    // A number of a location not in `accounts` (e.g. an inactive one) is left out.
    { locationId: "loc-3", tenantId: "t-inactive-3" },
  ];
  const result = locationTenantIds(accounts, numbers);
  assert.deepEqual([...result.keys()], ["loc-1", "loc-2"]);
  assert.deepEqual(result.get("loc-1"), ["t-default-1", "t-slot2-1", "t-old-default-1"]);
  // No number rows yet: the account tenant alone (pre-0003 install).
  assert.deepEqual(result.get("loc-2"), ["t-only-2"]);
});

test("locationTenantIds keeps the account tenant even when the number rows have moved on", () => {
  const result = locationTenantIds([{ locationId: "loc-1", tenantId: "t-a" }], [{ locationId: "loc-1", tenantId: "t-b" }]);
  assert.deepEqual(result.get("loc-1"), ["t-a", "t-b"]);
});
