/**
 * POST /api/connect/whatsapp/connect — the connect-link feature's
 * "start/restart linking" call. Bearer-token-authenticated by
 * `authorizeConnectRequest` (src/app/api/connect/guard.ts) — see that file's
 * header for the full check list (three config gates, session-token verify,
 * a fresh per-call account re-read, AND the version-mismatch check the embed
 * guard does not have) this route relies on for both authentication AND the
 * revocation guarantee.
 *
 * Structurally identical to `src/app/api/crm/embed/whatsapp/connect/route.ts`
 * — same "the tenant id is never client-supplied and never returned"
 * invariant, same kind-pinning-holds-structurally argument (0069's FK still
 * makes a `ghl_accounts.tenant_id` unable to ever be a coach's own tenant
 * id), same `redactBridgeSessionResult` choke point before this route's
 * `NextResponse.json` — now imported from the shared
 * `src/lib/bridge-panel-guard.ts` rather than a second copy.
 *
 * "NEVER RETURNED" IS NOW TRUE OF THE FAILURE BRANCH TOO — adversarial review
 * lens 5, finding 8 (MINOR, fixed). `redactBridgeSessionResult` only ever
 * stripped `coachId` off a SUCCESS result; a `BridgeFailure`'s own `message`
 * string passed through untouched, which made the invariant above only
 * accidentally true (see `scrubTenantIdFromFailure`'s own JSDoc,
 * src/app/api/connect/guard.ts, for what was verified and why it's now
 * enforced rather than just documented).
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { connectWhatsappSession } from "@/lib/whatsapp-bridge";
import { redactBridgeSessionResult } from "@/lib/bridge-panel-guard";
import { authorizeConnectRequest, guardFailureResponseBody, scrubTenantIdFromFailure } from "@/app/api/connect/guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authorizeConnectRequest(repo, request.headers.get("authorization"));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const result = await connectWhatsappSession(auth.account.tenantId);
    const redacted = redactBridgeSessionResult(result);
    return NextResponse.json(redacted.ok ? redacted : scrubTenantIdFromFailure(redacted, auth.account.tenantId));
  } catch (err) {
    // Same "genuinely total, not just documented as such" backstop as the
    // guard itself. Never echoes `err` into the response.
    console.error("[api/connect/whatsapp/connect] POST failed unexpectedly:", err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
