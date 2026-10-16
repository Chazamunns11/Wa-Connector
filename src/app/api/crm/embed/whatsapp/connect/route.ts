/**
 * POST /api/crm/embed/whatsapp/connect — the GHL Custom Page embed's
 * "start/restart linking" call. Bearer-token-authenticated by
 * `authorizeGhlEmbedRequest` (src/app/api/crm/embed/guard.ts) — see that
 * file's header for the full check list (config/live-mode gate, token
 * verify, and a fresh, per-call account re-read) this route relies on for
 * both authentication AND the disable-lever revocation guarantee.
 *
 * THE TENANT ID IS NEVER CLIENT-SUPPLIED AND NEVER RETURNED. `account.tenantId`
 * comes ONLY from the guard's own DB re-read, keyed off the `locationId`
 * inside a verified embed token — nothing in the request body names it, and
 * nothing in this route's response echoes it back (`redactBridgeSessionResult`
 * below strips the bridge's own `session.coachId`, which for a GHL location
 * IS that same tenant id — adversarial review lens 4, finding 2's follow-on;
 * see `guard.ts`'s own header for the full rationale). This mirrors every
 * other WhatsApp action in this codebase
 * (`src/app/client/setup/whatsapp-actions.ts`'s "THE ID IS NEVER A PARAMETER"
 * rule): the caller cannot name another location's tenant even if it wanted
 * to, because there is no argument here that would let it, and it cannot
 * learn its own tenant id back from the response either.
 *
 * KIND-PINNING HOLDS STRUCTURALLY, NOT JUST BY CONVENTION (restated from the
 * guard's own header): `ghl_accounts.tenant_id` can only ever reference a
 * `whatsapp_tenants` row of kind `'ghl_location'` (0069's FK constraint) — so
 * the tenant id resolved here can never be a coach's personal WhatsApp
 * tenant id, structurally, regardless of what a forged or manipulated token
 * might claim.
 *
 * The bridge's own discriminated `BridgeSessionResult` is returned, minus
 * `session.coachId`, as this route's JSON body — the shared
 * `WhatsappConnectionPanel` client component already knows how to render
 * every one of its `ok`/`code` branches (it never reads `coachId`), so there
 * is nothing else to translate here.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { connectWhatsappSession } from "@/lib/whatsapp-bridge";
import { authorizeGhlEmbedRequest, guardFailureResponseBody, redactBridgeSessionResult } from "@/app/api/crm/embed/guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authorizeGhlEmbedRequest(repo, request.headers.get("authorization"));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const result = await connectWhatsappSession(auth.account.tenantId);
    return NextResponse.json(redactBridgeSessionResult(result));
  } catch (err) {
    // Adversarial review lens 4, finding 6 (MINOR) — same "genuinely total,
    // not just documented as such" backstop as the guard itself. Nothing
    // downstream of the guard should throw (the bridge client's own contract
    // is "never throws"), but this is the difference between a fixed-string
    // 500 and a stack trace reaching a public route if that contract is ever
    // violated. Never echoes `err` into the response.
    console.error("[api/crm/embed/whatsapp/connect] POST failed unexpectedly:", err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
