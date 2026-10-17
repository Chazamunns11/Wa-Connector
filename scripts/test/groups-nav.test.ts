import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");

test("app nav: the Groups link exists, is gated on GROUPS_ENABLED === \"true\" and uses the route constant", () => {
  assert.match(layout, /process\.env\.GROUPS_ENABLED === "true"/);
  assert.match(layout, /SITE_ROUTES\.groups/);
  assert.match(layout, /groupsOn && \(/);
});

test("reconcile hooks: both routes call the sweep inside a try/catch that never fails the route", () => {
  for (const f of ["src/app/api/webhooks/crm-outbound-status/route.ts", "src/app/api/cron/drain/route.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /reconcileAllPendingGroupAccounts\(repo, groupsDeps\(\)\)/, f);
    assert.match(src, /catch \(err\) \{[\s\S]*\[groups\] reconcile failed/, f);
  }
});
