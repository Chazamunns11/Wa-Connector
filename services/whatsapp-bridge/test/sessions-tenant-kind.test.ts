/**
 * Every session is a GHL-location session. PortalHub's bridge read
 * `whatsapp_tenants.kind` once per session start (`resolveTenantKind`,
 * docs/GHL-PROVIDER-PLAN.md decision D4) and only a positive
 * `'ghl_location'` read switched on the ledger-gate bypass and inbound media
 * capture. This bridge has no other tenant kind (0001_init.sql's CHECK only
 * allows `'ghl_location'`), so that read — and the `'coach'` branch it
 * guarded — is gone: every session behaves exactly as PortalHub's
 * `'ghl_location'` branch did.
 *
 * The coach-only cases (a `'coach'` read passing through, null/throw
 * defaulting to `'coach'`, the asymmetric fail-closed pin) were deleted with
 * the branch they covered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import type { WAMessage } from "@whiskeysockets/baileys";
import * as sessions from "../src/sessions.js";
import { BridgeStore } from "../src/store.js";
import { processInboundBatch, type InboundDeps, type RecordInboundInput } from "../src/inbound.js";

const log = pino({ level: "silent" });

test("every session: there is no tenant-kind read to resolve — no resolveTenantKind, no BridgeStore.getTenantKind", () => {
  assert.equal("resolveTenantKind" in sessions, false);
  assert.equal("getTenantKind" in BridgeStore.prototype, false);
});

test("every session behaves as a GHL location: a cold sender's reply is stored and the portal poked, with no ledger lookup at all", async () => {
  const recorded: RecordInboundInput[] = [];
  let pokes = 0;
  const deps: InboundDeps = {
    async recordInboundMessage(input) {
      recorded.push(input);
      return { fresh: true };
    },
    schedulePoke() {
      pokes += 1;
    },
    log,
  };
  const msg = {
    key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false, id: "COLD1" },
    message: { conversation: "hi, saw your ad" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as unknown as WAMessage;

  await processInboundBatch([msg], "notify", "tenant-1", deps);

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.fromPhone, "+447700900123");
  assert.equal(pokes, 1);
});

test("every session: inbound media capture is gated on WA_MEDIA_INBOUND_ENABLED alone (SOURCE-LEVEL — openSocket needs a live socket)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.resolve(here, "../src/sessions.ts"), "utf8");
  assert.match(source, /const media\s*=\s*this\.config\.mediaInboundEnabled\s*\?/);
  assert.doesNotMatch(source, /tenantKind/);
});
