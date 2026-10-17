/**
 * The sub-account's message settings: the two switches for posting WhatsApp
 * reactions and "deleted message" notices into GHL (`ghl_accounts.show_reactions`
 * / `show_deletes`, both off by default), and the SMS fallback switch
 * (`ghl_accounts.sms_fallback_enabled`, on by default, 0014). PER SUB-ACCOUNT:
 * `locationId` is what `authorizeGhlEmbedLocationRequest` proved from the
 * verified token, never anything the client sent.
 *
 *   `{}`                                             read
 *   `{ showReactions?, showDeletes?, smsFallback? }` write the ones given (booleans only)
 *
 * Every answer is `{ ok: true, showReactions, showDeletes, smsFallback,
 * smsFallbackBlocked }`. `smsFallbackBlocked` is true once the loop guard
 * switched the fallback off (this sub-account's SMS goes through PingWren);
 * `smsFallback` then reads false, and switching it on again clears the block.
 * DELIBERATELY ZERO NEXT IMPORTS. No tenant id is read or returned.
 */
import type { GhlRepository } from "@/lib/data";
import type { GhlAccount } from "@/lib/types";
import { isSmsFallbackEnabled } from "@/lib/ghl";

export type MessageEventsRepo = Pick<GhlRepository, "getGhlAccountByLocationId" | "setMessageEventSettings" | "setSmsFallbackEnabled">;

export type MessageEventsResult = { status: number; body: Record<string, unknown> };

const UNKNOWN_LOCATION: MessageEventsResult = {
  status: 404,
  body: { ok: false, code: "unknown_location", message: "This sub-account isn't connected. Reload the page inside HighLevel." },
};

export async function decideMessageEventsRequest(
  repo: MessageEventsRepo,
  locationId: string,
  body: Record<string, unknown> | null
): Promise<MessageEventsResult> {
  const malformed: MessageEventsResult = { status: 400, body: { ok: false, code: "invalid_body", message: "Malformed request." } };
  if (body === null) return malformed;

  const settings: { showReactions?: boolean; showDeletes?: boolean } = {};
  for (const key of ["showReactions", "showDeletes"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return malformed;
    settings[key] = body[key];
  }
  if (body.smsFallback !== undefined && typeof body.smsFallback !== "boolean") return malformed;
  const smsFallback = body.smsFallback as boolean | undefined;

  // The writes are bare updates: make sure the row is there first.
  if (!(await repo.getGhlAccountByLocationId(locationId))) return UNKNOWN_LOCATION;
  if (settings.showReactions !== undefined || settings.showDeletes !== undefined) {
    await repo.setMessageEventSettings(locationId, settings);
  }
  if (smsFallback !== undefined) await repo.setSmsFallbackEnabled(locationId, smsFallback);
  const account = await repo.getGhlAccountByLocationId(locationId);
  if (!account) return UNKNOWN_LOCATION;
  return { status: 200, body: settingsBody(account) };
}

function settingsBody(account: GhlAccount): Record<string, unknown> {
  const blocked = typeof account.smsFallbackBlockedAt === "string";
  return {
    ok: true,
    showReactions: account.showReactions === true,
    showDeletes: account.showDeletes === true,
    smsFallback: account.smsFallbackEnabled !== false && !blocked,
    smsFallbackBlocked: blocked,
    // false while the global GHL_SMS_FALLBACK_ENABLED switch is off: the UI hides the toggle.
    smsFallbackAvailable: isSmsFallbackEnabled(),
  };
}
