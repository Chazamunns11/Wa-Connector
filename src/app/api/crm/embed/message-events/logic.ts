/**
 * The sub-account's two switches for posting WhatsApp reactions and
 * "deleted message" notices into GHL (`ghl_accounts.show_reactions` /
 * `show_deletes`, both off by default). PER SUB-ACCOUNT: `locationId` is what
 * `authorizeGhlEmbedLocationRequest` proved from the verified token, never
 * anything the client sent.
 *
 *   `{}`                                    read
 *   `{ showReactions?, showDeletes? }`      write the ones given (booleans only)
 *
 * Every answer is `{ ok: true, showReactions, showDeletes }`. DELIBERATELY
 * ZERO NEXT IMPORTS. No tenant id is read or returned.
 */
import type { GhlRepository } from "@/lib/data";

export type MessageEventsRepo = Pick<GhlRepository, "getGhlAccountByLocationId" | "setMessageEventSettings">;

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

  // The write is a bare update: make sure the row is there first.
  if (!(await repo.getGhlAccountByLocationId(locationId))) return UNKNOWN_LOCATION;
  if (settings.showReactions !== undefined || settings.showDeletes !== undefined) {
    await repo.setMessageEventSettings(locationId, settings);
  }
  const account = await repo.getGhlAccountByLocationId(locationId);
  if (!account) return UNKNOWN_LOCATION;
  return { status: 200, body: { ok: true, showReactions: account.showReactions === true, showDeletes: account.showDeletes === true } };
}
