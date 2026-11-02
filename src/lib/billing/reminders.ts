import type { GhlRepository } from "@/lib/data/repository";
import type { Account, BillingStatus } from "@/lib/types";

/**
 * Daily "nothing is sending until you pay" email (Nov 2026, Charlie: "must be
 * clear to the agency that nothing sends until paid. Maybe a daily reminder?").
 *
 * Who: every account whose billing_status is `paused`, which covers Stripe
 * `unpaid` (the payment retries ran out) and a trial that ended with no card.
 * Their numbers stay linked, but every message is refused (src/lib/billing/gate.ts).
 * The email goes to the account owner and repeats once a day until they pay
 * or cancel.
 *
 * Once-a-day guard: one ops_alerts row per account (`billing-unpaid:<id>`,
 * the same table and claim the health alerts use). The pass that claims
 * `alerted_at` is the only one that sends. After REMINDER_EVERY_MS the row is
 * deleted and re-claimed, and only the pass whose delete returned it sends, so
 * overlapping cron runs never send twice. When the account is no longer
 * paused its row is deleted, the emails stop, and if it is paying again the
 * owner gets one "sending again" email. Logs carry counts only.
 */
export const REMINDER_KEY_PREFIX = "billing-unpaid:";

/** Just under a day, so an hourly cron sends at about the same time each day instead of drifting an hour later. */
export const REMINDER_EVERY_MS = 23.5 * 60 * 60 * 1000;

/** Statuses that send again (src/lib/billing/gate.ts): these get the "sending again" email. Cancelled does not. */
const LIVE: ReadonlySet<BillingStatus> = new Set(["trialing", "active", "past_due", "comped"]);

export type ReminderRepo = Pick<
  GhlRepository,
  "listAccountsByBillingStatus" | "listOpsAlerts" | "markOpsAlertDown" | "claimOpsAlert" | "clearOpsAlert" | "getAccountById"
>;

export interface ReminderDeps {
  sendEmail: (input: { to: string[]; subject: string; text: string; action?: { label: string; url: string } }) => Promise<boolean>;
  brandName: string;
  appUrl: string;
  now: () => Date;
}

type Email = { subject: string; text: string; action: { label: string; url: string } };

export function unpaidReminderEmail(account: Pick<Account, "trialEndsAt">, brandName: string, appUrl: string): Email {
  const billingUrl = `${appUrl}/dashboard/billing`;
  const trialEnded = !!account.trialEndsAt;
  return {
    subject: trialEnded
      ? `Nothing is sending from your ${brandName} numbers: add a card`
      : `Nothing is sending from your ${brandName} numbers: payment due`,
    text: [
      "Hi,",
      trialEnded
        ? `Your ${brandName} free trial has ended and there's no card on the account, so nothing is sending from any of your WhatsApp numbers.`
        : `Your last ${brandName} payment didn't go through, so nothing is sending from any of your WhatsApp numbers.`,
      "Messages your GoHighLevel workflows and team send now show as failed and won't go out later. Your numbers are still connected, so there's nothing to rescan.",
      trialEnded
        ? "Add a card and sending restarts straight away:"
        : "Update your card and we'll take the payment that's due. Sending restarts as soon as it goes through:",
      billingUrl,
      "We'll email you once a day until this is sorted. If you'd rather stop, you can cancel from the same page.",
      `The ${brandName} team`,
    ].join("\n\n"),
    action: { label: trialEnded ? "Add a card" : "Update card and pay", url: billingUrl },
  };
}

/** Sent once, on the first pass after an account that was reminded is paying again. */
export function sendingRestartedEmail(brandName: string, appUrl: string): Email {
  const dashboardUrl = `${appUrl}/dashboard`;
  return {
    subject: `Payment received: your ${brandName} numbers are sending again`,
    text: [
      "Hi,",
      `Thanks, your payment went through and your ${brandName} account is active again.`,
      "Your WhatsApp numbers are sending from GoHighLevel as normal. Nothing needed rescanning.",
      "Messages that failed while the account was unpaid weren't sent. If any of them still matter, send them again from GoHighLevel.",
      dashboardUrl,
      `The ${brandName} team`,
    ].join("\n\n"),
    action: { label: "Open your dashboard", url: dashboardUrl },
  };
}

export async function sendUnpaidReminders(
  repo: ReminderRepo,
  deps: ReminderDeps,
): Promise<{ accounts: number; sent: number; failed: number; restarted: number }> {
  const now = deps.now().getTime();
  const paused = await repo.listAccountsByBillingStatus("paused");
  const open = new Map(
    (await repo.listOpsAlerts()).filter((a) => a.key.startsWith(REMINDER_KEY_PREFIX)).map((a) => [a.key, a]),
  );
  const due = new Set<string>();
  let sent = 0;
  let failed = 0;
  let restarted = 0;

  for (const account of paused) {
    const key = `${REMINDER_KEY_PREFIX}${account.id}`;
    due.add(key);
    if (!account.ownerEmail) continue;
    const row = open.get(key);
    let claimed = false;
    if (!row) {
      await repo.markOpsAlertDown(key, null);
      claimed = await repo.claimOpsAlert(key);
    } else if (!row.alertedAt) {
      claimed = await repo.claimOpsAlert(key);
    } else if (now - Date.parse(row.alertedAt) >= REMINDER_EVERY_MS) {
      const cleared = await repo.clearOpsAlert(key);
      if (cleared?.wasAlerted) {
        await repo.markOpsAlertDown(key, null);
        claimed = await repo.claimOpsAlert(key);
      }
    }
    if (!claimed) continue;

    const email = unpaidReminderEmail(account, deps.brandName, deps.appUrl);
    if (await deps.sendEmail({ to: [account.ownerEmail], ...email })) {
      sent += 1;
    } else {
      failed += 1;
      // Not sent: release the claim so the next hourly pass tries again.
      await repo.clearOpsAlert(key);
    }
  }

  // Paid, cancelled or deleted: stop reminding. Only the pass whose delete
  // returned the row tells a paying account that sending has restarted.
  for (const key of open.keys()) {
    if (due.has(key)) continue;
    const cleared = await repo.clearOpsAlert(key);
    if (!cleared?.wasAlerted) continue;
    const account = await repo.getAccountById(key.slice(REMINDER_KEY_PREFIX.length));
    if (!account?.ownerEmail || !LIVE.has(account.billingStatus)) continue;
    if (await deps.sendEmail({ to: [account.ownerEmail], ...sendingRestartedEmail(deps.brandName, deps.appUrl) })) restarted += 1;
  }

  return { accounts: paused.length, sent, failed, restarted };
}
