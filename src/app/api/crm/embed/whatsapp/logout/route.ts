/**
 * POST /api/crm/embed/whatsapp/logout — the GHL Custom Page embed's unlink
 * call. Same bearer-token guard as `connect`/`status` — see
 * `src/app/api/crm/embed/guard.ts`'s header for the full authorization +
 * per-call revocation contract, and `connect/route.ts`'s header for why
 * `account.tenantId` can never be client-supplied or leaked back out.
 *
 * Returns the bridge's `BridgeOkResult` verbatim, exactly like the other two
 * embed WhatsApp routes — no `session` object on this one, so there is no
 * `coachId` to redact (unlike `connect`/`status`, see their own headers).
 * A failure's `message` is scrubbed of the tenant id all the same
 * (`scrubTenantIdFromFailure`), as the connect-link routes already do.
 *
 * WHICH NUMBER — same optional `{ slot }` body as `connect`/`status` (see
 * `connect/route.ts`'s header): no slot means slot 1. Logs out only the
 * number that slot names; removing a number altogether is the numbers
 * route's job (`src/app/api/crm/embed/numbers/route.ts`).
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { logoutWhatsappSession } from "@/lib/whatsapp-bridge";
import { readSmallJsonBody, scrubTenantIdFromFailure } from "@/lib/bridge-panel-guard";
import { authorizeGhlEmbedRequest, guardFailureResponseBody, requestedSlotFromBody } from "@/app/api/crm/embed/guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const slot = requestedSlotFromBody(await readSmallJsonBody(request));
    const auth = await authorizeGhlEmbedRequest(repo, request.headers.get("authorization"), slot);
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const result = await logoutWhatsappSession(auth.account.tenantId);
    return NextResponse.json(result.ok ? result : scrubTenantIdFromFailure(result, auth.account.tenantId));
  } catch (err) {
    // Adversarial review lens 4, finding 6 (MINOR) — see connect/route.ts's
    // identical comment.
    console.error("[api/crm/embed/whatsapp/logout] POST failed unexpectedly:", err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
