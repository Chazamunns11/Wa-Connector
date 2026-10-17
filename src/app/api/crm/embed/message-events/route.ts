/**
 * POST /api/crm/embed/message-events — the sub-account's switches for posting
 * reactions and deleted-message notices into GHL, and for the SMS fallback:
 * `{}` reads them, `{ showReactions?, showDeletes?, smsFallback? }` saves.
 * Answers `{ ok: true, showReactions, showDeletes, smsFallback, smsFallbackBlocked }`.
 *
 * EMBED-ONLY, LOCATION-GUARDED (`authorizeGhlEmbedLocationRequest`): the
 * settings belong to the sub-account, not to one number, so no slot is
 * resolved and no tenant id is involved. Every decision is in `logic.ts`
 * (tested in scripts/test/embed-message-events.test.ts).
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { readSmallJsonBody } from "@/lib/bridge-panel-guard";
import { authorizeGhlEmbedLocationRequest, guardFailureResponseBody } from "@/app/api/crm/embed/guard";
import { decideMessageEventsRequest } from "./logic";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authorizeGhlEmbedLocationRequest(repo, request.headers.get("authorization"));
    if (!auth.ok) {
      return NextResponse.json(guardFailureResponseBody(auth), { status: auth.status });
    }
    const body = await readSmallJsonBody(request);
    const result = await decideMessageEventsRequest(repo, auth.location.locationId, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // Never echoes `err` into the response.
    console.error("[api/crm/embed/message-events] POST failed unexpectedly:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ ok: false, code: "internal", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
