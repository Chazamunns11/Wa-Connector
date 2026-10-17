/**
 * The bridge's poke routes run the disconnected / reconnected trigger drain.
 * The bridge's connection pokes (open, close, and the 5 min 15 s follow-up)
 * go to `crm-outbound-status`; `whatsapp-replies` keeps its own wiring. Every
 * drain is mocked: nothing here touches the database, GHL or the network.
 */
import test, { mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SECRET = "poke-secret";
const calls: string[] = [];
let sessionDrainThrows = false;

mock.module("@/lib/data", { namedExports: { repo: { fake: true } } });
mock.module("@/lib/ghl-held", {
  namedExports: { releaseHeldOutboundMessages: async () => { calls.push("release"); return {}; } },
});
mock.module("@/lib/ghl-provider", {
  namedExports: {
    defaultGhlProviderDeps: {},
    drainGhlOutboundStatuses: async () => { calls.push("statuses"); return { delivered: 0 }; },
  },
});
mock.module("@/lib/ghl-inbound", {
  namedExports: { drainGhlInboundReplies: async () => { calls.push("inbound"); return { candidates: 0 }; } },
});
mock.module("@/lib/ghl-triggers", {
  namedExports: {
    defaultTriggerDeps: () => ({}),
    isWorkflowTriggersEnabled: () => process.env.GHL_WORKFLOW_TRIGGERS_ENABLED === "true",
  },
});
mock.module("@/lib/session-triggers", {
  namedExports: {
    defaultSessionTriggerDeps: () => ({}),
    drainSessionTriggers: async () => {
      calls.push("sessionTriggers");
      if (sessionDrainThrows) throw new Error("boom");
      return { fired: 2 };
    },
  },
});

const envBefore = { secret: process.env.WHATSAPP_INBOUND_POKE_SECRET, flag: process.env.GHL_WORKFLOW_TRIGGERS_ENABLED };
afterEach(() => {
  calls.length = 0;
  sessionDrainThrows = false;
  for (const [k, v] of [["WHATSAPP_INBOUND_POKE_SECRET", envBefore.secret], ["GHL_WORKFLOW_TRIGGERS_ENABLED", envBefore.flag]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function poke(): Request {
  return new Request("https://app.example.com/poke", { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: "{}" });
}

const routes = [
  ["crm-outbound-status", () => import("@/app/api/webhooks/crm-outbound-status/route"), "statuses"],
  ["whatsapp-replies", () => import("@/app/api/webhooks/whatsapp-replies/route"), "inbound"],
] as const;

for (const [name, load, mainDrain] of routes) {
  test(`${name}: with the flag on, the poke runs the session trigger drain after its own drain`, async () => {
    process.env.WHATSAPP_INBOUND_POKE_SECRET = SECRET;
    process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = "true";
    const { POST } = await load();
    const res = await POST(poke());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.sessionTriggers, { fired: 2 });
    assert.ok(calls.indexOf(mainDrain) >= 0 && calls.indexOf(mainDrain) < calls.indexOf("sessionTriggers"));
  });

  test(`${name}: with the flag off, the session trigger drain never runs`, async () => {
    process.env.WHATSAPP_INBOUND_POKE_SECRET = SECRET;
    delete process.env.GHL_WORKFLOW_TRIGGERS_ENABLED;
    const { POST } = await load();
    const body = await (await POST(poke())).json();
    assert.deepEqual(body.sessionTriggers, { fired: 0 });
    assert.ok(!calls.includes("sessionTriggers"));
    assert.ok(calls.includes(mainDrain));
  });

  test(`${name}: a throwing session trigger drain never fails the poke`, async () => {
    process.env.WHATSAPP_INBOUND_POKE_SECRET = SECRET;
    process.env.GHL_WORKFLOW_TRIGGERS_ENABLED = "true";
    sessionDrainThrows = true;
    const original = console.error;
    console.error = () => {};
    try {
      const { POST } = await load();
      const res = await POST(poke());
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).sessionTriggers, { fired: 0 });
    } finally {
      console.error = original;
    }
  });
}

test("cron: the session trigger drain is passed the time at the drain, not the cron's start", () => {
  const src = readFileSync(new URL("../../src/app/api/cron/drain/route.ts", import.meta.url), "utf8");
  assert.match(src, /drainSessionTriggers\(repo, defaultSessionTriggerDeps\(defaultTriggerDeps\(defaultGhlProviderDeps\)\), Date\.now\(\)\)/);
});

test("the bridge's connection pokes go to crm-outbound-status", () => {
  const src = readFileSync(new URL("../../services/whatsapp-bridge/src/sessions.ts", import.meta.url), "utf8");
  assert.match(src, /recordReconnected\(this\.outboundPoke\)/);
  assert.match(src, /recordClosed\(session, this\.outboundPoke\)/);
});

test("the poke and provider send routes allow 300 seconds, like the cron", () => {
  for (const path of ["whatsapp-replies", "crm-outbound-status", "crm-provider"]) {
    const src = readFileSync(new URL(`../../src/app/api/webhooks/${path}/route.ts`, import.meta.url), "utf8");
    assert.match(src, /^export const maxDuration = 300;$/m, path);
  }
});
