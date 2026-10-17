/**
 * The GHL Custom Page embed's WhatsApp groups picker (opt-in groups, Task 9):
 * list one number's groups and switch one on or off. Split out of `route.ts`
 * so `scripts/test/embed-groups.test.ts` can drive it with a fake repo and a
 * fake bridge — the same "decision logic deps-injected, route a thin
 * adapter" split as `src/app/api/crm/embed/numbers/logic.ts`.
 *
 * DELIBERATELY ZERO NEXT IMPORTS, same discipline as
 * `src/lib/bridge-panel-guard.ts`.
 *
 * EMBED-ONLY, ONE NUMBER. Called only from `route.ts`, behind
 * `authorizeGhlEmbedRequest` — the slot-guarded embed guard, which resolves
 * the request's `{ slot }` to that number's tenant within the location the
 * verified token proves. `tenantId` below is that guard's answer, never
 * anything the client sent.
 *
 * WHAT IS RETURNED: `{ jid, name, size, enabled, left }` per group, built by
 * ENUMERATING fields (never spreading a `WhatsappGroup`, which carries the
 * tenant id). The JID IS returned — it is WhatsApp's own group id, not a
 * tenant id, and the owner has to say which group to switch. Bridge failure
 * messages are never forwarded (they can name the tenant): every failure is
 * a fixed sentence.
 *
 * THE LIST is WhatsApp's LIVE list (`listWhatsappGroups` on the bridge —
 * only groups the number is in right now) merged with the stored switches
 * (`whatsapp_groups`). A stored group that is not in the live list and is
 * switched on or marked left is appended as `left: true` (size 0 — the
 * bridge no longer sees it), so the owner can see why it went quiet. Such a
 * group has no switch: toggling only works for a live group.
 *
 * THE SWITCH stores the LIVE name (never a client-supplied one), then asks
 * the bridge to reload its enabled set (`refreshGroups`) for THIS tenant. A
 * failed reload answers 502 so the owner tries again; re-sending the same
 * switch is harmless (an upsert, then another reload).
 *
 * ONE METHOD, TWO SHAPES (the embed routes' convention: authenticated POSTs
 * with a JSON body, never a token-bearing GET — see
 * `src/app/api/crm/embed/whatsapp/status/route.ts`'s header): `{ slot }`
 * lists, `{ slot, groupJid, enabled }` switches. Half a switch is a
 * malformed request, never silently a list.
 */
import type { GhlRepository } from "@/lib/data";
import type { WhatsappGroup } from "@/lib/types";
import type { BridgeGroup, BridgeGroupsResult, BridgeOkResult } from "@/lib/whatsapp-bridge";
import type { GuardFailureBody } from "@/lib/bridge-panel-guard";

/** The narrow repo slice this module touches — `repo` in production, a fake in tests. */
export type EmbedGroupsRepo = Pick<GhlRepository, "listWhatsappGroups" | "setWhatsappGroupEnabled">;

/** The two bridge calls — `listWhatsappGroups` / `refreshWhatsappGroups` from `@/lib/whatsapp-bridge` in production. */
export interface EmbedGroupsDeps {
  listLiveGroups: (tenantId: string) => Promise<BridgeGroupsResult>;
  refreshGroups: (tenantId: string) => Promise<BridgeOkResult>;
}

/** What the browser sees for one group. Structurally unable to carry a tenant id. */
export interface EmbedGroupView {
  jid: string;
  name: string;
  /** Member count; 0 for a group the number has left. */
  size: number;
  enabled: boolean;
  left: boolean;
}

export type GroupsRouteResult =
  | { status: 200; body: { ok: true; groups: EmbedGroupView[] } }
  | { status: 400 | 404 | 409 | 502; body: GuardFailureBody };

function failure(status: 400 | 404 | 409 | 502, code: string, message: string): GroupsRouteResult {
  return { status, body: { ok: false, code, message } };
}

// Fixed strings, shown in GHL verbatim.
const INVALID_BODY = () => failure(400, "invalid_body", "Malformed request.");
const UNKNOWN_GROUP = () => failure(404, "unknown_group", "That WhatsApp group wasn't found on this number.");
const NOT_CONNECTED = () =>
  failure(409, "session_not_connected", "This WhatsApp number isn't connected. Connect it to see its groups.");
const GROUPS_UNAVAILABLE = () => failure(502, "groups_unavailable", "Couldn't load this number's WhatsApp groups. Please try again.");
const REFRESH_FAILED = () =>
  failure(502, "groups_refresh_failed", "Saved, but WhatsApp hasn't picked up the change yet. Please try again.");

/** Bridge codes that mean "this number has no open WhatsApp session" — the not-connected answer. */
const NOT_CONNECTED_CODES = new Set(["session_not_connected", "not_found"]);

type GroupsRequest = { kind: "list" } | { kind: "toggle"; groupJid: string; enabled: boolean } | { kind: "invalid" };

/** `{ slot }` lists; `{ slot, groupJid: string, enabled: boolean }` switches; anything else is malformed. `null` is `readSmallJsonBody`'s malformed body. */
function parseGroupsRequest(body: Record<string, unknown> | null): GroupsRequest {
  if (body === null) return { kind: "invalid" };
  const hasJid = body.groupJid !== undefined;
  const hasEnabled = body.enabled !== undefined;
  if (!hasJid && !hasEnabled) return { kind: "list" };
  if (typeof body.groupJid !== "string" || typeof body.enabled !== "boolean") return { kind: "invalid" };
  return { kind: "toggle", groupJid: body.groupJid, enabled: body.enabled };
}

/** Live groups first (in the bridge's order), each with its stored switch; then stored groups the number has left. */
function mergeGroups(live: BridgeGroup[], stored: WhatsappGroup[]): EmbedGroupView[] {
  const storedByJid = new Map(stored.map((g) => [g.groupJid, g]));
  const liveJids = new Set(live.map((g) => g.jid));
  const views: EmbedGroupView[] = live.map((g) => ({
    jid: g.jid,
    name: g.name,
    size: g.size,
    enabled: storedByJid.get(g.jid)?.enabled ?? false,
    left: false,
  }));
  for (const g of stored) {
    if (liveJids.has(g.groupJid) || (!g.enabled && g.leftAt === null)) continue;
    views.push({ jid: g.groupJid, name: g.name, size: 0, enabled: g.enabled, left: true });
  }
  return views;
}

function bridgeFailure(result: { code: string }): GroupsRouteResult {
  return NOT_CONNECTED_CODES.has(result.code) ? NOT_CONNECTED() : GROUPS_UNAVAILABLE();
}

/** The whole route, for one already-authorised number (`tenantId` from the slot guard). Never echoes a tenant id. */
export async function decideGroupsRequest(
  repo: EmbedGroupsRepo,
  deps: EmbedGroupsDeps,
  tenantId: string,
  body: Record<string, unknown> | null
): Promise<GroupsRouteResult> {
  const request = parseGroupsRequest(body);
  if (request.kind === "invalid") return INVALID_BODY();

  const live = await deps.listLiveGroups(tenantId);
  if (!live.ok) return bridgeFailure(live);

  if (request.kind === "toggle") {
    // Only a group WhatsApp itself lists for this number, by exact JID — the
    // name stored is WhatsApp's, never the client's.
    const target = live.groups.find((g) => g.jid === request.groupJid);
    if (!target) return UNKNOWN_GROUP();
    await repo.setWhatsappGroupEnabled(tenantId, target.jid, target.name, request.enabled);
    const refreshed = await deps.refreshGroups(tenantId);
    if (!refreshed.ok) {
      // Never logs the tenant id or the bridge's message — the code is enough to act on.
      console.warn(`[api/crm/embed/groups] bridge reload after a group switch failed with code ${refreshed.code}`);
      return REFRESH_FAILED();
    }
  }

  const stored = await repo.listWhatsappGroups(tenantId);
  return { status: 200, body: { ok: true, groups: mergeGroups(live.groups, stored) } };
}
