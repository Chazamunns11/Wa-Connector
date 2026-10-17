import test from "node:test";
import assert from "node:assert/strict";
import { ghlOAuthScopes } from "../../src/lib/ghl";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("oauth scopes: workflows.readonly only when GHL_REQUEST_WORKFLOWS_SCOPE is on", () => {
  withEnv({ GHL_REQUEST_WORKFLOWS_SCOPE: undefined, GHL_WORKFLOW_TRIGGERS_ENABLED: undefined }, () => {
    assert.equal(ghlOAuthScopes().includes("workflows.readonly"), false);
    assert.ok(ghlOAuthScopes().includes("conversations/message.write"));
  });
  withEnv({ GHL_REQUEST_WORKFLOWS_SCOPE: "true", GHL_WORKFLOW_TRIGGERS_ENABLED: undefined }, () => {
    assert.equal(ghlOAuthScopes().includes("workflows.readonly"), true, "requested before firing is on");
    assert.ok(ghlOAuthScopes().includes("conversations/message.write"));
  });
  withEnv({ GHL_REQUEST_WORKFLOWS_SCOPE: "1", GHL_WORKFLOW_TRIGGERS_ENABLED: undefined }, () => {
    assert.equal(ghlOAuthScopes().includes("workflows.readonly"), false, "only exactly \"true\"");
  });
});

test("oauth scopes: the firing flag alone never asks for workflows.readonly", () => {
  withEnv({ GHL_REQUEST_WORKFLOWS_SCOPE: undefined, GHL_WORKFLOW_TRIGGERS_ENABLED: "true" }, () => {
    assert.equal(ghlOAuthScopes().includes("workflows.readonly"), false);
  });
});
