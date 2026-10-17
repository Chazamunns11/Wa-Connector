/**
 * GET /api/cron/drain — the hourly backstop for the GHL provider's drains
 * (vercel.json schedules it). Assembled from PortalHub
 * `src/app/api/cron/reminders/route.ts`'s three WhatsApp/GHL passes and
 * `src/app/api/cron/weekly/route.ts`'s `CRON_SECRET` guard; everything else
 * those routes did (reminder emails, sequence runs, the coach reply drain,
 * Slack summaries) is Hub-only.
 *
 * The bridge's pokes (`/api/webhooks/crm-outbound-status`,
 * `/api/webhooks/whatsapp-replies`) are the latency path; this unconditional
 * pass is what guarantees an unreported row is never stuck longer than an
 * hour even if every poke silently fails.
 *
 * ORDER (copied from the reminders route): outbound statuses, then inbound
 * replies, then the 90-day inbound purge, then the 14-day cancelled-account cleanup — a row must be fully processed
 * before it's ever eligible to be deleted. Each pass is non-fatal: its own
 * try/catch, so one failing never stops the others.
 *
 * AUTH: `CRON_SECRET`, constant-time Bearer compare. Unset -> 503, never
 * processes an unauthenticated request (there is no demo mode here).
 */
import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { repo } from "@/lib/data";
import { drainGhlOutboundStatuses, drainGhlReadReceipts } from "@/lib/ghl-provider";
import { releaseHeldOutboundMessages } from "@/lib/ghl-held";
import { drainGhlInboundReplies } from "@/lib/ghl-inbound";
import { purgeCancelledAccounts } from "@/lib/billing/cleanup";
import { logoutWhatsappSession } from "@/lib/whatsapp-bridge";

export const dynamic = "force-dynamic";

/** Same explicit budget as PortalHub's reminders cron — the outbound drain carries its own wall-clock budget inside it, see `DRAIN_TIME_BUDGET_MS` (src/lib/ghl-provider.ts). */
export const maxDuration = 300;

/** Adversarial-review fix (lens 3, finding 1) — 0048's own file header always documented a 90-day purge of `whatsapp_inbound_messages`; this constant + the pass below is what actually implements it. See `Repository.purgeOldWhatsappInboundMessages`'s JSDoc. */
const WHATSAPP_INBOUND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** L1 fix (security/correctness audit) — constant-time Bearer-header compare, mirrors `GET /api/cron/weekly`'s identical helper. Length check first (a mismatch there is "not even shaped right"). */
function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !constantTimeEqualStr(authHeader, `Bearer ${cronSecret}`)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  } else {
    // No secret configured: never process unauthenticated requests.
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 503 });
  }

  const now = Date.now();

  // Held messages first: a released row becomes 'accepted' and is then
  // picked up by the status drain below.
  let heldRelease = { tenantsChecked: 0, released: 0, stillHeld: 0, expired: 0, refused: 0, reportFailed: 0, timeBudgetExceeded: false };
  try {
    heldRelease = await releaseHeldOutboundMessages(repo);
    if (heldRelease.released > 0 || heldRelease.stillHeld > 0 || heldRelease.expired > 0) {
      console.log(`[cron/drain] held release: released ${heldRelease.released}, still held ${heldRelease.stillHeld}, expired ${heldRelease.expired}.`);
    }
  } catch (err) {
    console.error("[cron/drain] held release failed (non-fatal):", err);
  }

  let ghlOutboundStatuses = {
    candidates: 0,
    delivered: 0,
    failed: 0,
    retried: 0,
    stillPending: 0,
    held: 0,
    unresolved: 0,
    reportFailed: 0,
    timeBudgetExceeded: false,
  };
  try {
    ghlOutboundStatuses = await drainGhlOutboundStatuses(repo);
    if (ghlOutboundStatuses.candidates > 0) {
      console.log(
        `[cron/drain] ghl outbound statuses: ${ghlOutboundStatuses.candidates} candidate(s), delivered ${ghlOutboundStatuses.delivered}, failed ${ghlOutboundStatuses.failed}, retried ${ghlOutboundStatuses.retried}, still pending ${ghlOutboundStatuses.stillPending}, held ${ghlOutboundStatuses.held}${ghlOutboundStatuses.timeBudgetExceeded ? " (time budget exceeded — remaining rows left for next pass)" : ""}.`
      );
    }
  } catch (err) {
    console.error("[cron/drain] ghl outbound-status drain failed (non-fatal):", err);
  }

  // Read receipts: off unless GHL_READ_RECEIPTS_ENABLED is exactly "true".
  let ghlReadReceipts = { examined: 0, reported: 0, failed: 0, timeBudgetExceeded: false };
  if (process.env.GHL_READ_RECEIPTS_ENABLED === "true") {
    try {
      ghlReadReceipts = await drainGhlReadReceipts(repo);
      if (ghlReadReceipts.examined > 0) {
        console.log(`[cron/drain] ghl read receipts: ${ghlReadReceipts.examined} examined, reported ${ghlReadReceipts.reported}, failed ${ghlReadReceipts.failed}.`);
      }
    } catch (err) {
      console.error("[cron/drain] ghl read-receipt drain failed (non-fatal):", err instanceof Error ? err.name : "error");
    }
  }

  let ghlInboundReplies = { candidates: 0, pushed: 0, rejected: 0, failed: 0, uncertain: 0, retried: 0, claimLost: 0, groupNotEnabled: 0, staleMissedCalls: 0, eventsSuppressed: 0, optedOut: 0, optedIn: 0, blockedUnconfigured: false };
  try {
    ghlInboundReplies = await drainGhlInboundReplies(repo);
    if (ghlInboundReplies.candidates > 0) {
      console.log(
        `[cron/drain] ghl inbound replies: ${ghlInboundReplies.candidates} candidate(s), pushed ${ghlInboundReplies.pushed}, rejected ${ghlInboundReplies.rejected}, failed ${ghlInboundReplies.failed}, uncertain ${ghlInboundReplies.uncertain}, retried ${ghlInboundReplies.retried}.`
      );
    }
  } catch (err) {
    console.error("[cron/drain] ghl inbound-reply drain failed (non-fatal):", err);
  }

  let whatsappInboundPurged = 0;
  try {
    const cutoffIso = new Date(now - WHATSAPP_INBOUND_RETENTION_MS).toISOString();
    whatsappInboundPurged = await repo.purgeOldWhatsappInboundMessages(cutoffIso);
    if (whatsappInboundPurged > 0) {
      console.log(`[cron/drain] purged ${whatsappInboundPurged} whatsapp inbound row(s) older than 90 days.`);
    }
  } catch (err) {
    console.error("[cron/drain] whatsapp-inbound purge failed (non-fatal):", err);
  }

  // Fourth pass: accounts cancelled 14+ days ago lose their stored WhatsApp
  // credentials. Idempotent; logs counts only (never ids, emails or Stripe refs).
  let cancelledCleanup = { accounts: 0, locations: 0, failures: 0 };
  try {
    cancelledCleanup = await purgeCancelledAccounts(repo, { logout: logoutWhatsappSession, now: () => new Date(now) });
    if (cancelledCleanup.accounts > 0) {
      console.log(
        `[cron/drain] cancelled cleanup: ${cancelledCleanup.accounts} account(s), ${cancelledCleanup.locations} location(s), ${cancelledCleanup.failures} failure(s).`
      );
    }
  } catch (err) {
    console.error("[cron/drain] cancelled-account cleanup failed (non-fatal):", err instanceof Error ? err.name : "error");
  }

  return NextResponse.json({ ok: true, heldRelease, ghlOutboundStatuses, ghlReadReceipts, ghlInboundReplies, whatsappInboundPurged, cancelledCleanup });
}
