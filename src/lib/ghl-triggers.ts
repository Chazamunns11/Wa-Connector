/**
 * Fires PingWren's WhatsApp events to the GHL workflows subscribed to them.
 *
 * Best effort and never throwing: a failed fire is logged with a fixed string
 * and the HTTP status only (never a target URL, token, contact id or payload),
 * and each fire is capped at 5 seconds, so nothing here can delay or change
 * the message flow, the drains or the bridge. With `GHL_WORKFLOW_TRIGGERS_ENABLED`
 * not exactly "true" nothing is read and nothing is POSTed anywhere.
 */
import { API_VERSION } from "@/lib/ghl";
import { resolveGhlAccessToken, type GhlTokenRefreshDeps, type GhlTokenRefreshRepo } from "@/lib/ghl-provider";
import { normalizeTriggerTargetUrl, type TriggerKey } from "@/lib/ghl-trigger-keys";
import type { GhlRepository } from "@/lib/data/repository";

/** Per-fire time limit. */
export const TRIGGER_FIRE_TIMEOUT_MS = 5_000;
/** At most this many targets are POSTed to at once. */
export const TRIGGER_FIRE_CONCURRENCY = 5;

type Number_ = { number: string; numberLabel: string | null };

/** One payload shape per trigger key. `number` is the sub-account's WhatsApp number in E.164. */
export interface TriggerPayloads {
  whatsapp_disconnected: Number_ & {
    reason: "logged_out" | "banned" | "connection_lost";
    heldMessages: number;
    reconnectUrl: string;
  };
  whatsapp_reconnected: Number_ & { downMinutes: number };
  /** No message text, ever. */
  whatsapp_message_received: Number_ & {
    messageType: "text" | "voice_note" | "image" | "video" | "document" | "other";
    contactId: string;
  };
  whatsapp_missed_call: Number_ & { isVideo: boolean; contactId: string };
  /** `messageId` is GHL's message id. */
  whatsapp_message_read: Number_ & { contactId: string; messageId: string };
  /** `message` is the text we could not send, at most 500 code points. */
  whatsapp_not_on_whatsapp: Number_ & { contactId: string; message: string };
}

export type TriggerRepo = GhlTokenRefreshRepo & Pick<GhlRepository, "listTriggerSubscriptions">;

export interface TriggerDeps extends GhlTokenRefreshDeps {
  /** Whether firing is switched on. */
  enabled(): boolean;
  /** Time budget for resolving the location token; defaults to `TRIGGER_FIRE_TIMEOUT_MS`. */
  tokenTimeoutMs?: number;
  postTriggerEvent(targetUrl: string, accessToken: string, payload: object): Promise<{ ok: boolean; status: number | null }>;
}

/**
 * POSTs one trigger event to a GHL workflow `targetUrl`.
 *
 * UNVERIFIED: how GHL expects a custom trigger to be fired (this method, auth
 * and `Version` header, body shape) has not been confirmed. It stays unverified
 * until the sandbox check in Task 7's checklist. This is the single place the
 * firing method lives, so a correction is made here only.
 *
 * Never throws; a timeout or network error is `{ ok: false, status: null }`.
 */
export async function postTriggerEvent(
  targetUrl: string,
  accessToken: string,
  payload: object,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TRIGGER_FIRE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const response = await Promise.race([
      fetchImpl(targetUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeout,
    ]);
    if (!response) return { ok: false, status: null };
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function defaultTriggerDeps(base: GhlTokenRefreshDeps): TriggerDeps {
  return {
    ...base,
    enabled: () => process.env.GHL_WORKFLOW_TRIGGERS_ENABLED === "true",
    postTriggerEvent: (url, token, payload) => postTriggerEvent(url, token, payload),
  };
}

/** Resolves to the promise's value, or null if it takes longer than `ms` (or rejects). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fires `payload` to every subscription of `locationId` for `key`, up to 5 at a time.
 * Returns how many fires succeeded and how many did not (including ones skipped
 * for a bad host or no usable token). Never throws.
 */
export async function fireWorkflowTrigger<K extends TriggerKey>(
  repo: TriggerRepo,
  deps: TriggerDeps,
  locationId: string,
  key: K,
  payload: TriggerPayloads[K]
): Promise<{ fired: number; failed: number }> {
  const result = { fired: 0, failed: 0 };
  try {
    if (!deps.enabled()) return result;
    const subscriptions = await repo.listTriggerSubscriptions(locationId, key);
    if (subscriptions.length === 0) return result;

    const accessToken = await withTimeout(
      (async () => {
        const account = await repo.getGhlAccountByLocationId(locationId);
        return account ? resolveGhlAccessToken(repo, deps, account) : null;
      })(),
      deps.tokenTimeoutMs ?? TRIGGER_FIRE_TIMEOUT_MS
    );
    if (!accessToken) {
      console.error("[ghl-triggers] no usable token, trigger not fired");
      result.failed = subscriptions.length;
      return result;
    }

    for (let i = 0; i < subscriptions.length; i += TRIGGER_FIRE_CONCURRENCY) {
      const batch = subscriptions.slice(i, i + TRIGGER_FIRE_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        batch.map(async (sub) => {
          const target = normalizeTriggerTargetUrl(sub.targetUrl);
          if (!target) {
            console.error("[ghl-triggers] target host not allowed, trigger skipped");
            return false;
          }
          const posted = await deps.postTriggerEvent(target, accessToken, payload);
          if (!posted.ok) console.error(`[ghl-triggers] trigger fire failed (status ${posted.status ?? "none"})`);
          return posted.ok;
        })
      );
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled" && outcome.value) result.fired++;
        else {
          if (outcome.status === "rejected") console.error("[ghl-triggers] trigger fire failed (status none)");
          result.failed++;
        }
      }
    }
  } catch {
    console.error("[ghl-triggers] trigger fire aborted (status none)");
  }
  return result;
}

/**
 * Maps the bridge's stored inbound message type (Baileys content keys) to the
 * trigger's `messageType`. `audioMessage` is a voice note; anything unrecognised
 * is `other`.
 */
export function toTriggerMessageType(bridgeMessageType: string): TriggerPayloads["whatsapp_message_received"]["messageType"] {
  switch (bridgeMessageType) {
    case "conversation":
    case "extendedTextMessage":
      return "text";
    case "audioMessage":
      return "voice_note";
    case "imageMessage":
      return "image";
    case "videoMessage":
      return "video";
    case "documentMessage":
      return "document";
    default:
      return "other";
  }
}
