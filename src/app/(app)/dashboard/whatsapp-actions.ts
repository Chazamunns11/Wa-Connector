"use server";

import { requireAccountSession } from "@/lib/account-session";
import { redactBridgeSessionResult, type PanelBridgeSessionResult } from "@/lib/bridge-panel-guard";
import { repo } from "@/lib/data";
import {
  connectWhatsappSession,
  getWhatsappBridgeSession,
  logoutWhatsappSession,
  type BridgeOkResult,
} from "@/lib/whatsapp-bridge";

/**
 * Account-scoped twins of the admin connect/poll/logout actions. A QR is a
 * device-link grant, so the tenant id sent to the bridge is only ever read off
 * a location the signed-in account owns; the client supplies a location id and
 * nothing else.
 */

const NOT_FOUND = { ok: false, code: "invalid_coach_id", message: "That sub-account could not be found." } as const;

async function ownedTenantId(accountId: string, locationId: string): Promise<string | null> {
  const owned = await repo.listGhlAccountsForAccount(accountId);
  return owned.find((a) => a.locationId === locationId)?.tenantId ?? null;
}

export async function connectLocationWhatsappAction(locationId: string): Promise<PanelBridgeSessionResult> {
  const session = await requireAccountSession();
  const tenantId = await ownedTenantId(session.accountId, locationId);
  if (!tenantId) return NOT_FOUND;
  return redactBridgeSessionResult(await connectWhatsappSession(tenantId));
}

export async function pollLocationWhatsappAction(locationId: string): Promise<PanelBridgeSessionResult> {
  const session = await requireAccountSession();
  const tenantId = await ownedTenantId(session.accountId, locationId);
  if (!tenantId) return NOT_FOUND;
  return redactBridgeSessionResult(await getWhatsappBridgeSession(tenantId));
}

export async function logoutLocationWhatsappAction(locationId: string): Promise<BridgeOkResult> {
  const session = await requireAccountSession();
  const tenantId = await ownedTenantId(session.accountId, locationId);
  if (!tenantId) return NOT_FOUND;
  return logoutWhatsappSession(tenantId);
}
