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
 * a location token. Hosts must be `services.leadconnectorhq.com` or below it.
 * Writes are scoped to the location. Nothing here logs the body, the target URL or any id.
 */
import { createHash, timingSafeEqual } from "crypto";
import { isTriggerKey, normalizeTriggerTargetUrl } from "@/lib/ghl-trigger-keys";
import type { GhlRepository } from "@/lib/data/repository";

export type TriggerSubscriptionRepo = Pick<
  GhlRepository,
  "getGhlAccountByLocationId" | "upsertTriggerSubscription" | "deleteTriggerSubscription"
>;

export interface TriggerSubscriptionDecision {
  status: number;
  body: Record<string, unknown>;
}

const MAX_ID_LENGTH = 128;
const MAX_FILTERS = 50;
const MAX_FILTERS_BYTES = 8 * 1024;

/** Compares SHA-256 digests, so neither length nor content short-circuits. */
function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a, "utf8").digest(), createHash("sha256").update(b, "utf8").digest());
}

/**
 * The auth gate, run before the body is read. Returns a refusal (503 when the
 * secret is unset, 401 when the header is missing or wrong) or null when allowed.
 */
export function authorizeTriggerSubscription(
  secretHeader: string | null,
  env: { secret: string | undefined }
): TriggerSubscriptionDecision | null {
  if (!env.secret) return { status: 503, body: { ok: false, error: "not_configured" } };
  if (!secretHeader || !secretsEqual(secretHeader, env.secret)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  return null;
}

function isIdString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
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
  const refusal = authorizeTriggerSubscription(secretHeader, env);
  if (refusal) return refusal;

  if (!isRecord(body) || !isRecord(body.triggerData) || !isRecord(body.extras)) return bad("malformed_body");
  const { id, key, filters, eventType, targetUrl } = body.triggerData;
  const { locationId, workflowId } = body.extras;

  if (!isIdString(id) || !isIdString(locationId)) return bad("malformed_body");
  if (workflowId !== undefined && workflowId !== null && !isIdString(workflowId)) return bad("malformed_body");
  if (eventType !== "CREATED" && eventType !== "UPDATED" && eventType !== "DELETED") return bad("malformed_body");
  if (!isTriggerKey(key)) return bad("unknown_trigger_key");

  try {
    if (eventType === "DELETED") {
      await repo.deleteTriggerSubscription(id, locationId);
      return { status: 200, body: { ok: true } };
    }

    const normalizedUrl = normalizeTriggerTargetUrl(targetUrl);
    if (!normalizedUrl) return bad("invalid_target_url");
    if (filters !== undefined && filters !== null) {
      if (!Array.isArray(filters) || filters.length > MAX_FILTERS) return bad("invalid_filters");
      if (Buffer.byteLength(JSON.stringify(filters), "utf8") > MAX_FILTERS_BYTES) return bad("invalid_filters");
    }

    const account = await repo.getGhlAccountByLocationId(locationId);
    if (!account) return { status: 404, body: { ok: false, error: "unknown_location" } };

    const stored = await repo.upsertTriggerSubscription({
      id,
      locationId,
      workflowId: typeof workflowId === "string" ? workflowId : null,
      triggerKey: key,
      targetUrl: normalizedUrl,
      filters: filters ?? [],
    });
    if (stored === "location_mismatch") return { status: 409, body: { ok: false, error: "location_mismatch" } };
    return { status: 200, body: { ok: true } };
  } catch {
    console.error("[ghl-trigger-subscription] repository error");
    return { status: 500, body: { ok: false, error: "internal" } };
  }
}
