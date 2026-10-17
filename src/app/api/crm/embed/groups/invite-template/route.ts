/**
 * POST /api/crm/embed/groups/invite-template — the sub-account's WhatsApp
 * group invite message: `{}` reads it, `{ template: string }` saves it,
 * `{ template: null }` resets it to the default. Answers
 * `{ ok: true, template, isDefault }`.
 *
 * EMBED-ONLY, LOCATION-GUARDED (`authorizeGhlEmbedLocationRequest`): the
 * wording belongs to the sub-account, not to one number, so no slot is
 * resolved and no tenant id is involved. Every decision is in `logic.ts`
 * (tested in scripts/test/embed-group-manage.test.ts). Same "never a stack
 * trace" backstop as every other embed route.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { readSmallJsonBody } from "@/lib/bridge-panel-guard";
import { authorizeGhlEmbedLocationRequest, guardFailureResponseBody } from "@/app/api/crm/embed/guard";
import { decideInviteTemplateRequest } from "./logic";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authorizeGhlEmbedLocationRequest(repo, request.headers.get("authorization"));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const body = await readSmallJsonBody(request);
    const result = await decideInviteTemplateRequest(repo, auth.location.locationId, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // Never echoes `err` into the response.
    console.error("[api/crm/embed/groups/invite-template] POST failed unexpectedly:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
