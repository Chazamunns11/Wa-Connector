/**
 * src/sessions.ts's `resolveTenantKind` (docs/GHL-PROVIDER-PLAN.md, decision
 * D4) — the fail-closed tenant-kind read `doStartSession` calls once per
 * session start. Extracted specifically so this is testable without a live
 * Baileys socket or a real Supabase call (see sessions.ts's own comment
 * immediately above the function, mirroring `test/sessions-poke.test.ts`'s
 * rationale for `recordSent`/`recordFailed`/`recordNotOnWhatsapp`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import { resolveTenantKind } from "../src/sessions.js";
import type { BridgeStore } from "../src/store.js";

const log = pino({ level: "silent" });

function makeFakeStore(getTenantKind: (tenantId: string) => Promise<"coach" | "ghl_location" | null>) {
  return { getTenantKind } as unknown as BridgeStore;
}

test("resolveTenantKind: a genuine 'coach' read passes through unchanged", async () => {
  const store = makeFakeStore(async () => "coach");
  assert.equal(await resolveTenantKind(store, "tenant-1", log), "coach");
});

test("resolveTenantKind: a genuine 'ghl_location' read passes through unchanged", async () => {
  const store = makeFakeStore(async () => "ghl_location");
  assert.equal(await resolveTenantKind(store, "tenant-1", log), "ghl_location");
});

test("resolveTenantKind: getTenantKind returning null (unknown tenant id) defaults to 'coach' — the STRICTER gate, never the bypass", async () => {
  const store = makeFakeStore(async () => null);
  assert.equal(await resolveTenantKind(store, "tenant-unknown", log), "coach");
});

test("resolveTenantKind: getTenantKind THROWING defaults to 'coach' and never rejects — a Supabase blip must never crash session start", async () => {
  const store = makeFakeStore(async () => {
    throw new Error("simulated Supabase error");
  });
  await assert.doesNotReject(async () => {
    const kind = await resolveTenantKind(store, "tenant-1", log);
    assert.equal(kind, "coach");
  });
});

test("resolveTenantKind: never defaults to 'ghl_location' under any failure mode — fail-closed is asymmetric on purpose", async () => {
  // Belt and braces on the two failure modes above: neither a null read nor
  // a throw can EVER produce the looser 'ghl_location' bypass — only a
  // genuine, positive 'ghl_location' read from the store can.
  const nullStore = makeFakeStore(async () => null);
  const throwingStore = makeFakeStore(async () => {
    throw new Error("boom");
  });
  assert.notEqual(await resolveTenantKind(nullStore, "t", log), "ghl_location");
  assert.notEqual(await resolveTenantKind(throwingStore, "t", log), "ghl_location");
});
