/**
 * Health check + "your WhatsApp dropped" alerts (run by
 * `src/app/api/cron/health/route.ts`, every 5 minutes).
 *
 * Three things are checked on every pass:
 *   - the bridge itself (`bridge`) — down = its /health does not answer. While
 *     it is down, session statuses in the database are stale, so sessions are
 *     neither alerted nor cleared on that pass.
 *   - every number of every installed location (`session:<tenant>`) — down =
 *     it was linked once (`lastConnectedAt`) and is not connected now. Alerts
 *     after 5 minutes down (a reconnect blip stays quiet), at once for
 *     logged_out / banned — the same rule as the workflow triggers
 *     (`src/lib/session-triggers.ts`), with its own state (ops_alerts, 0019).
 *   - every location's HighLevel connection (`ghl:<location>`) — down =
 *     needs_reauth.
 *
 * Who hears: the operator (ALERT_EMAIL_TO, default charlie@pingwren.co.uk)
 * for everything, plus the coach (the location's account owner email) for
 * their own numbers, with a reconnect link. Slack gets a copy. One email per
 * outage, one "back up" email when it recovers (ops_alerts claim/delete is
 * the once-only guard). Nothing here logs a phone number or an email.
 */
import type { GhlRepository } from "@/lib/data";
import type { TriggerSessionRow, WhatsappSessionStatus } from "@/lib/types";
import { brandConfig } from "@/lib/brand-config";
import { holdMaxHours } from "@/lib/ghl-held-rules";

/** A number must be down this long before the email goes (unless logged out or banned). */
export const ALERT_AFTER_MS = 5 * 60 * 1000;

export type HealthRepo = Pick<
  GhlRepository,
  | "getGhlAccounts"
  | "getGhlAccountByLocationId"
  | "getAccountById"
  | "listSessionsForTriggers"
  | "listOpsAlerts"
  | "markOpsAlertDown"
  | "claimOpsAlert"
  | "clearOpsAlert"
>;

export interface HealthDeps {
  bridgeConfigured: () => boolean;
  bridgeHealthy: () => Promise<boolean>;
  sendEmail: (input: { to: string[]; subject: string; text: string }) => Promise<boolean>;
  operatorEmails: () => string[];
  /** A fresh reconnect link for one number, or "" if connect links are not configured. */
  reconnectUrl: (locationId: string, connectLinkVersion: number | null, slot: number) => string;
  notify: (text: string) => void;
}

export type AlertAction = "mark" | "alert" | "recover";

/** Pure: what to do for one checked thing, given whether it is down now and its open outage row (if any). */
export function decideAlertActions(
  down: boolean,
  immediate: boolean,
  open: { downSince: string; alertedAt: string | null } | undefined,
  now: number
): AlertAction[] {
  if (!down) return open ? ["recover"] : [];
  if (!open) return immediate ? ["mark", "alert"] : ["mark"];
  if (open.alertedAt) return [];
  return immediate || now - Date.parse(open.downSince) >= ALERT_AFTER_MS ? ["alert"] : [];
}

/** A linked-once number that is not connected now. Never-linked numbers (still waiting for their first QR scan) are not outages. */
export function isSessionDown(row: Pick<TriggerSessionRow, "status" | "lastConnectedAt">): boolean {
  return row.lastConnectedAt !== null && row.status !== "connected";
}

function isImmediate(status: WhatsappSessionStatus): boolean {
  return status === "logged_out" || status === "banned";
}

function statusSentence(status: WhatsappSessionStatus): string {
  if (status === "banned") return "WhatsApp has banned this number";
  if (status === "logged_out") return "the phone logged this device out (Linked devices was removed, or WhatsApp signed it out)";
  return "the connection to WhatsApp was lost";
}

interface Check {
  key: string;
  down: boolean;
  immediate: boolean;
  detail: string | null;
  to: () => Promise<string[]>;
  downEmail: () => Promise<{ subject: string; text: string }>;
  upEmail: () => { subject: string; text: string };
}

export interface HealthReport {
  ok: boolean;
  bridge: { configured: boolean; reachable: boolean | null };
  locations: {
    locationId: string;
    label: string;
    status: string;
    numbers: { slot: number; label: string | null; status: WhatsappSessionStatus; down: boolean }[];
  }[];
  /** Numbers beyond each location's first (a count only; Stripe bills every number itself, 0020). */
  extraNumbers: number;
  alertsSent: number;
  recovered: number;
  emailFailures: number;
  errors: number;
}

export async function runHealthCheck(repo: HealthRepo, deps: HealthDeps, now: number = Date.now()): Promise<HealthReport> {
  const brand = brandConfig();
  const accounts = (await repo.getGhlAccounts()).filter((a) => a.status !== "disabled");
  const open = new Map((await repo.listOpsAlerts()).map((a) => [a.key, a]));
  const configured = deps.bridgeConfigured();
  const reachable = configured ? await deps.bridgeHealthy().catch(() => false) : null;
  const report: HealthReport = {
    ok: true,
    bridge: { configured, reachable },
    locations: [],
    extraNumbers: 0,
    alertsSent: 0,
    recovered: 0,
    emailFailures: 0,
    errors: 0,
  };
  const operators = deps.operatorEmails();
  const checks: Check[] = [];

  if (configured) {
    checks.push({
      key: "bridge",
      down: reachable === false,
      immediate: false,
      detail: "bridge /health did not answer",
      to: async () => operators,
      downEmail: async () => ({
        subject: `${brand.name}: the WhatsApp service is not responding`,
        text: `The ${brand.name} WhatsApp bridge has not answered its health check for at least 5 minutes. No WhatsApp message can be sent or received until it is back. Check the bridge service (Railway) logs and restart it.\n\nOutbound messages from HighLevel are queued and retried; nothing is lost while it is down for less than ${holdMaxHours()} hours.`,
      }),
      upEmail: () => ({ subject: `${brand.name}: the WhatsApp service is back`, text: "The WhatsApp bridge is answering its health check again." }),
    });
  }

  for (const account of accounts) {
    checks.push({
      key: `ghl:${account.locationId}`,
      down: account.status === "needs_reauth",
      immediate: true,
      detail: account.lastError,
      to: async () => operators,
      downEmail: async () => ({
        subject: `${brand.name}: HighLevel connection needs reinstalling — ${account.label}`,
        text: `HighLevel no longer accepts ${brand.name}'s access for ${account.label} (${account.locationId})${account.lastError ? `: ${account.lastError}` : ""}.\n\nWhatsApp sending for this sub-account is paused until the app is installed again from the HighLevel Marketplace (pick the same sub-account, or the agency for an agency install).`,
      }),
      upEmail: () => ({ subject: `${brand.name}: HighLevel connection restored — ${account.label}`, text: `${account.label} is connected to HighLevel again.` }),
    });
  }

  // While the bridge is unreachable the session rows are stale: skip them.
  const sessionsEvaluated = !configured || reachable === true;
  const sessions = sessionsEvaluated ? await repo.listSessionsForTriggers(accounts.map((a) => a.locationId)) : [];
  for (const account of accounts) {
    const numbers = sessions.filter((s) => s.locationId === account.locationId).sort((a, b) => a.slot - b.slot);
    report.extraNumbers += Math.max(0, numbers.length - 1);
    report.locations.push({
      locationId: account.locationId,
      label: account.label,
      status: account.status,
      numbers: numbers.map((s) => ({ slot: s.slot, label: s.label, status: s.status, down: isSessionDown(s) })),
    });
    for (const s of numbers) {
      const numberName = s.label?.trim() || `Number ${s.slot}`;
      const phone = s.phone ?? s.triggerPhone;
      const coachAndOperators = async () => {
        const owner = account.accountId ? await repo.getAccountById(account.accountId) : null;
        return owner?.ownerEmail ? [owner.ownerEmail, ...operators] : operators;
      };
      checks.push({
        key: `session:${s.tenantId}`,
        down: isSessionDown(s),
        immediate: isImmediate(s.status),
        detail: s.status,
        to: coachAndOperators,
        downEmail: async () => {
          const full = await repo.getGhlAccountByLocationId(account.locationId);
          const link = deps.reconnectUrl(account.locationId, full?.connectLinkVersion ?? null, s.slot) || `${brand.appUrl}/dashboard`;
          const held =
            s.status === "banned"
              ? "Messages to this number's contacts will fail until a different number is connected."
              : `Messages sent from HighLevel in the meantime are held for up to ${holdMaxHours()} hours and go out as soon as it is reconnected.`;
          return {
            subject: `WhatsApp disconnected: ${account.label} — ${numberName}`,
            text: `${numberName}${phone ? ` (${phone})` : ""} for ${account.label} stopped working: ${statusSentence(s.status)}.\n\n${held}\n\nReconnect it here (scan the QR code with WhatsApp > Linked devices on the phone):\n${link}\n\n— ${brand.name}`,
          };
        },
        upEmail: () => ({
          subject: `WhatsApp reconnected: ${account.label} — ${numberName}`,
          text: `${numberName} for ${account.label} is connected again. Any held messages are being sent now.\n\n— ${brand.name}`,
        }),
      });
    }
  }

  const checkedKeys = new Set(checks.map((c) => c.key));
  for (const check of checks) {
    try {
      const actions = decideAlertActions(check.down, check.immediate, open.get(check.key), now);
      for (const action of actions) {
        if (action === "mark") await repo.markOpsAlertDown(check.key, check.detail);
        else if (action === "alert") {
          if (!(await repo.claimOpsAlert(check.key))) continue; // another pass already alerted
          const email = await check.downEmail();
          deps.notify(`${email.subject}`);
          if (!(await deps.sendEmail({ to: await check.to(), ...email }))) report.emailFailures++;
          report.alertsSent++;
        } else {
          const cleared = await repo.clearOpsAlert(check.key);
          if (cleared?.wasAlerted) {
            const email = check.upEmail();
            deps.notify(email.subject);
            if (!(await deps.sendEmail({ to: await check.to(), ...email }))) report.emailFailures++;
            report.recovered++;
          }
        }
      }
    } catch (err) {
      report.errors++;
      console.error(`[health] check ${check.key.split(":")[0]} failed:`, err);
    }
  }

  // Outages for things that no longer exist (a removed number or location) close quietly.
  for (const key of open.keys()) {
    if (checkedKeys.has(key)) continue;
    if (key.startsWith("session:") && !sessionsEvaluated) continue;
    try {
      await repo.clearOpsAlert(key);
    } catch (err) {
      report.errors++;
      console.error("[health] could not clear a stale alert:", err);
    }
  }

  report.ok = reachable !== false && report.errors === 0 && checks.every((c) => !c.down);
  return report;
}
