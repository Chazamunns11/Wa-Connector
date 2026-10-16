"use server";

import { requireAccountSession } from "@/lib/account-session";
import { redactBridgeSessionResult, type PanelBridgeSessionResult } from "@/lib/bridge-panel-guard";
import { repo } from "@/lib/data";
import { NOT_FOUND, runOwnedWhatsappAction } from "@/lib/site/owned-whatsapp";
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

export async function connectLocationWhatsappAction(locationId: string): Promise<PanelBridgeSessionResult> {
  const session = await requireAccountSession();
  const result = await runOwnedWhatsappAction(repo, session.accountId, locationId, connectWhatsappSession);
  return result === NOT_FOUND ? NOT_FOUND : redactBridgeSessionResult(result);
}

export async function pollLocationWhatsappAction(locationId: string): Promise<PanelBridgeSessionResult> {
  const session = await requireAccountSession();
  const result = await runOwnedWhatsappAction(repo, session.accountId, locationId, getWhatsappBridgeSession);
  return result === NOT_FOUND ? NOT_FOUND : redactBridgeSessionResult(result);
}

export async function logoutLocationWhatsappAction(locationId: string): Promise<BridgeOkResult> {
  const session = await requireAccountSession();
  return runOwnedWhatsappAction(repo, session.accountId, locationId, logoutWhatsappSession);
}
