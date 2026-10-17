import { test } from "node:test";
import assert from "node:assert/strict";
import { GroupLimiter } from "../src/groups.js";

test("limiter reserves adds and creates per UTC day and rolls at midnight", () => {
  let t = Date.parse("2026-10-17T23:59:00Z");
  const l = new GroupLimiter({ addBatch: 5, addGapMs: 8000, addJitterMs: 4000, addsDailyCap: 50, createsDailyCap: 3 }, { addsToday: 48, createsToday: 3 }, () => t, () => 0.5);
  assert.equal(l.reserveAdds(3), false);
  assert.equal(l.reserveAdds(2), true);
  assert.equal(l.remainingAddsToday(), 0);
  assert.equal(l.reserveCreate(), false);
  t += 120_000;
  assert.equal(l.remainingAddsToday(), 50);
  assert.equal(l.reserveCreate(), true);
  assert.equal(l.batchGapMs(), 10000);
  assert.deepEqual(l.batches([1, 2, 3, 4, 5, 6, 7]), [[1, 2, 3, 4, 5], [6, 7]]);
});
