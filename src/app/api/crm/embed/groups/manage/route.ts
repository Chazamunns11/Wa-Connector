/**
 * POST /api/crm/embed/groups/manage — create, invite to and manage WhatsApp
 * groups for one number, from the GHL Custom Page embed. Body
 * `{ slot?, action, ... }`; every action and its shape is in `logic.ts`.
 *
 * EMBED-ONLY, SLOT-GUARDED, same as `../route.ts`: `authorizeGhlEmbedRequest`
 * resolves `{ slot }` (missing means slot 1) to that number's tenant within
 * the location the verified token proves. The location's account (with its
 * GHL tokens) is then loaded by THAT tenant, and the slot's own label is read
 * for the invite's {coach_name}. Neither is ever returned.
 *
 * A larger body cap than the other embed routes (16 KB): a create can carry
 * 100 contact ids plus a 512-character description.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import {
  createWhatsappGroup,
  getWhatsappGroupDetail,
  getWhatsappGroupInvite,
  leaveWhatsappGroup,
  refreshWhatsappGroups,
  resetWhatsappGroupInvite,
  updateWhatsappGroup,
  updateWhatsappGroupParticipants,
} from "@/lib/whatsapp-bridge";
import { addGhlOutboundMessage, ghlConversationProviderId, searchGhlContacts } from "@/lib/ghl";
import { defaultGhlProviderDeps, optedOutReason, resolveGhlAccessToken } from "@/lib/ghl-provider";
import { defaultResolveInviteesDeps, defaultSendGroupInvitesDeps, resolveInvitees, sendGroupInvites } from "@/lib/group-invites";
import { readSmallJsonBody } from "@/lib/bridge-panel-guard";
import { authorizeGhlEmbedRequest, guardFailureResponseBody, requestedSlotFromBody } from "@/app/api/crm/embed/guard";
import { decideGroupManageRequest, type GroupManageDeps } from "./logic";

export const dynamic = "force-dynamic";

const MAX_MANAGE_BODY_BYTES = 16 * 1024;

const INTERNAL = { ok: false, code: "internal", message: "Something went wrong. Please try again." };

function productionDeps(): GroupManageDeps {
  const resolveDeps = defaultResolveInviteesDeps(repo);
  const sendDeps = defaultSendGroupInvitesDeps(repo, defaultGhlProviderDeps);
  return {
    createGroup: createWhatsappGroup,
    getDetail: getWhatsappGroupDetail,
    updateGroup: updateWhatsappGroup,
    updateParticipants: updateWhatsappGroupParticipants,
    getInvite: getWhatsappGroupInvite,
    resetInvite: resetWhatsappGroupInvite,
    leaveGroup: leaveWhatsappGroup,
    refreshGroups: refreshWhatsappGroups,
    resolveAccessToken: (account) => resolveGhlAccessToken(repo, defaultGhlProviderDeps, account),
    resolveInvitees: (input) => resolveInvitees(resolveDeps, input),
    sendInvites: (input) => sendGroupInvites(sendDeps, input),
    searchContacts: searchGhlContacts,
    optedOutReason: (locationId, tenantId, phone) => optedOutReason(repo, locationId, tenantId, phone),
    postOutboundMessage: addGhlOutboundMessage,
    envConversationProviderId: ghlConversationProviderId(),
  };
}

export async function POST(request: Request) {
  try {
    const body = await readSmallJsonBody(request, MAX_MANAGE_BODY_BYTES);
    const auth = await authorizeGhlEmbedRequest(repo, request.headers.get("authorization"), requestedSlotFromBody(body));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const tenantId = auth.account.tenantId;
    const account = await repo.getGhlAccountByTenantId(tenantId);
    if (!account || account.status === "disabled") return NextResponse.json(INTERNAL, { status: 500 });
    const number = await repo.getLocationNumberBySlot(account.locationId, auth.account.slot);
    const result = await decideGroupManageRequest(repo, productionDeps(), { tenantId, account, slotLabel: number?.label ?? null }, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // Never echoes `err` into the response, and never logs request data.
    console.error("[api/crm/embed/groups/manage] POST failed unexpectedly:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json(INTERNAL, { status: 500 });
  }
}
