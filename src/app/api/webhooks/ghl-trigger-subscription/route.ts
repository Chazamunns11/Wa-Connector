/**
 * POST /api/webhooks/ghl-trigger-subscription — GHL calls this when a workflow
 * subscribes to, changes or drops one of PingWren's workflow triggers. A thin
 * adapter: the decision (secret check, key and host validation, unknown
 * location, upsert/delete) lives in `./logic.ts`. Auth is the
 * `X-PingWren-Secret` header against `GHL_WORKFLOW_WEBHOOK_SECRET`.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { authorizeTriggerSubscription, decideTriggerSubscription } from "./logic";

export async function POST(request: Request) {
  const env = { secret: process.env.GHL_WORKFLOW_WEBHOOK_SECRET };
  const secretHeader = request.headers.get("x-pingwren-secret");
  // Auth before the body is read.
  const refusal = authorizeTriggerSubscription(secretHeader, env);
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const decision = await decideTriggerSubscription(repo, secretHeader, body, env);
  return NextResponse.json(decision.body, { status: decision.status });
}
