/**
 * The sub-account's group invite message (`ghl_accounts.group_invite_template`),
 * read and edited from inside GHL. PER SUB-ACCOUNT, not per number (Charlie,
 * 17 Oct): `locationId` is what `authorizeGhlEmbedLocationRequest` proved
 * from the verified token, never anything the client sent, so one
 * sub-account can never read or change another's wording.
 *
 *   `{}`                      read it
 *   `{ template: string }`    save it (must include {link}, at most 500 characters)
 *   `{ template: null }`      reset to the default wording
 *
 * Every answer is `{ ok: true, template, isDefault }`, where `template` is
 * the saved wording or the default. Validation failures are the fixed
 * strings from `validateInviteTemplate`. DELIBERATELY ZERO NEXT IMPORTS.
 * No tenant id is read or returned.
 */
import type { GhlRepository } from "@/lib/data";
import { DEFAULT_GROUP_INVITE_TEMPLATE, validateInviteTemplate } from "@/lib/group-invites";

export type InviteTemplateRepo = Pick<GhlRepository, "getGhlAccountByLocationId" | "getGroupInviteTemplate" | "setGroupInviteTemplate">;

export type InviteTemplateResult = { status: number; body: Record<string, unknown> };

function view(stored: string | null): InviteTemplateResult {
  return { status: 200, body: { ok: true, template: stored ?? DEFAULT_GROUP_INVITE_TEMPLATE, isDefault: stored === null } };
}

export async function decideInviteTemplateRequest(
  repo: InviteTemplateRepo,
  locationId: string,
  body: Record<string, unknown> | null
): Promise<InviteTemplateResult> {
  if (body === null) return { status: 400, body: { ok: false, code: "invalid_body", message: "Malformed request." } };
  if (body.template === undefined) return view(await repo.getGroupInviteTemplate(locationId));

  let next: string | null = null;
  if (body.template !== null) {
    const valid = validateInviteTemplate(body.template);
    if (!valid.ok) return { status: 400, body: { ok: false, code: "invalid_template", message: valid.message } };
    next = valid.template;
  }
  // `setGroupInviteTemplate` is a bare update: make sure the row is there first.
  if (!(await repo.getGhlAccountByLocationId(locationId))) {
    return { status: 404, body: { ok: false, code: "unknown_location", message: "This sub-account isn't connected. Reload the page inside HighLevel." } };
  }
  await repo.setGroupInviteTemplate(locationId, next);
  return view(next);
}
