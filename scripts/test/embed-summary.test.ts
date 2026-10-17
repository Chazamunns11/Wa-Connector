import { test } from "node:test";
import assert from "node:assert/strict";
import { toEmbedWhatsappSummary } from "@/lib/embed-summary";
import type { WhatsappSessionSummary } from "@/lib/types";

const full: WhatsappSessionSummary = {
  coachId: "tenant-secret", status: "disconnected", phoneNumber: "+447700900101", lastConnectedAt: "2026-10-10T00:00:00Z",
  lastDisconnectReason: null, sentToday: 3, heldMessages: 4,
};

test("toEmbedWhatsappSummary: null in, null out", () => {
  assert.equal(toEmbedWhatsappSummary(null), null);
});
test("toEmbedWhatsappSummary: carries heldMessages and never the tenant id", () => {
  const out = toEmbedWhatsappSummary(full)!;
  assert.equal(out.heldMessages, 4);
  assert.equal("coachId" in out, false);
  assert.equal(JSON.stringify(out).includes("tenant-secret"), false);
});
