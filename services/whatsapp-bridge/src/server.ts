/**
 * The bridge's HTTP API — the contract the portal's typed client
 * (src/lib/whatsapp-bridge.ts in the Next app) and the later UI package
 * build against. Deliberately plain `node:http` + a tiny hand-rolled router:
 * five routes do not justify a framework dependency on a box whose rows are
 * WhatsApp credentials (smallest possible supply chain, mirrors the portal's
 * plain-fetch habit in src/lib/slack.ts / automations.ts).
 *
 * AUTH (hard rule 2): every route except GET /health requires
 * `Authorization: Bearer <WA_BRIDGE_SECRET>`, compared constant-time
 * (timingSafeEqual — the same helper shape as the portal's cron routes,
 * src/app/api/cron/reminders/route.ts). The portal is the ONLY intended
 * caller; coaches never talk to the bridge directly.
 *
 * WHY A CALLER STILL CANNOT CROSS COACHES: the secret authenticates "this is
 * the portal", and the portal's own session/role checks decide which coach a
 * user may act for BEFORE it ever calls here. Inside the bridge, the coach
 * id in the PATH is the only session selector — it is matched as a strict
 * UUID, `SessionManager.send` resolves `sessions.get(coachId)` by that exact
 * key, and no field in any request BODY is ever used to pick a socket. So
 * even a malformed/hostile body cannot make coach A's message leave coach
 * B's number; the worst a body can do is fail validation.
 *
 * ERROR SHAPE (uniform): non-2xx responses are
 *   { ok: false, error: { code, message } }
 * with a machine `code` the portal client switches on. Error messages are
 * fixed strings — never a stack, never an upstream error body, and never
 * anything derived from credential material (hard rule 1).
 *
 * ROUTES (the full contract — see the README for request/response examples):
 *   GET  /health                                        (no auth)
 *   POST /sessions/:coachId/connect
 *   GET  /sessions/:coachId
 *   POST /sessions/:coachId/logout
 *   POST /sessions/:coachId/send                        {to, text, idempotencyKey}
 *   GET  /sessions/:coachId/messages/:idempotencyKey
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeStore } from "./store.js";
import { LeaseUnavailableError, ShuttingDownError, type SessionManager } from "./sessions.js";
import { isE164 } from "./phone.js";

/** Mirrors src/app/api/cron/reminders/route.ts's `constantTimeEqualStr` — length check first, then timingSafeEqual. */
export function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Idempotency keys are caller-chosen (the future whatsapp step passes its run id) — printable, bounded, no path-hostile characters. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** WhatsApp's own text limit is 65536; sequences send short follow-ups. Bounded so a runaway template cannot become a megabyte POST. */
const MAX_TEXT_LENGTH = 4096;
const MAX_BODY_BYTES = 64 * 1024;
/** Media plan (docs/MEDIA-PLAN.md §5.3) — attachment URL length bound; the URL itself is never persisted (0046's no-bodies rule extends to this). */
const MAX_ATTACHMENT_URL_LENGTH = 2048;
/** Media plan (docs/MEDIA-PLAN.md §5.3) — display name for documents. */
const MAX_ATTACHMENT_FILENAME_LENGTH = 128;

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}

async function readJsonBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

export interface ServerDeps {
  manager: SessionManager;
  store: BridgeStore;
  bridgeSecret: string;
  log: Logger;
  /** Media plan (docs/MEDIA-PLAN.md §5.3) — `WA_MEDIA_OUTBOUND_ENABLED`. Defaults `false`: the `attachment` body shape is refused (422) regardless of anything else while this is off, exactly as if the shape didn't exist — see the send route below. */
  mediaOutboundEnabled?: boolean;
}

export function createBridgeServer(deps: ServerDeps): Server {
  const { manager, store, bridgeSecret, log } = deps;
  const mediaOutboundEnabled = deps.mediaOutboundEnabled ?? false;
  const bootedAt = Date.now();

  return createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Last-resort catch: fixed string out, details to logs only — an
      // unexpected throw must never leak internals into a response.
      log.error({ err: (err as Error).message, url: req.url }, "unhandled route error");
      if (!res.headersSent) sendError(res, 500, "internal", "internal error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://bridge.internal");
    const parts = url.pathname.split("/").filter(Boolean);

    // GET /health — unauthenticated (Railway healthcheck can't set headers).
    // Liveness only: no session data, no coach ids, nothing enumerable.
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, uptimeSec: Math.floor((Date.now() - bootedAt) / 1000) });
      return;
    }

    // --- auth gate for everything else (hard rule 2) -----------------------
    const auth = req.headers.authorization ?? "";
    if (!constantTimeEqualStr(auth, `Bearer ${bridgeSecret}`)) {
      sendError(res, 401, "unauthorized", "missing or invalid bearer token");
      return;
    }

    // --- /sessions/:coachId[/…] --------------------------------------------
    if (parts[0] !== "sessions" || !parts[1]) {
      sendError(res, 404, "not_found", "unknown route");
      return;
    }
    const coachId = parts[1];
    if (!UUID_RE.test(coachId)) {
      sendError(res, 400, "invalid_coach_id", "coach id must be a UUID");
      return;
    }

    // POST /sessions/:coachId/connect
    if (req.method === "POST" && parts[2] === "connect" && parts.length === 3) {
      // GHL provider Phase 1 (portal migration 0069_ghl_provider.sql) — this
      // id is a whatsapp_tenants id now, not always a coaches id; the check
      // itself (`tenantExists`, renamed from `coachExists`) and the route
      // path/param name are otherwise unchanged.
      if (!(await store.tenantExists(coachId))) {
        sendError(res, 404, "not_found", "no such tenant");
        return;
      }
      try {
        await manager.startSession(coachId);
      } catch (err) {
        if (err instanceof LeaseUnavailableError) {
          // An overlapping deploy still owns the session — tell the portal to
          // retry shortly rather than pretending failure.
          sendError(res, 503, "lease_unavailable", "session held by another bridge instance — retry shortly");
          return;
        }
        if (err instanceof ShuttingDownError) {
          // This instance itself is the one going away (SIGTERM landed
          // while this request was in flight, or arrived just before —
          // server.close() stops NEW connections but not one already
          // accepted). Retrying against THIS instance is pointless; tell
          // the portal to retry, same as lease_unavailable, so it lands on
          // whichever instance replaces this one.
          sendError(res, 503, "shutting_down", "bridge instance is shutting down — retry shortly");
          return;
        }
        throw err;
      }
      const snapshot = manager.getSnapshot(coachId);
      sendJson(res, 202, { ok: true, session: snapshot });
      return;
    }

    // GET /sessions/:coachId — status + (live, in-memory) QR when waiting.
    if (req.method === "GET" && parts.length === 2) {
      const snapshot = manager.getSnapshot(coachId);
      if (!snapshot) {
        sendError(res, 404, "not_found", "no session running for this coach — POST /connect first");
        return;
      }
      sendJson(res, 200, { ok: true, session: snapshot });
      return;
    }

    // POST /sessions/:coachId/logout
    if (req.method === "POST" && parts[2] === "logout" && parts.length === 3) {
      // See the /connect branch above — tenantExists, renamed from coachExists.
      if (!(await store.tenantExists(coachId))) {
        sendError(res, 404, "not_found", "no such tenant");
        return;
      }
      await manager.logout(coachId);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /sessions/:coachId/send
    if (req.method === "POST" && parts[2] === "send" && parts.length === 3) {
      const body = await readJsonBody(req);
      if (!body) {
        sendError(res, 400, "invalid_body", "body must be a JSON object under 64KB");
        return;
      }
      const to = body.to;
      const text = body.text;
      const attachment = body.attachment;
      const idempotencyKey = body.idempotencyKey;
      if (typeof to !== "string" || !isE164(to)) {
        // Hard rule 3 — strict E.164 or refusal; the bridge never normalises
        // (src/phone.ts's file header has the full argument).
        sendError(res, 422, "invalid_phone", "'to' must be strict E.164 (+447700900123) — normalisation happens at capture in the portal, never here");
        return;
      }
      let outcome;
      if (!mediaOutboundEnabled) {
        // QA Blocker 2 fix — with the media master switch off, run the
        // PRE-MEDIA validation verbatim rather than the xor check below (as
        // a prior version of this route did for every shape, flag on or
        // off). The xor check changes two response shapes versus the
        // flags-off baseline this claims to preserve byte-for-byte:
        //   {to, idempotencyKey} with no text: was 422 invalid_text via the
        //     text-length check below; the xor check would answer 422
        //     invalid_body instead (hasText === hasAttachment, both false).
        //   {to, text, attachment}: was accepted and sent, the unknown
        //     `attachment` field silently ignored; the xor check would
        //     refuse it outright (hasText === hasAttachment, both true).
        // No current caller sends either shape, but "flags off = today's
        // exact behaviour" is a stated invariant (docs/MEDIA-PLAN.md §8),
        // not just a happy-path claim.
        if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
          sendError(res, 422, "invalid_idempotency_key", "'idempotencyKey' must match [A-Za-z0-9_-]{1,128}");
          return;
        }
        if (attachment !== undefined && text === undefined) {
          // The one shape that IS new — a caller deliberately using the
          // attachment-only contract while the switch is off. This never
          // existed pre-media (there is no "byte-identical" baseline to
          // preserve for it), and collapsing it into the generic
          // invalid_text below would hide the real reason. Keep the
          // specific diagnostic.
          sendError(res, 422, "media_outbound_disabled", "attachment sends are not enabled on this bridge");
          return;
        }
        if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
          sendError(res, 422, "invalid_text", `'text' must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
          return;
        }
        outcome = await manager.send(coachId, to, text, idempotencyKey);
      } else {
        // Media plan (docs/MEDIA-PLAN.md §5.3) — exactly one of `text` /
        // `attachment`; both or neither is a 422, same as today's "text is
        // the only shape" contract just widened by one more mutually-
        // exclusive option. Only reachable when `WA_MEDIA_OUTBOUND_ENABLED`
        // is on — see the flags-off branch above for why the flag being off
        // must never route through this xor check at all.
        const hasText = text !== undefined;
        const hasAttachment = attachment !== undefined;
        if (hasText === hasAttachment) {
          sendError(res, 422, "invalid_body", "exactly one of 'text' or 'attachment' is required");
          return;
        }
        if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
          sendError(res, 422, "invalid_idempotency_key", "'idempotencyKey' must match [A-Za-z0-9_-]{1,128}");
          return;
        }
        if (hasText) {
          if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
            sendError(res, 422, "invalid_text", `'text' must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
            return;
          }
          outcome = await manager.send(coachId, to, text, idempotencyKey);
        } else {
          if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
            sendError(res, 422, "invalid_attachment", "'attachment' must be an object of the shape { url, fileName? }");
            return;
          }
          const attachmentObj = attachment as Json;
          const url = attachmentObj.url;
          const fileName = attachmentObj.fileName;
          if (typeof url !== "string" || url.length === 0 || url.length > MAX_ATTACHMENT_URL_LENGTH || !url.startsWith("https://")) {
            sendError(res, 422, "invalid_attachment", `'attachment.url' must be a non-empty https:// URL of at most ${MAX_ATTACHMENT_URL_LENGTH} characters`);
            return;
          }
          if (fileName !== undefined && (typeof fileName !== "string" || fileName.length === 0 || fileName.length > MAX_ATTACHMENT_FILENAME_LENGTH)) {
            sendError(res, 422, "invalid_attachment", `'attachment.fileName', when present, must be a non-empty string of at most ${MAX_ATTACHMENT_FILENAME_LENGTH} characters`);
            return;
          }
          outcome = await manager.sendAttachment(coachId, to, { url, fileName }, idempotencyKey);
        }
      }
      switch (outcome.kind) {
        case "invalid_phone":
          sendError(res, 422, "invalid_phone", "'to' must be strict E.164");
          return;
        case "idempotency_conflict":
          // Same (coachId, idempotencyKey) but a DIFFERENT 'to' than the
          // stored row — refuse rather than silently replaying the OLD
          // recipient's result. Include the stored toPhone so the caller
          // can see exactly what mismatched.
          sendError(
            res,
            422,
            "idempotency_conflict",
            `idempotencyKey already used for a different recipient (${outcome.existing.toPhone}) — choose a new idempotencyKey to send to a different number`
          );
          return;
        case "session_not_connected":
          sendError(res, 409, "session_not_connected", `session status is '${outcome.status}' — connect and link a device first`);
          return;
        case "daily_cap_reached":
          sendError(res, 429, "daily_cap_reached", `daily cap of ${outcome.cap} sends reached for this session — resumes at UTC midnight`);
          return;
        case "lease_unavailable":
          sendError(res, 503, "lease_unavailable", "session held by another bridge instance — retry shortly");
          return;
        case "accepted": {
          const { record, fresh } = outcome;
          // Replay (same idempotency key) is a 200 with the existing row's
          // truth; a fresh accept is a 202 — "queued, paced dispatch follows".
          sendJson(res, fresh ? 202 : 200, {
            ok: true,
            replay: !fresh,
            message: {
              id: record.id,
              idempotencyKey: record.idempotencyKey,
              toPhone: record.toPhone,
              status: record.status,
              waMessageId: record.waMessageId,
              error: record.error,
              createdAt: record.createdAt,
              sentAt: record.sentAt,
            },
          });
          return;
        }
      }
    }

    // GET /sessions/:coachId/messages/:idempotencyKey — post-hoc status.
    if (req.method === "GET" && parts[2] === "messages" && parts[3] && parts.length === 4) {
      if (!IDEMPOTENCY_KEY_RE.test(parts[3])) {
        sendError(res, 400, "invalid_idempotency_key", "idempotency key must match [A-Za-z0-9_-]{1,128}");
        return;
      }
      const record = await store.getMessage(coachId, parts[3]);
      if (!record) {
        sendError(res, 404, "not_found", "no message with this idempotency key for this coach");
        return;
      }
      sendJson(res, 200, {
        ok: true,
        message: {
          id: record.id,
          idempotencyKey: record.idempotencyKey,
          toPhone: record.toPhone,
          status: record.status,
          waMessageId: record.waMessageId,
          error: record.error,
          createdAt: record.createdAt,
          sentAt: record.sentAt,
        },
      });
      return;
    }

    sendError(res, 404, "not_found", "unknown route");
  }
}
