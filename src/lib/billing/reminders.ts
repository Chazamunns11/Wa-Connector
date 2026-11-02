import type { GhlRepository } from "@/lib/data/repository";
import type { Account } from "@/lib/types";

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
 * paused its row is deleted and the emails stop. Logs carry counts only.
 */
export const REMINDER_KEY_PREFIX = "billing-unpaid:";

/** Just under a day, so an hourly cron sends at about the same time each day instead of drifting an hour later. */
export const REMINDER_EVERY_MS = 23.5 * 60 * 60 * 1000;

export type ReminderRepo = Pick<
  GhlRepository,
  "listAccountsByBillingStatus" | "listOpsAlerts" | "markOpsAlertDown" | "claimOpsAlert" | "clearOpsAlert"
>;

export interface ReminderDeps {
  sendEmail: (input: { to: string[]; subject: string; text: string }) => Promise<boolean>;
  brandName: string;
  appUrl: string;
  now: () => Date;
}

export function unpaidReminderEmail(
  account: Pick<Account, "trialEndsAt">,
  brandName: string,
  appUrl: string,
): { subject: string; text: string } {
  const billingUrl = `${appUrl}/dashboard/billing`;
  if (account.trialEndsAt) {
    return {
      subject: `Nothing is sending from your ${brandName} numbers: add a card`,
      text: [
        "Hi,",
        "",
        `Your ${brandName} free trial has ended and there's no card on the account, so nothing is sending from any of your WhatsApp numbers.`,
        "",
        "Messages your GoHighLevel workflows and team send now show as failed and won't go out later. Your numbers are still connected, so there's nothing to rescan.",
        "",
        "Add a card here and sending restarts straight away:",
        billingUrl,
        "",
        "We'll email you once a day until this is sorted. If you'd rather stop, you can cancel from the same page.",
        "",
        brandName,
      ].join("\n"),
    };
  }
  return {
    subject: `Nothing is sending from your ${brandName} numbers: payment due`,
    text: [
      "Hi,",
      "",
      `Your last ${brandName} payment didn't go through, so nothing is sending from any of your WhatsApp numbers.`,
      "",
      "Messages your GoHighLevel workflows and team send now show as failed and won't go out later. Your numbers are still connected, so there's nothing to rescan.",
      "",
      "Update your card and pay what's due here. Sending restarts as soon as the payment goes through:",
      billingUrl,
      "",
      "We'll email you once a day until this is sorted. If you'd rather stop, you can cancel from the same page.",
      "",
      brandName,
    ].join("\n"),
  };
}

export async function sendUnpaidReminders(
  repo: ReminderRepo,
  deps: ReminderDeps,
): Promise<{ accounts: number; sent: number; failed: number }> {
  const now = deps.now().getTime();
  const paused = await repo.listAccountsByBillingStatus("paused");
  const open = new Map(
    (await repo.listOpsAlerts()).filter((a) => a.key.startsWith(REMINDER_KEY_PREFIX)).map((a) => [a.key, a]),
  );
  const due = new Set<string>();
  let sent = 0;
  let failed = 0;

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

  // Paid, cancelled or deleted: stop reminding.
  for (const key of open.keys()) {
    if (!due.has(key)) await repo.clearOpsAlert(key);
  }

  return { accounts: paused.length, sent, failed };
}
