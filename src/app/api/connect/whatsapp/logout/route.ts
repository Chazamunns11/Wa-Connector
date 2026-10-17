/**
 * POST /api/connect/whatsapp/logout — the connect-link feature's unlink
 * call. Same bearer-token guard as `connect`/`status` — see
 * `src/app/api/connect/guard.ts`'s header for the full authorization +
 * revocation contract, and `connect/route.ts`'s header for why
 * `account.tenantId` can never be client-supplied or leaked back out.
 *
 * Returns the bridge's `BridgeOkResult` verbatim, exactly like the embed's
 * identical route — no `session` object on this one, so there is no
 * `coachId` to redact. `message` on the FAILURE branch is scrubbed of
 * `auth.account.tenantId` all the same, though — adversarial review lens 5,
 * finding 8 (MINOR, fixed) — see `scrubTenantIdFromFailure`'s own JSDoc
 * (src/app/api/connect/guard.ts): "no coachId to redact" was never the same
 * claim as "no tenant id could ever appear in this response", and
 * `BridgeOkResult`'s failure variant is the exact same free-form-`message`
 * `BridgeFailure` shape `connect`/`status` share. *
 * WHICH NUMBER (Task 4): the one the SIGNED session token's slot names —
 * never a request body field (see `src/app/api/connect/guard.ts`'s header,
 * check 8). A slot whose number has been removed is 404 `unknown_number`.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { logoutWhatsappSession } from "@/lib/whatsapp-bridge";
import { authorizeConnectRequest, guardFailureResponseBody, scrubTenantIdFromFailure } from "@/app/api/connect/guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authorizeConnectRequest(repo, request.headers.get("authorization"));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const result = await logoutWhatsappSession(auth.account.tenantId);
    return NextResponse.json(result.ok ? result : scrubTenantIdFromFailure(result, auth.account.tenantId));
  } catch (err) {
    console.error("[api/connect/whatsapp/logout] POST failed unexpectedly:", err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
