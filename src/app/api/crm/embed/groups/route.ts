/**
 * POST /api/crm/embed/groups — the GHL Custom Page embed's WhatsApp groups
 * picker for one number (opt-in groups, Task 9):
 *   `{ slot? }`                                   list that number's groups
 *   `{ slot?, groupJid: string, enabled: boolean }` switch one group on/off
 * Success: `{ ok: true, groups: { jid, name, size, enabled, left, live, createdByUs }[] }`,
 * except switching OFF, which answers `{ ok: true, groupJid, enabled: false }`
 * (it never reads the live list — see `logic.ts`'s header).
 *
 * A METHOD, NOT A GET, like every embed route that reads live bridge state
 * (see `src/app/api/crm/embed/whatsapp/status/route.ts`'s header): the slot
 * travels in the JSON body, the bearer token in the header, nothing in a URL.
 *
 * EMBED-ONLY, SLOT-GUARDED. `authorizeGhlEmbedRequest` runs the embed
 * guard's checks in their usual order, then resolves `{ slot }` (missing
 * means slot 1) to that number's tenant within the location the verified
 * token proves (src/app/api/crm/embed/guard.ts, the fifth check). A connect
 * link's token is a different kind and can never verify here.
 *
 * THE TENANT ID IS NEVER CLIENT-SUPPLIED AND NEVER RETURNED — see
 * `logic.ts`'s header, which holds every decision (tested in
 * scripts/test/embed-groups.test.ts). Same "never a stack trace" backstop
 * as every other embed route.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { listWhatsappGroups as listLiveWhatsappGroups, refreshWhatsappGroups } from "@/lib/whatsapp-bridge";
import { readSmallJsonBody } from "@/lib/bridge-panel-guard";
import { authorizeGhlEmbedRequest, guardFailureResponseBody, requestedSlotFromBody } from "@/app/api/crm/embed/guard";
import { decideGroupsRequest } from "./logic";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSmallJsonBody(request);
    const auth = await authorizeGhlEmbedRequest(repo, request.headers.get("authorization"), requestedSlotFromBody(body));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const result = await decideGroupsRequest(
      repo,
      { listLiveGroups: listLiveWhatsappGroups, refreshGroups: refreshWhatsappGroups },
      auth.account.tenantId,
      body
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // Never echoes `err` into the response.
    console.error("[api/crm/embed/groups] POST failed unexpectedly:", err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
