import { test } from "node:test";
import assert from "node:assert/strict";
import { billingHref, dashboardHref, DASHBOARD_RESULT_COPY, parseResult } from "@/lib/site/dashboard-url";

test("dashboardHref: bare, filter, result and focus with the row anchor", () => {
  assert.equal(dashboardHref(), "/dashboard");
  assert.equal(dashboardHref({ filter: "all" }), "/dashboard");
  assert.equal(dashboardHref({ filter: "attention" }), "/dashboard?filter=attention");
  assert.equal(dashboardHref({ result: "activated" }), "/dashboard?result=activated");
  assert.equal(
    dashboardHref({ filter: "attention", result: "trial_cap", focus: "loc_1" }),
    "/dashboard?filter=attention&result=trial_cap&focus=loc_1#row-loc_1",
  );
});

test("billingHref is the billing page", () => {
  assert.equal(billingHref(), "/dashboard/billing");
});

test("every result has fixed copy and parseResult rejects unknown values", () => {
  for (const k of ["activated", "deactivated", "disconnected", "link", "trial_cap", "platform_cap", "billing_inactive", "stripe_failed", "not_found"] as const) {
    assert.ok(DASHBOARD_RESULT_COPY[k].length > 0, k);
    assert.equal(parseResult(k), k);
  }
  assert.equal(parseResult("bogus"), null);
  assert.equal(parseResult(undefined), null);
  assert.equal(parseResult(["activated", "link"]), "activated");
});

test("dashboardHref: an open row keeps the filter and anchors to the row", () => {
  assert.equal(dashboardHref({ open: "loc_1" }), "/dashboard?open=loc_1#row-loc_1");
  assert.equal(dashboardHref({ filter: "attention", open: "loc_1" }), "/dashboard?filter=attention&open=loc_1#row-loc_1");
});
