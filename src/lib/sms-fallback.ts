/**
 * SMS fallback B (docs/superpowers/plans/2026-10-17-sms-fallback-b.md): when
 * a contact isn't on WhatsApp, ask GoHighLevel to send the same text as an
 * SMS on that contact, through the sub-account's own SMS provider.
 *
 * Called from the two places the app learns a contact isn't on WhatsApp
 * (`src/lib/ghl-provider.ts`, loaded lazily there): the status drain, and the
 * 30-day memory's fast refusal. Both call `trySmsFallback` BEFORE reporting
 * the status, so the reason can say "sent as SMS instead", and fire
 * `whatsapp_not_on_whatsapp` only when no SMS went and none is in flight.
 *
 * ONCE PER MESSAGE: the row's `sms_fallback` column (0014) is claimed by one
 * pass only (conditional on it being unclaimed and the row unreported), and
 * holds the outcome, so an overlapping drain or a retried status report never
 * sends a second SMS. A claim younger than 2 minutes is another pass still on
 * it ("busy": leave the row); an older one is a pass that died ("failed").
 *
 * ONCE PER CONTACT PER 10 MINUTES: the echo row (one per location and
 * contact) doubles as the cooldown. If an unexpired one exists, no SMS: the
 * trigger fires instead. So an echo the loop guard misses costs one hop,
 * never a loop.
 *
 * LOOP GUARD: PingWren may itself be the sub-account's SMS provider, so GHL
 * may hand this SMS straight back to our provider webhook. The echo records
 * the original row, the hash of the normalised text and, once the POST
 * answers, GHL's message id; `handleProviderOutboundMessage` recognises it,
 * refuses it, blocks the fallback for the sub-account, and marks the original
 * `failed`. This module re-reads the row after the send, so an echo that
 * arrived before the POST answered is honoured ("echoed").
 *
 * Never throws. Never logs phones, contact ids or text.
 */
import type { GhlRepository } from "@/lib/data";
import { isAppOriginatedMessageId, isSmsFallbackEnabled, sendGhlSms } from "@/lib/ghl";
import { optedOutReason, resolveGhlAccessToken, type GhlTokenRefreshDeps, type GhlTokenRefreshRepo } from "@/lib/ghl-provider";
import { SMS_FALLBACK_CLAIM_BUSY_MS, SMS_FALLBACK_ECHO_MS, smsFallbackTextSha256 } from "@/lib/sms-fallback-shared";
import type { GhlAccount, GhlOutboundMessage } from "@/lib/types";

export { REASON_SENT_AS_SMS, REASON_SMS_FALLBACK_LOOP, SMS_FALLBACK_ECHO_MS, smsFallbackTextSha256 } from "@/lib/sms-fallback-shared";

export type SmsFallbackRepo = GhlTokenRefreshRepo &
  Pick<
    GhlRepository,
    | "isOptedOut"
    | "listLocationNumbers"
    | "recordSmsFallbackEcho"
    | "setSmsFallbackEchoMessageId"
    | "claimSmsFallback"
    | "setSmsFallbackResult"
    | "getGhlOutboundMessage"
  >;

export type SmsFallbackDeps = GhlTokenRefreshDeps & {
  /** The GHL send call; unset, the real `sendGhlSms`. */
  sendSms?: typeof sendGhlSms;
};

/**
 * - `sent`: GHL accepted the SMS (now, or on an earlier pass for this row).
 * - `skipped`: no SMS is due: the flag is off, the sub-account switched it
 *   off or is blocked, there is no contact or text, it is a group row or an
 *   app-originated one (a WhatsApp group invite is no use by SMS), or the
 *   contact already had a fallback SMS in the last 10 minutes. The trigger fires.
 * - `opted_out`: the contact replied STOP (checked first, whatever the flag).
 *   No SMS and no trigger: STOP wins.
 * - `failed`: the SMS was due but not sent (the token or the GHL call failed),
 *   now or on an earlier pass, or a claim was left by a pass that died. The trigger fires.
 * - `echoed`: GHL handed the SMS back through PingWren (the loop guard
 *   corrected the row while this pass was sending). Report "no WhatsApp
 *   account"; the guard already fired the trigger.
 * - `busy`: another pass holds this row's SMS right now (or already reported
 *   it). Leave the row: no report, no trigger.
 */
export type SmsFallbackOutcome = "sent" | "skipped" | "opted_out" | "failed" | "echoed" | "busy";

export async function trySmsFallback(
  repo: SmsFallbackRepo,
  deps: SmsFallbackDeps,
  input: { account: GhlAccount | null; row: GhlOutboundMessage; text: string | null }
): Promise<SmsFallbackOutcome> {
  const { account, row } = input;
  // An earlier pass already decided this row (its status report did not land).
  if (row.smsFallback === "sent") return "sent";
  if (row.smsFallback === "failed") return "failed";
  if (row.smsFallback === "claimed") return isFreshClaim(row.smsFallbackClaimedAt) ? "busy" : "failed";

  // STOP wins, whatever the flag: an opted-out contact gets no SMS and no
  // trigger. A group row has no phone (a member's STOP never blocks a group).
  if (row.toPhone) {
    try {
      if (await optedOutReason(repo, row.locationId, row.tenantId, row.toPhone)) return "opted_out";
    } catch {
      // Fail closed on the SMS; the trigger path behaves as without the fallback.
      console.error("[sms-fallback] opt-out read failed (no SMS)");
      return "skipped";
    }
  }

  if (!isSmsFallbackEnabled()) return "skipped";
  if (!account || !account.smsFallbackEnabled || account.smsFallbackBlockedAt) return "skipped";
  const message = (input.text ?? "").trim();
  if (!row.toPhone || !row.ghlContactId || !message || isAppOriginatedMessageId(row.ghlMessageId)) return "skipped";

  let claimed = false;
  try {
    claimed = await repo.claimSmsFallback(row.id);
    if (!claimed) return "busy";
    // The echo first: it is the cooldown, and without it the loop guard could
    // not recognise the SMS.
    const nowMs = Date.now();
    const free = await repo.recordSmsFallbackEcho(
      {
        locationId: account.locationId,
        contactId: row.ghlContactId,
        textSha256: smsFallbackTextSha256(message),
        outboundMessageId: row.id,
        expiresIso: new Date(nowMs + SMS_FALLBACK_ECHO_MS).toISOString(),
      },
      new Date(nowMs).toISOString()
    );
    if (!free) {
      // This contact had a fallback SMS in the last 10 minutes: no second one.
      await storeResult(repo, row.id, "failed");
      return "skipped";
    }
    const accessToken = await resolveGhlAccessToken(repo, deps, account);
    const sent = accessToken ? await (deps.sendSms ?? sendGhlSms)(accessToken, { contactId: row.ghlContactId, message }) : { ok: false as const, status: null };
    if (!sent.ok) {
      await storeResult(repo, row.id, "failed");
      return "failed";
    }
    await storeResult(repo, row.id, "sent");
    if (sent.messageId) await stampEchoMessageId(repo, account.locationId, row.ghlContactId, row.id, sent.messageId);
    // Just before the caller reports: did the echo come back while we sent?
    return (await wasEchoed(repo, row.id)) ? "echoed" : "sent";
  } catch {
    console.error("[sms-fallback] fallback SMS could not be sent (non-fatal)");
    if (claimed) await storeResult(repo, row.id, "failed");
    // Unclaimed: the claim itself failed, so no SMS; the trigger fires as without the fallback.
    return claimed ? "failed" : "skipped";
  }
}

function isFreshClaim(claimedAt: string | null | undefined): boolean {
  const at = claimedAt ? Date.parse(claimedAt) : NaN;
  return Number.isFinite(at) && Date.now() - at < SMS_FALLBACK_CLAIM_BUSY_MS;
}

async function storeResult(repo: SmsFallbackRepo, id: string, result: "sent" | "failed"): Promise<void> {
  try {
    await repo.setSmsFallbackResult(id, result);
  } catch {
    // The claim stays; after 2 minutes a later pass reads it as failed and never resends.
    console.error("[sms-fallback] could not store the fallback outcome (non-fatal)");
  }
}

async function stampEchoMessageId(repo: SmsFallbackRepo, locationId: string, contactId: string, rowId: string, ghlMessageId: string): Promise<void> {
  try {
    await repo.setSmsFallbackEchoMessageId(locationId, contactId, rowId, ghlMessageId);
  } catch {
    // The guard still matches on the text hash.
    console.error("[sms-fallback] could not store the SMS message id on the echo (non-fatal)");
  }
}

/** True when the loop guard marked the row failed while this pass was sending. A read error counts as not echoed. */
async function wasEchoed(repo: SmsFallbackRepo, id: string): Promise<boolean> {
  try {
    return (await repo.getGhlOutboundMessage(id))?.smsFallback === "failed";
  } catch {
    return false;
  }
}
