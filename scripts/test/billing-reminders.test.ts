import test from "node:test";
import assert from "node:assert/strict";

import { REMINDER_EVERY_MS, REMINDER_KEY_PREFIX, sendUnpaidReminders, unpaidReminderEmail, type ReminderRepo } from "@/lib/billing/reminders";
import type { Account } from "@/lib/types";

const account = (over: Partial<Account> = {}): Account =>
  ({
    id: "acc-1",
    name: "A",
    kind: "direct",
    ownerEmail: "owner@agency.test",
    stripeCustomerId: "cus",
    stripeSubscriptionId: "sub",
    billingStatus: "paused",
    trialEndsAt: null,
    cancelledAt: null,
    cleanedUpAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  }) as Account;

/** ops_alerts in memory, with the same once-only claim and delete-returning semantics as the real table. */
function fakeRepo(accounts: Account[]) {
  const rows = new Map<string, { key: string; downSince: string; alertedAt: string | null }>();
  let clock = new Date("2026-11-02T10:00:00.000Z");
  const repo: ReminderRepo = {
    listAccountsByBillingStatus: async (status) => accounts.filter((a) => a.billingStatus === status),
    listOpsAlerts: async () => [...rows.values()].map((r) => ({ ...r })),
    markOpsAlertDown: async (key) => {
      if (!rows.has(key)) rows.set(key, { key, downSince: clock.toISOString(), alertedAt: null });
    },
    claimOpsAlert: async (key) => {
      const r = rows.get(key);
      if (!r || r.alertedAt) return false;
      r.alertedAt = clock.toISOString();
      return true;
    },
    clearOpsAlert: async (key) => {
      const r = rows.get(key);
      if (!r) return null;
      rows.delete(key);
      return { wasAlerted: r.alertedAt !== null };
    },
  };
  const sent: { to: string[]; subject: string; text: string }[] = [];
  let emailWorks = true;
  const deps = {
    sendEmail: async (e: { to: string[]; subject: string; text: string }) => {
      if (!emailWorks) return false;
      sent.push(e);
      return true;
    },
    brandName: "PingWren",
    appUrl: "https://app.test",
    now: () => clock,
  };
  return {
    repo,
    deps,
    sent,
    rows,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    setEmailWorks: (v: boolean) => {
      emailWorks = v;
    },
  };
}

const HOUR = 60 * 60 * 1000;

test("an unpaid account gets one email straight away, none on the next hourly passes, then one a day", async () => {
  const h = fakeRepo([account()]);
  assert.deepEqual(await sendUnpaidReminders(h.repo, h.deps), { accounts: 1, sent: 1, failed: 0 });
  assert.equal(h.sent[0].to[0], "owner@agency.test");
  assert.match(h.sent[0].subject, /Nothing is sending/);

  for (let i = 0; i < 23; i++) {
    h.advance(HOUR);
    await sendUnpaidReminders(h.repo, h.deps);
  }
  assert.equal(h.sent.length, 1, "nothing more within the day");

  h.advance(HOUR);
  await sendUnpaidReminders(h.repo, h.deps);
  assert.equal(h.sent.length, 2, "the next day's reminder");
});

test("an hourly cron keeps the daily email at the same hour instead of drifting later", async () => {
  const h = fakeRepo([account()]);
  await sendUnpaidReminders(h.repo, h.deps);
  // The cron fires a few seconds early the next day.
  h.advance(24 * HOUR - 5000);
  await sendUnpaidReminders(h.repo, h.deps);
  assert.equal(h.sent.length, 2);
  assert.ok(REMINDER_EVERY_MS < 24 * HOUR);
});

test("overlapping passes send once", async () => {
  const h = fakeRepo([account()]);
  await Promise.all([sendUnpaidReminders(h.repo, h.deps), sendUnpaidReminders(h.repo, h.deps)]);
  assert.equal(h.sent.length, 1);
});

test("once the account pays, the reminders stop and its row is removed", async () => {
  const acct = account();
  const h = fakeRepo([acct]);
  await sendUnpaidReminders(h.repo, h.deps);
  acct.billingStatus = "active";
  h.advance(25 * HOUR);
  await sendUnpaidReminders(h.repo, h.deps);
  assert.equal(h.sent.length, 1);
  assert.equal(h.rows.size, 0);
});

test("a failed send is retried on the next pass, not a day later", async () => {
  const h = fakeRepo([account()]);
  h.setEmailWorks(false);
  assert.deepEqual(await sendUnpaidReminders(h.repo, h.deps), { accounts: 1, sent: 0, failed: 1 });
  h.setEmailWorks(true);
  h.advance(HOUR);
  await sendUnpaidReminders(h.repo, h.deps);
  assert.equal(h.sent.length, 1);
});

test("only paused accounts are reminded; active, past due, trialing and cancelled are not", async () => {
  const h = fakeRepo([
    account({ id: "a", billingStatus: "active" }),
    account({ id: "b", billingStatus: "past_due" }),
    account({ id: "c", billingStatus: "trialing" }),
    account({ id: "d", billingStatus: "cancelled" }),
    account({ id: "e", billingStatus: "paused", ownerEmail: "e@agency.test" }),
  ]);
  await sendUnpaidReminders(h.repo, h.deps);
  assert.deepEqual(
    h.sent.map((s) => s.to[0]),
    ["e@agency.test"],
  );
});

test("leaves other alert rows (health checks) alone", async () => {
  const h = fakeRepo([]);
  await h.repo.markOpsAlertDown("session:t1", null);
  await sendUnpaidReminders(h.repo, h.deps);
  assert.ok(h.rows.has("session:t1"));
  assert.ok(!REMINDER_KEY_PREFIX.startsWith("session:"));
});

test("the email says plainly that nothing sends, that messages won't go out later, and links to billing", () => {
  const unpaid = unpaidReminderEmail({ trialEndsAt: null }, "PingWren", "https://app.test");
  assert.match(unpaid.subject, /payment due/);
  assert.match(unpaid.text, /nothing is sending from any of your WhatsApp numbers/);
  assert.match(unpaid.text, /won't go out later/);
  assert.match(unpaid.text, /https:\/\/app\.test\/dashboard\/billing/);
  assert.match(unpaid.text, /once a day/);

  const trial = unpaidReminderEmail({ trialEndsAt: "2026-10-20T00:00:00.000Z" }, "PingWren", "https://app.test");
  assert.match(trial.subject, /add a card/);
  assert.match(trial.text, /free trial has ended/);
});
