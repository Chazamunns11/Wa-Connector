"use server";

/**
 * Dashboard number management for agency owners: list, add, rename, make
 * default, remove, and connect each number by QR. The rules are the same
 * ones the in-HighLevel page uses (`src/app/api/crm/embed/numbers/logic.ts`:
 * at most 3, activated and paid up before adding, never remove the last,
 * log a number out before deleting it). Every action first checks the
 * sub-account is one of this account's own (`ownsLocation`); the browser
 * names a number by slot, never by tenant id, and never sees one.
 */
import { requireAccountSession } from "@/lib/account-session";
import { redactBridgeSessionResult, type PanelBridgeSessionResult } from "@/lib/bridge-panel-guard";
import { repo } from "@/lib/data";
import { NOT_FOUND, ownsLocation, runOwnedNumberAction } from "@/lib/site/owned-whatsapp";
import { connectLinkForOwnedLocation } from "@/lib/account-data/connect-link";
import { parseSlotParam } from "@/lib/location-numbers";
import { connectWhatsappSession, getWhatsappBridgeSession, logoutWhatsappSession, type BridgeOkResult } from "@/lib/whatsapp-bridge";
import {
  decideAddNumber,
  decideRemoveNumber,
  decideUpdateNumber,
  listEmbedNumbers,
  type EmbedNumberView,
  type NumbersRouteResult,
} from "@/app/api/crm/embed/numbers/logic";

export type NumbersResult = { ok: true; numbers: EmbedNumberView[] } | { ok: false; message: string };

const NOT_YOURS: NumbersResult = { ok: false, message: NOT_FOUND.message };

function toResult(r: NumbersRouteResult): NumbersResult {
  return r.status === 200 ? { ok: true, numbers: r.body.numbers } : { ok: false, message: r.body.message };
}

export async function listNumbersAction(locationId: string): Promise<NumbersResult> {
  const session = await requireAccountSession();
  if (!(await ownsLocation(repo, session.accountId, locationId))) return NOT_YOURS;
  return { ok: true, numbers: await listEmbedNumbers(repo, locationId) };
}

export async function addNumberAction(locationId: string, label: string): Promise<NumbersResult> {
  const session = await requireAccountSession();
  if (!(await ownsLocation(repo, session.accountId, locationId))) return NOT_YOURS;
  return toResult(await decideAddNumber(repo, locationId, label.trim() ? { label } : {}));
}

export async function updateNumberAction(
  locationId: string,
  change: { slot: number; makeDefault?: true; label?: string | null }
): Promise<NumbersResult> {
  const session = await requireAccountSession();
  if (!(await ownsLocation(repo, session.accountId, locationId))) return NOT_YOURS;
  const body: Record<string, unknown> = { slot: change.slot };
  if (change.makeDefault === true) body.makeDefault = true;
  if (change.label !== undefined) body.label = change.label;
  return toResult(await decideUpdateNumber(repo, locationId, body));
}

export async function removeNumberAction(locationId: string, slot: number): Promise<NumbersResult> {
  const session = await requireAccountSession();
  if (!(await ownsLocation(repo, session.accountId, locationId))) return NOT_YOURS;
  return toResult(await decideRemoveNumber(repo, { logout: logoutWhatsappSession }, locationId, { slot }));
}

export async function connectNumberAction(locationId: string, slot: number): Promise<PanelBridgeSessionResult> {
  const session = await requireAccountSession();
  const result = await runOwnedNumberAction(repo, session.accountId, locationId, slot, connectWhatsappSession);
  return result === NOT_FOUND ? NOT_FOUND : redactBridgeSessionResult(result);
}

export async function pollNumberAction(locationId: string, slot: number): Promise<PanelBridgeSessionResult> {
  const session = await requireAccountSession();
  const result = await runOwnedNumberAction(repo, session.accountId, locationId, slot, getWhatsappBridgeSession);
  return result === NOT_FOUND ? NOT_FOUND : redactBridgeSessionResult(result);
}

/** A 7-day link to send to whoever holds that number's phone; null if links aren't configured or it isn't this account's sub-account. */
export async function numberLinkAction(locationId: string, slot: number): Promise<string | null> {
  const session = await requireAccountSession();
  const parsed = parseSlotParam(slot, { required: true });
  if (!parsed.ok) return null;
  if (!(await ownsLocation(repo, session.accountId, locationId))) return null;
  return connectLinkForOwnedLocation(session.accountId, locationId, parsed.slot);
}

export async function logoutNumberAction(locationId: string, slot: number): Promise<BridgeOkResult> {
  const session = await requireAccountSession();
  return runOwnedNumberAction(repo, session.accountId, locationId, slot, logoutWhatsappSession);
}
