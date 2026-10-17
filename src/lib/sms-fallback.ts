/**
 * SMS fallback B (docs/superpowers/plans/2026-10-17-sms-fallback-b.md): when
 * a contact isn't on WhatsApp, ask GoHighLevel to send the same text as an
 * SMS on that contact, through the sub-account's own SMS provider.
 *
 * Called from the two places the app learns a contact isn't on WhatsApp
 * (`src/lib/ghl-provider.ts`): the status drain, and the 30-day memory's fast
 * refusal. Both call `trySmsFallback` BEFORE reporting the status, so the
 * reason can say "sent as SMS instead", and fire `whatsapp_not_on_whatsapp`
 * only when the SMS was not sent.
 *
 * ONCE PER MESSAGE: the row's `sms_fallback` column (0014) is claimed by one
 * pass only (conditional on it being unclaimed and the row unreported), and
 * holds the outcome, so an overlapping drain or a retried status report never
 * sends a second SMS.
 *
 * LOOP GUARD: PingWren may itself be the sub-account's SMS provider, so GHL
 * may hand this SMS straight back to our provider webhook. Before calling GHL
 * we record a pending echo (location, contact, sha256 of the text) for 10
 * minutes; `handleProviderOutboundMessage` consumes it, refuses the message
 * with `REASON_SMS_FALLBACK_LOOP`, and blocks the fallback for the sub-account.
 *
 * Never throws. Never logs phones, contact ids or text.
 */
import { createHash } from "node:crypto";
import type { GhlRepository } from "@/lib/data";
import { isSmsFallbackEnabled, sendGhlSms } from "@/lib/ghl";
import { isAppOriginatedMessageId, optedOutReason, resolveGhlAccessToken, type GhlTokenRefreshDeps, type GhlTokenRefreshRepo } from "@/lib/ghl-provider";
import type { GhlAccount, GhlOutboundMessage } from "@/lib/types";

/** GHL status reason for the original message when the SMS call succeeded. */
export const REASON_SENT_AS_SMS = "Not on WhatsApp — sent as SMS instead";

/** GHL status reason for our own fallback SMS handed back to PingWren. */
export const REASON_SMS_FALLBACK_LOOP = "This sub-account sends SMS through PingWren, so the SMS fallback can't be used — not sent";

/** How long a pending echo is valid. */
export const SMS_FALLBACK_ECHO_MS = 10 * 60 * 1000;

/** The hash the echo table stores: sha256 hex of the trimmed text. */
export function smsFallbackTextSha256(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

export type SmsFallbackRepo = GhlTokenRefreshRepo &
  Pick<GhlRepository, "isOptedOut" | "listLocationNumbers" | "recordSmsFallbackEcho" | "claimSmsFallback" | "setSmsFallbackResult">;

export type SmsFallbackDeps = GhlTokenRefreshDeps & {
  /** The GHL send call; unset, the real `sendGhlSms`. */
  sendSms?: typeof sendGhlSms;
};

/**
 * - `sent`: GHL accepted the SMS (now, or on an earlier pass for this row).
 * - `skipped`: no SMS is due: the flag is off, the sub-account switched it
 *   off or is blocked, there is no contact or text, it is a group row or an
 *   app-originated one (a WhatsApp group invite is no use by SMS).
 * - `opted_out`: no SMS because the contact replied STOP. Like `skipped`, but
 *   the caller fires no trigger either: STOP wins.
 * - `failed`: the SMS was due but not sent (the echo, the token or the GHL
 *   call failed), now or on an earlier pass. The caller fires the trigger.
 * - `busy`: another pass holds this row's SMS right now (or already reported
 *   it). The caller leaves the row for that pass.
 */
export type SmsFallbackOutcome = "sent" | "skipped" | "opted_out" | "failed" | "busy";

export async function trySmsFallback(
  repo: SmsFallbackRepo,
  deps: SmsFallbackDeps,
  input: { account: GhlAccount | null; row: GhlOutboundMessage; text: string | null }
): Promise<SmsFallbackOutcome> {
  const { account, row } = input;
  // An earlier pass already decided this row (its status report did not land).
  if (row.smsFallback === "sent") return "sent";
  if (row.smsFallback === "failed" || row.smsFallback === "claimed") return "failed";

  if (!isSmsFallbackEnabled()) return "skipped";
  if (!account || !account.smsFallbackEnabled || account.smsFallbackBlockedAt) return "skipped";
  const message = (input.text ?? "").trim();
  if (!row.toPhone || !row.ghlContactId || !message || isAppOriginatedMessageId(row.ghlMessageId)) return "skipped";

  let claimed = false;
  try {
    if (await optedOutReason(repo, account.locationId, row.tenantId, row.toPhone)) return "opted_out";
    claimed = await repo.claimSmsFallback(row.id);
    if (!claimed) return "busy";
    // The echo first: without it the loop guard could not recognise the SMS.
    await repo.recordSmsFallbackEcho(account.locationId, row.ghlContactId, smsFallbackTextSha256(message), new Date(Date.now() + SMS_FALLBACK_ECHO_MS).toISOString());
    const accessToken = await resolveGhlAccessToken(repo, deps, account);
    const sent = accessToken ? await (deps.sendSms ?? sendGhlSms)(accessToken, { contactId: row.ghlContactId, message }) : { ok: false as const, status: null };
    const outcome = sent.ok ? "sent" : "failed";
    await storeResult(repo, row.id, outcome);
    return outcome;
  } catch {
    console.error("[sms-fallback] fallback SMS could not be sent (non-fatal)");
    if (claimed) await storeResult(repo, row.id, "failed");
    // Unclaimed: the opt-out read failed, so fail closed (no SMS); the trigger
    // path then behaves as it does without the fallback.
    return claimed ? "failed" : "skipped";
  }
}

async function storeResult(repo: SmsFallbackRepo, id: string, result: "sent" | "failed"): Promise<void> {
  try {
    await repo.setSmsFallbackResult(id, result);
  } catch {
    // The claim stays; a later pass reads `claimed` as failed and never resends.
    console.error("[sms-fallback] could not store the fallback outcome (non-fatal)");
  }
}
