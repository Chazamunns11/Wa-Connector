/**
 * POST /api/connect/whatsapp/status — the connect-link feature's poll
 * target during linking, and the ONLY path a live QR string travels to a
 * client's browser tab on this surface. Same bearer-token guard as
 * `connect`/`logout` — see `src/app/api/connect/guard.ts`'s header for the
 * full authorization + per-call revocation contract (including the
 * version-mismatch check that makes an in-progress "Revoke all links" click
 * cut this off within one poll tick, same as `disabled` does), and
 * `src/app/api/connect/whatsapp/connect/route.ts`'s header for why
 * `account.tenantId` can never be client-supplied or leaked back out.
 *
 * A METHOD, NOT A GET — same reasoning as the embed's identical route: the
 * session token never has a reason to appear in a URL, server access log, or
 * browser history.
 *
 * Returns the bridge's `BridgeSessionResult` verbatim minus `session.coachId`
 * (`redactBridgeSessionResult`, src/lib/bridge-panel-guard.ts), exactly like
 * `connect` — including that route's finding-8 fix (`scrubTenantIdFromFailure`,
 * src/app/api/connect/guard.ts): a `BridgeFailure`'s own `message` is
 * defensively scrubbed of `auth.account.tenantId` too, not just a success
 * result's `session.coachId`. *
 * WHICH NUMBER (Task 4): the one the SIGNED session token's slot names —
 * never a request body field (see `src/app/api/connect/guard.ts`'s header,
 * check 8). A slot whose number has been removed is 404 `unknown_number`.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { getWhatsappBridgeSession } from "@/lib/whatsapp-bridge";
import { toPanelBridgeResponse } from "@/lib/bridge-panel-guard";
import { authorizeConnectRequest, guardFailureResponseBody } from "@/app/api/connect/guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authorizeConnectRequest(repo, request.headers.get("authorization"));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const result = await getWhatsappBridgeSession(auth.account.tenantId);
    // Redact `session.coachId` and scrub a failure message — one tested choke point.
    return NextResponse.json(toPanelBridgeResponse(result, auth.account.tenantId));
  } catch (err) {
    console.error("[api/connect/whatsapp/status] POST failed unexpectedly:", err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
