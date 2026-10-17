/**
 * POST /api/crm/embed/whatsapp/status — the GHL Custom Page embed's poll
 * target during linking, and the ONLY path a live QR string travels to a
 * GHL sub-account client's browser tab. Same bearer-token guard as
 * `connect`/`logout` — see `src/app/api/crm/embed/guard.ts`'s header for the
 * full authorization + per-call revocation contract, and
 * `src/app/api/crm/embed/whatsapp/connect/route.ts`'s header for why
 * `account.tenantId` can never be client-supplied or leaked back out
 * (including via the bridge's own `session.coachId`, which
 * `redactBridgeSessionResult` strips below).
 *
 * A METHOD, NOT A GET: this reads live bridge state via an authenticated
 * POST (not a GET with the token as a query param) so the bearer token never
 * has a reason to appear in a URL, server access log, or browser history —
 * same discipline `WhatsappConnectionPanel`'s own QR-string handling already
 * enforces (see that component's header: "never revalidated, never placed in
 * a URL or query param, never logged").
 *
 * Returns the bridge's `BridgeSessionResult` verbatim minus `session.coachId`,
 * exactly like `connect`. *
 * WHICH NUMBER (several WhatsApp numbers per location, Task 4). The body may
 * name a slot, `{ slot?: 1 | 2 | 3 }` (no body, or no `slot`, means slot 1 —
 * the pre-slot client sends none and keeps working). The guard resolves it
 * to that number's tenant WITHIN the location the verified token proves,
 * after every older check: anything but exactly 1-3 is 400 `invalid_slot`, a
 * slot the location has no number in is 404 `unknown_number` (see
 * `guard.ts`'s header, the fifth check). The client still never names a
 * tenant, and `toPanelBridgeResponse` (src/lib/bridge-panel-guard.ts) both
 * strips `session.coachId` and scrubs the tenant out of a failure message.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { getWhatsappBridgeSession } from "@/lib/whatsapp-bridge";
import { readSmallJsonBody, toPanelBridgeResponse } from "@/lib/bridge-panel-guard";
import { authorizeGhlEmbedRequest, guardFailureResponseBody, requestedSlotFromBody } from "@/app/api/crm/embed/guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const slot = requestedSlotFromBody(await readSmallJsonBody(request));
    const auth = await authorizeGhlEmbedRequest(repo, request.headers.get("authorization"), slot);
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const result = await getWhatsappBridgeSession(auth.account.tenantId);
    return NextResponse.json(toPanelBridgeResponse(result, auth.account.tenantId));
  } catch (err) {
    // Adversarial review lens 4, finding 6 (MINOR) — see connect/route.ts's
    // identical comment.
    console.error("[api/crm/embed/whatsapp/status] POST failed unexpectedly:", err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
