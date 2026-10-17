/**
 * /api/crm/embed/numbers — the GHL Custom Page embed's numbers management
 * (several WhatsApp numbers per location, Task 4):
 *   POST   `{ label?: string }`                                  add a number
 *   DELETE `{ slot }`                                            remove one
 *   PATCH  `{ slot, makeDefault?: true, label?: string | null }` make default / relabel
 * Every success answers `{ ok: true, numbers: { slot, label, isDefault, summary }[] }`
 * (POST adds the new number's `slot`).
 *
 * EMBED-ONLY, AUTHORISED BY THE EMBED GUARD. `authorizeGhlEmbedLocationRequest`
 * (src/app/api/crm/embed/guard.ts) runs the embed guard's config gate, token
 * verify and fresh per-call account re-read (missing -> 403, disabled -> 403),
 * in that order, exactly as the three `whatsapp/*` routes do — minus the slot
 * step, since adding a number has no number to name yet and none of these
 * calls need the guard to hand them a tenant. A connect-link session token is
 * a different token kind (`ghl-connect-session`) and can never verify here:
 * a connect link must never add or remove numbers.
 *
 * THE TENANT ID IS NEVER CLIENT-SUPPLIED AND NEVER RETURNED — see
 * `logic.ts`'s header. The client names a slot; the slot is looked up only
 * within the `locationId` the verified token proves.
 *
 * All the decisions live in `logic.ts` (tested in
 * scripts/test/embed-numbers.test.ts); this file only authorises, reads the
 * body (`readSmallJsonBody`, the same byte-capped reader the `whatsapp/*`
 * routes use) and renders the result. Same "never a stack trace" backstop as
 * every other embed route.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { logoutWhatsappSession } from "@/lib/whatsapp-bridge";
import { readSmallJsonBody } from "@/lib/bridge-panel-guard";
import { authorizeGhlEmbedLocationRequest, guardFailureResponseBody } from "@/app/api/crm/embed/guard";
import { decideAddNumber, decideRemoveNumber, decideUpdateNumber, type NumbersRouteResult } from "./logic";

export const dynamic = "force-dynamic";

type Decide = (locationId: string, body: Record<string, unknown> | null) => Promise<NumbersRouteResult>;

async function handle(request: Request, method: string, decide: Decide): Promise<NextResponse> {
  try {
    const auth = await authorizeGhlEmbedLocationRequest(repo, request.headers.get("authorization"));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const body = await readSmallJsonBody(request);
    const result = await decide(auth.location.locationId, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // Never echoes `err` into the response.
    console.error(`[api/crm/embed/numbers] ${method} failed unexpectedly:`, err);
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request, "POST", (locationId, body) => decideAddNumber(repo, locationId, body));
}

export async function DELETE(request: Request) {
  return handle(request, "DELETE", (locationId, body) =>
    decideRemoveNumber(repo, { logout: logoutWhatsappSession }, locationId, body)
  );
}

export async function PATCH(request: Request) {
  return handle(request, "PATCH", (locationId, body) => decideUpdateNumber(repo, locationId, body));
}
