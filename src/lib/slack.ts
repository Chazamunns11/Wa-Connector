/**
 * COPIED from PortalHub `src/lib/slack.ts` — ONLY `notifyText` and its private
 * helpers (`keepAlive`, `runNotifyText`, `deliver`, `SlackBlock`/`SlackMessage`).
 * The Hub's call-event `notify()`, weekly summary and profile-prefs gating are
 * not copied (they need the Hub repository). Bodies verbatim; reads
 * `SLACK_WEBHOOK_URL`.
 */
import { waitUntil } from "@vercel/functions";

/**
 * VERCEL FREEZE SEMANTICS: once a serverless function returns its response,
 * Vercel freezes that function instance — any promise still in flight (like
 * this module's un-awaited `notify()`/`notifyText()` calls) gets killed
 * mid-flight, before its `fetch()` to Slack resolves. `waitUntil()` tells the
 * runtime to keep the instance alive until the given promise settles, so
 * routes/actions can keep doing `void notify(...)` / `void notifyText(...)`
 * without the send getting cut off.
 *
 * Outside an actual Vercel request (local dev, demo mode with no
 * `SLACK_WEBHOOK_URL`, one-off scripts) there's no request context for
 * `waitUntil` to register with, so it's a silent no-op — it does not throw
 * in that case, but we swallow any error regardless so a `waitUntil`
 * problem can never surface as a caller-visible failure. Either way the
 * promise was already created (and already running) before `waitUntil` is
 * called, so non-Vercel environments behave exactly as they did before this
 * fix. `postWeeklySummary()` is unaffected — its one caller (the weekly cron
 * route) already `await`s it directly, so there's no fire-and-forget
 * lifetime problem to solve there.
 */
function keepAlive(promise: Promise<void>): void {
  try {
    waitUntil(promise);
  } catch {
    // no-op — see comment above.
  }
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
}

interface SlackMessage {
  text: string; // fallback/plain-text summary (notifications, screen readers)
  blocks: SlackBlock[];
}

/**
 * v8.3 — fire-and-forget plain-text notification for events that aren't a
 * `Call`/`NotificationEvent` (unlike `notify()` above) — currently just the
 * PIM Decision webhook's "finance passed, go allocate it" ping
 * (src/app/api/webhooks/pim/[token]/route.ts). Same never-throws contract as
 * `notify()`/`postWeeklySummary()`; demo mode logs instead of posting. Same
 * synchronous-wrapper-plus-`keepAlive()` shape as `notify()` above, for the
 * same reason.
 */
export function notifyText(text: string): Promise<void> {
  const promise = runNotifyText(text);
  keepAlive(promise);
  return promise;
}

async function runNotifyText(text: string): Promise<void> {
  try {
    await deliver({ text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  } catch (err) {
    console.error("[slack.notifyText] failed to send notification (non-fatal):", err);
  }
}

async function deliver(message: SlackMessage): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    // Demo/dev mode: no Slack configured — log instead of no-op silently.
    console.log("[slack] SLACK_WEBHOOK_URL not set — skipped:", message.text);
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: message.text, blocks: message.blocks }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable body>");
    console.error(`[slack.deliver] Slack webhook responded ${res.status}: ${body}`);
  }
}

