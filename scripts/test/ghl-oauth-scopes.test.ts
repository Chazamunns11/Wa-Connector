import test from "node:test";
import assert from "node:assert/strict";
import { ghlOAuthScopes } from "../../src/lib/ghl";

test("oauth scopes: workflows.readonly only when workflow triggers are on", () => {
  const before = process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
  try {
    delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
    assert.equal(ghlOAuthScopes().includes("workflows.readonly"), false);
    process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = "true";
    assert.equal(ghlOAuthScopes().includes("workflows.readonly"), true);
    assert.ok(ghlOAuthScopes().includes("conversations/message.write"));
  } finally {
    if (before === undefined) delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
    else process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = before;
  }
});
