/**
 * Decision logic for `POST /api/webhooks/ghl-trigger-subscription`, where GHL
 * tells us a workflow subscribed to (or unsubscribed from, or changed) one of
 * our triggers. Deps-injected and free of Next imports so it can be tested
 * with a fake repo (same split as `src/app/api/connect/session/logic.ts`).
 *
 * Auth is a shared secret in `X-PingWren-Secret`, compared in constant time
 * against `GHL_WORKFLOW_WEBHOOK_SECRET`; an unset secret refuses everything
 * (503). Only `https` targets on `services.leadconnectorhq.com` or
 * `*.leadconnectorhq.com` are stored, because we later POST to that URL with
 * a location token. Nothing here logs the body, the target URL or any id.
 */
import { timingSafeEqual } from "crypto";
import { isAllowedTriggerTargetUrl, isTriggerKey } from "@/lib/ghl-trigger-keys";
import type { GhlRepository } from "@/lib/data/repository";

export type TriggerSubscriptionRepo = Pick<
  GhlRepository,
  "getGhlAccountByLocationId" | "upsertTriggerSubscription" | "deleteTriggerSubscription"
>;

export interface TriggerSubscriptionDecision {
  status: number;
  body: Record<string, unknown>;
}

function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const bad = (error: string): TriggerSubscriptionDecision => ({ status: 400, body: { ok: false, error } });

export async function decideTriggerSubscription(
  repo: TriggerSubscriptionRepo,
  secretHeader: string | null,
  body: unknown,
  env: { secret: string | undefined }
): Promise<TriggerSubscriptionDecision> {
  if (!env.secret) return { status: 503, body: { ok: false, error: "not_configured" } };
  if (!secretHeader || !constantTimeEqualStr(secretHeader, env.secret)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  if (!isRecord(body) || !isRecord(body.triggerData) || !isRecord(body.extras)) return bad("malformed_body");
  const { id, key, filters, eventType, targetUrl } = body.triggerData;
  const { locationId, workflowId } = body.extras;

  if (!isNonEmptyString(id) || !isNonEmptyString(locationId)) return bad("malformed_body");
  if (eventType !== "CREATED" && eventType !== "UPDATED" && eventType !== "DELETED") return bad("malformed_body");
  if (!isTriggerKey(key)) return bad("unknown_trigger_key");
  if (eventType !== "DELETED" && !isAllowedTriggerTargetUrl(targetUrl)) return bad("invalid_target_url");

  const account = await repo.getGhlAccountByLocationId(locationId);
  if (!account) return { status: 404, body: { ok: false, error: "unknown_location" } };

  if (eventType === "DELETED") {
    await repo.deleteTriggerSubscription(id);
    return { status: 200, body: { ok: true } };
  }

  await repo.upsertTriggerSubscription({
    id,
    locationId,
    workflowId: isNonEmptyString(workflowId) ? workflowId : null,
    triggerKey: key,
    targetUrl: targetUrl as string,
    filters: filters ?? [],
  });
  return { status: 200, body: { ok: true } };
}
