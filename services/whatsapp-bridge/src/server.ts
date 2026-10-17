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
 *   Groups (404 groups_disabled unless WA_GROUPS_ENABLED; see the README):
 *   POST /sessions/:coachId/groups
 *   POST /sessions/:coachId/groups/:jid/participants    {add}
 *   POST /sessions/:coachId/groups/:jid/messages        {text, idempotencyKey}
 *   GET  /sessions/:coachId/groups/jobs/:jobId
 *   GET  /sessions/:coachId/groups/:jid
 *   POST /sessions/:coachId/groups/:jid/invite/revoke
 * Group routes never log phones, subjects, invite codes or secrets.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeStore } from "./store.js";
import { LeaseUnavailableError, ShuttingDownError, type SessionManager } from "./sessions.js";
import { isE164 } from "./phone.js";
import { GROUP_JID_RE } from "./groups.js";

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

/** WhatsApp's own group limits (subject 100, description 2048); create takes at most one batch, adds at most one portal batch. */
const MAX_GROUP_SUBJECT_LENGTH = 100;
const MAX_GROUP_DESCRIPTION_LENGTH = 2048;
const MAX_GROUP_CREATE_PARTICIPANTS = 5;
const MAX_GROUP_ADD_PARTICIPANTS = 50;

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
  /** `WA_GROUPS_ENABLED`. Defaults `false`: every /groups route answers 404 `groups_disabled`. */
  groupsEnabled?: boolean;
}

/** 1..max distinct strict-E.164 strings, or null. Duplicates are refused, never merged. */
function parsePhones(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  if (!value.every((p) => typeof p === "string" && isE164(p))) return null;
  return new Set(value).size === value.length ? (value as string[]) : null;
}

function decodeJid(raw: string): string | null {
  try {
    const jid = decodeURIComponent(raw);
    return GROUP_JID_RE.test(jid) ? jid : null;
  } catch {
    return null;
  }
}

export function createBridgeServer(deps: ServerDeps): Server {
  const { manager, store, bridgeSecret, log } = deps;
  const mediaOutboundEnabled = deps.mediaOutboundEnabled ?? false;
  const groupsEnabled = deps.groupsEnabled ?? false;
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

    // --- /sessions/:coachId/groups/… ---------------------------------------
    // The flag check runs before any body parsing, so a disabled bridge
    // answers the same way whatever the request looks like.
    if (parts[2] === "groups") {
      if (!groupsEnabled) {
        sendError(res, 404, "groups_disabled", "groups are not enabled on this bridge");
        return;
      }
      if (await handleGroups(req, res, coachId, parts)) return;
    }

    sendError(res, 404, "not_found", "unknown route");
  }

  /** Returns true when the request matched a group route and a response was sent. */
  async function handleGroups(req: IncomingMessage, res: ServerResponse, coachId: string, parts: string[]): Promise<boolean> {
    const notConnected = (status: string) => sendError(res, 409, "session_not_connected", `session status is '${status}' — connect and link a device first`);
    const leaseUnavailable = () => sendError(res, 503, "lease_unavailable", "session held by another bridge instance — retry shortly");
    const badJid = () => sendError(res, 422, "invalid_group_jid", "group id must look like 1234567890@g.us");
    const badBody = () => sendError(res, 400, "invalid_body", "body must be a JSON object under 64KB");

    // POST /groups
    if (req.method === "POST" && parts.length === 3) {
      const body = await readJsonBody(req);
      if (!body) return badBody(), true;
      const subject = typeof body.subject === "string" ? body.subject.trim() : "";
      if (subject.length < 1 || subject.length > MAX_GROUP_SUBJECT_LENGTH) {
        sendError(res, 422, "invalid_subject", `'subject' must be 1 to ${MAX_GROUP_SUBJECT_LENGTH} characters`);
        return true;
      }
      const description = body.description;
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_GROUP_DESCRIPTION_LENGTH)) {
        sendError(res, 422, "invalid_description", `'description' must be a string of at most ${MAX_GROUP_DESCRIPTION_LENGTH} characters`);
        return true;
      }
      const participants = parsePhones(body.participants, MAX_GROUP_CREATE_PARTICIPANTS);
      if (!participants) {
        sendError(res, 422, "invalid_participants", `'participants' must be 1 to ${MAX_GROUP_CREATE_PARTICIPANTS} distinct strict E.164 numbers`);
        return true;
      }
      const { announceOnly = false, adminAddOnly = false } = body;
      if (typeof announceOnly !== "boolean" || typeof adminAddOnly !== "boolean") {
        sendError(res, 422, "invalid_body", "'announceOnly' and 'adminAddOnly' must be booleans when present");
        return true;
      }
      const outcome = await manager.createGroup(coachId, { subject, description: description as string | undefined, participants, announceOnly, adminAddOnly });
      switch (outcome.kind) {
        case "created":
          sendJson(res, 201, { ok: true, group: outcome.group, results: outcome.results });
          return true;
        case "session_not_connected":
          return notConnected(outcome.status), true;
        case "group_create_cap_reached":
          sendError(res, 429, "group_create_cap_reached", `daily cap of ${outcome.cap} group creations reached for this session — resumes at UTC midnight`);
          return true;
        case "lease_unavailable":
          return leaseUnavailable(), true;
        case "whatsapp_refused":
          sendError(res, 502, "whatsapp_refused", "WhatsApp refused to create the group");
          return true;
      }
    }

    // GET /groups/jobs/:jobId
    if (req.method === "GET" && parts[3] === "jobs" && parts[4] && parts.length === 5) {
      if (!UUID_RE.test(parts[4])) {
        sendError(res, 400, "invalid_job_id", "job id must be a UUID");
        return true;
      }
      const job = await store.getGroupJob(coachId, parts[4]);
      if (!job) {
        sendError(res, 404, "not_found", "no such group job for this coach");
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        job: { id: job.id, status: job.status, requestedCount: job.requestedCount, results: job.results, createdAt: job.createdAt, finishedAt: job.finishedAt },
      });
      return true;
    }

    if (!parts[3]) return false;
    const rest = parts.slice(4);

    // GET /groups/:jid
    if (req.method === "GET" && rest.length === 0) {
      const jid = decodeJid(parts[3]);
      if (!jid) return badJid(), true;
      const outcome = await manager.getGroup(coachId, jid);
      if (outcome.kind === "session_not_connected") return notConnected(outcome.status), true;
      if (outcome.kind === "group_not_found") {
        sendError(res, 404, "group_not_found", "group not found or its details could not be read");
        return true;
      }
      const { jid: gJid, subject, participantCount, weAreAdmin, inviteCode } = outcome.group;
      sendJson(res, 200, { ok: true, group: { jid: gJid, subject, participantCount, weAreAdmin, inviteCode } });
      return true;
    }

    // POST /groups/:jid/invite/revoke
    if (req.method === "POST" && rest.length === 2 && rest[0] === "invite" && rest[1] === "revoke") {
      const jid = decodeJid(parts[3]);
      if (!jid) return badJid(), true;
      const outcome = await manager.revokeGroupInvite(coachId, jid);
      if (outcome.kind === "session_not_connected") return notConnected(outcome.status), true;
      if (outcome.kind === "group_not_found") {
        sendError(res, 404, "group_not_found", "group not found or its details could not be read");
        return true;
      }
      sendJson(res, 200, { ok: true, inviteCode: outcome.inviteCode });
      return true;
    }

    // POST /groups/:jid/participants
    if (req.method === "POST" && rest.length === 1 && rest[0] === "participants") {
      const jid = decodeJid(parts[3]);
      if (!jid) return badJid(), true;
      const body = await readJsonBody(req);
      if (!body) return badBody(), true;
      const add = parsePhones(body.add, MAX_GROUP_ADD_PARTICIPANTS);
      if (!add) {
        sendError(res, 422, "invalid_participants", `'add' must be 1 to ${MAX_GROUP_ADD_PARTICIPANTS} distinct strict E.164 numbers`);
        return true;
      }
      const outcome = await manager.startAddJob(coachId, jid, add);
      switch (outcome.kind) {
        case "queued":
          sendJson(res, 202, { ok: true, job: { id: outcome.job.id, status: "queued", requestedCount: outcome.job.requestedCount } });
          return true;
        case "session_not_connected":
          return notConnected(outcome.status), true;
        case "group_add_cap_reached":
          sendError(res, 429, "group_add_cap_reached", "daily limit of group additions reached for this session — resumes at UTC midnight");
          return true;
        case "lease_unavailable":
          return leaseUnavailable(), true;
      }
    }

    // POST /groups/:jid/messages
    if (req.method === "POST" && rest.length === 1 && rest[0] === "messages") {
      const jid = decodeJid(parts[3]);
      if (!jid) return badJid(), true;
      const body = await readJsonBody(req);
      if (!body) return badBody(), true;
      const { text, idempotencyKey } = body;
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        sendError(res, 422, "invalid_idempotency_key", "'idempotencyKey' must match [A-Za-z0-9_-]{1,128}");
        return true;
      }
      if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
        sendError(res, 422, "invalid_text", `'text' must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
        return true;
      }
      const outcome = await manager.postToGroup(coachId, jid, text, idempotencyKey);
      switch (outcome.kind) {
        case "accepted": {
          const { post, fresh } = outcome;
          sendJson(res, fresh ? 202 : 200, {
            ok: true,
            replay: !fresh,
            post: { id: post.id, idempotencyKey: post.idempotencyKey, status: post.status, waMessageId: post.waMessageId, error: post.error, createdAt: post.createdAt, sentAt: post.sentAt },
          });
          return true;
        }
        case "idempotency_conflict":
          sendError(res, 422, "idempotency_conflict", "idempotencyKey already used for a different group — choose a new idempotencyKey");
          return true;
        case "session_not_connected":
          return notConnected(outcome.status), true;
        case "daily_cap_reached":
          sendError(res, 429, "daily_cap_reached", `daily cap of ${outcome.cap} sends reached for this session — resumes at UTC midnight`);
          return true;
        case "lease_unavailable":
          return leaseUnavailable(), true;
      }
    }

    return false;
  }
}
