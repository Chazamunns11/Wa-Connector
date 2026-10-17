import test from "node:test";
import assert from "node:assert/strict";
import { nextFreeSlot, promoteAfterRemoval, shouldReplaceSticky } from "@/lib/location-numbers";

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
