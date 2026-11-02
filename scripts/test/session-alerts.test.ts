/**
 * Health check + "your WhatsApp dropped" alerts — src/lib/session-alerts.ts.
 * In-memory ops_alerts with the same claim/delete semantics as migration 0019.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_AFTER_MS, decideAlertActions, runHealthCheck, type HealthDeps, type HealthRepo } from "@/lib/session-alerts";
import type { TriggerSessionRow, WhatsappSessionStatus } from "@/lib/types";

const LOC = "fiIgfPVIACqCyVDiDRuT";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-02T12:00:00Z");

function session(tenantId: string, slot: number, status: WhatsappSessionStatus, linked = true): TriggerSessionRow {
  return {
    tenantId,
    locationId: LOC,
    slot,
    label: slot === 2 ? "Setter" : null,
    phone: "+447700900001",
    status,
    downSince: null,
    lastFired: null,
    lastConnectedAt: linked ? "2026-11-01T00:00:00Z" : null,
    triggerPhone: null,
  };
}

function harness(opts: { sessions: TriggerSessionRow[]; bridgeUp?: boolean; ghlStatus?: "active" | "needs_reauth" }) {
  const alerts = new Map<string, { key: string; downSince: string; alertedAt: string | null }>();
  let sessions = opts.sessions;
  let bridgeUp = opts.bridgeUp ?? true;
  const emails: { to: string[]; subject: string; text: string }[] = [];
  let clock = NOW;
  const repo = {
    async getGhlAccounts() {
      return [{ locationId: LOC, tenantId: T1, label: "Master Template", status: opts.ghlStatus ?? "active", lastError: null, accountId: "acc-1" }];
    },
    async getGhlAccountByLocationId() {
      return { connectLinkVersion: 0 };
    },
    async getAccountById() {
      return { ownerEmail: "coach@example.com" };
    },
    async listSessionsForTriggers() {
      return sessions;
    },
    async listOpsAlerts() {
      return [...alerts.values()];
    },
    async markOpsAlertDown(key: string) {
      if (!alerts.has(key)) alerts.set(key, { key, downSince: new Date(clock).toISOString(), alertedAt: null });
    },
    async claimOpsAlert(key: string) {
      const row = alerts.get(key);
      if (!row || row.alertedAt) return false;
      row.alertedAt = new Date(clock).toISOString();
      return true;
    },
    async clearOpsAlert(key: string) {
      const row = alerts.get(key);
      if (!row) return null;
      alerts.delete(key);
      return { wasAlerted: row.alertedAt !== null };
    },
  } as unknown as HealthRepo;
  const deps: HealthDeps = {
    bridgeConfigured: () => true,
    bridgeHealthy: async () => bridgeUp,
    sendEmail: async (e) => {
      emails.push(e);
      return true;
    },
    operatorEmails: () => ["charlie@pingwren.co.uk"],
    reconnectUrl: (_l, _v, slot) => `https://pingwren.vercel.app/connect/tok-${slot}`,
    notify: () => {},
  };
  return {
    repo,
    deps,
    emails,
    alerts,
    run: (atMs: number) => {
      clock = atMs;
      return runHealthCheck(repo, deps, atMs);
    },
    setSessions: (s: TriggerSessionRow[]) => (sessions = s),
    setBridge: (up: boolean) => (bridgeUp = up),
  };
}

test("decideAlertActions: down -> mark, then alert after 5 minutes, once", () => {
  assert.deepEqual(decideAlertActions(true, false, undefined, NOW), ["mark"]);
  const open = { downSince: new Date(NOW).toISOString(), alertedAt: null };
  assert.deepEqual(decideAlertActions(true, false, open, NOW + ALERT_AFTER_MS - 1), []);
  assert.deepEqual(decideAlertActions(true, false, open, NOW + ALERT_AFTER_MS), ["alert"]);
  assert.deepEqual(decideAlertActions(true, false, { ...open, alertedAt: "x" }, NOW + 10 * ALERT_AFTER_MS), []);
  assert.deepEqual(decideAlertActions(true, true, undefined, NOW), ["mark", "alert"]);
  assert.deepEqual(decideAlertActions(false, false, open, NOW), ["recover"]);
  assert.deepEqual(decideAlertActions(false, false, undefined, NOW), []);
});

test("a dropped number emails the coach and the operator once, with the reconnect link, after 5 minutes", async () => {
  const h = harness({ sessions: [session(T1, 1, "connected"), session(T2, 2, "disconnected")] });
  let report = await h.run(NOW);
  assert.equal(h.emails.length, 0, "a blip under 5 minutes stays quiet");
  assert.equal(report.ok, false);
  report = await h.run(NOW + ALERT_AFTER_MS);
  assert.equal(h.emails.length, 1);
  assert.deepEqual(h.emails[0].to, ["coach@example.com", "charlie@pingwren.co.uk"]);
  assert.match(h.emails[0].subject, /WhatsApp disconnected: Master Template — Setter/);
  assert.match(h.emails[0].text, /https:\/\/pingwren\.vercel\.app\/connect\/tok-2/);
  assert.equal(report.alertsSent, 1);
  await h.run(NOW + 3 * ALERT_AFTER_MS);
  assert.equal(h.emails.length, 1, "never a second email for the same outage");
});

test("logged out alerts at once; reconnecting sends one 'reconnected' email and closes the outage", async () => {
  const h = harness({ sessions: [session(T1, 1, "logged_out")] });
  await h.run(NOW);
  assert.equal(h.emails.length, 1);
  assert.match(h.emails[0].text, /logged this device out/);
  h.setSessions([session(T1, 1, "connected")]);
  const report = await h.run(NOW + 60_000);
  assert.equal(report.recovered, 1);
  assert.match(h.emails[1].subject, /WhatsApp reconnected/);
  assert.equal(h.alerts.size, 0);
  await h.run(NOW + 120_000);
  assert.equal(h.emails.length, 2);
});

test("a down-then-up blip under 5 minutes sends nothing at all", async () => {
  const h = harness({ sessions: [session(T1, 1, "disconnected")] });
  await h.run(NOW);
  h.setSessions([session(T1, 1, "connected")]);
  await h.run(NOW + 60_000);
  assert.equal(h.emails.length, 0);
  assert.equal(h.alerts.size, 0);
});

test("a never-linked number waiting for its first QR scan is not an outage", async () => {
  const h = harness({ sessions: [session(T1, 1, "waiting_qr", false)] });
  const report = await h.run(NOW + 10 * ALERT_AFTER_MS);
  assert.equal(h.alerts.size, 0);
  assert.equal(report.ok, true);
});

test("bridge down: operator alerted after 5 minutes; stale session rows are neither alerted nor cleared", async () => {
  const h = harness({ sessions: [session(T1, 1, "disconnected")] });
  await h.run(NOW); // session marked down while the bridge was up
  h.setBridge(false);
  await h.run(NOW + 60_000);
  await h.run(NOW + 60_000 + ALERT_AFTER_MS);
  const subjects = h.emails.map((e) => e.subject);
  assert.ok(subjects.some((s) => /WhatsApp service is not responding/.test(s)));
  assert.ok(!subjects.some((s) => /WhatsApp disconnected/.test(s)), "no session alert from stale data");
  assert.deepEqual(h.emails.find((e) => /not responding/.test(e.subject))?.to, ["charlie@pingwren.co.uk"]);
  assert.ok(h.alerts.has(`session:${T1}`), "the session outage is kept, not cleared, while the bridge is down");
});

test("a location needing re-authorisation alerts the operator only, at once", async () => {
  const h = harness({ sessions: [session(T1, 1, "connected")], ghlStatus: "needs_reauth" });
  await h.run(NOW);
  assert.equal(h.emails.length, 1);
  assert.deepEqual(h.emails[0].to, ["charlie@pingwren.co.uk"]);
  assert.match(h.emails[0].subject, /needs reinstalling/);
});

test("the report counts extra numbers per location for billing and never carries a phone number", async () => {
  const h = harness({ sessions: [session(T1, 1, "connected"), session(T2, 2, "connected")] });
  const report = await h.run(NOW);
  assert.equal(report.extraNumbers, 1);
  assert.equal(report.locations[0].numbers.length, 2);
  assert.ok(!JSON.stringify(report).includes("+4477"));
  assert.equal(report.ok, true);
});
