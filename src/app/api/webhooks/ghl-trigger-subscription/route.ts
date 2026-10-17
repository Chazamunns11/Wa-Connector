/**
 * POST /api/webhooks/ghl-trigger-subscription — GHL calls this when a workflow
 * subscribes to, changes or drops one of PingWren's workflow triggers. A thin
 * adapter: the decision (secret check, key and host validation, unknown
 * location, upsert/delete) lives in `./logic.ts`. Auth is the
 * `X-PingWren-Secret` header against `GHL_WORKFLOW_WEBHOOK_SECRET`.
 */
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { decideTriggerSubscription } from "./logic";

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const decision = await decideTriggerSubscription(repo, request.headers.get("x-pingwren-secret"), body, {
    secret: process.env.GHL_WORKFLOW_WEBHOOK_SECRET,
  });
  return NextResponse.json(decision.body, { status: decision.status });
}
