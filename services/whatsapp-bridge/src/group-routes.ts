/**
 * HTTP routes for group management (docs/superpowers/plans/
 * 2026-10-17-group-management.md, Task 4). `server.ts` has already checked
 * the bearer secret and the coach UUID; this file validates the group JID
 * and every body, then calls the session manager. The manager trusts its
 * inputs, so ALL validation lives here.
 *
 * ROUTES (`:jid` is URL-decoded, then `isGroupJid`-checked before the
 * manager is called):
 *   POST   /sessions/:id/groups                    {requestId, name, description?, participants}
 *   GET    /sessions/:id/groups/:jid
 *   PATCH  /sessions/:id/groups/:jid               {name?, description?, announcement?, approval?}
 *   POST   /sessions/:id/groups/:jid/participants  {action, phones | memberIds}
 *   GET    /sessions/:id/groups/:jid/invite
 *   POST   /sessions/:id/groups/:jid/invite/reset
 *   POST   /sessions/:id/groups/:jid/leave
 *
 * Refusals pass the manager's fixed message through unchanged. Nothing here
 * logs a name, JID, phone number or member id.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "./sessions.js";
import type { GroupOpOutcome, GroupPatch, ParticipantsRequest } from "./group-management.js";
import { GROUP_LIMITS_UNAVAILABLE_REASON } from "./group-management.js";
import { MEMBER_ID_RE, isGroupJid } from "./groups.js";
import { isE164 } from "./phone.js";
import { readJsonBody, sendError, sendJson, type Json } from "./http-helpers.js";

export type GroupRouteManager = Pick<
  SessionManager,
  "createGroup" | "getGroupDetail" | "updateGroup" | "updateGroupParticipants" | "getGroupInviteLink" | "resetGroupInviteLink" | "leaveGroup"
>;

const MAX_NAME = 100;
const MAX_DESCRIPTION = 512;
const MAX_PARTICIPANTS = 50;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const codePoints = (s: string): number => [...s].length;

function invalidBody(res: ServerResponse, message: string): void {
  sendError(res, 400, "invalid_body", message);
}

/** Sends the response for every non-ok outcome; returns the value for an ok one. */
function unwrap<T>(res: ServerResponse, outcome: GroupOpOutcome<T>): { value: T } | null {
  switch (outcome.kind) {
    case "ok":
      return { value: outcome.value };
    case "session_not_connected":
      sendError(res, 409, "session_not_connected", "session is not connected — connect and link a device first");
      return null;
    case "group_not_enabled":
      sendError(res, 400, "group_not_enabled", "that is not an enabled WhatsApp group for this session");
      return null;
    case "too_many":
      sendError(res, 400, "too_many", `at most ${MAX_PARTICIPANTS} people per request`);
      return null;
    case "refused":
      if (outcome.code === "not_admin") sendError(res, 403, "not_admin", outcome.message);
      else if (outcome.code === "limits_unavailable") sendError(res, 503, "limits_unavailable", outcome.message || GROUP_LIMITS_UNAVAILABLE_REASON);
      else sendError(res, 422, outcome.code, outcome.message);
      return null;
    case "failed":
      sendError(res, 502, "group_action_failed", "WhatsApp could not complete that group action — retry shortly");
      return null;
  }
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

function parseCreate(body: Json): { requestId: string; name: string; description?: string; participants: string[] } | string {
  const { requestId, name, description, participants } = body;
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) return "'requestId' must match [A-Za-z0-9_-]{1,128}";
  if (typeof name !== "string") return "'name' must be a string";
  const trimmed = name.trim();
  if (trimmed.length === 0 || codePoints(trimmed) > MAX_NAME) return `'name' must be 1 to ${MAX_NAME} characters`;
  if (description !== undefined && (typeof description !== "string" || codePoints(description) > MAX_DESCRIPTION)) {
    return `'description' must be a string of at most ${MAX_DESCRIPTION} characters`;
  }
  const list = participants === undefined ? [] : stringArray(participants);
  if (!list) return "'participants' must be an array of E.164 phone numbers";
  if (list.length > MAX_PARTICIPANTS) return `at most ${MAX_PARTICIPANTS} participants`;
  if (!list.every(isE164)) return "every participant must be strict E.164 (+447700900123)";
  return { requestId, name: trimmed, ...(description !== undefined ? { description } : {}), participants: list };
}

function parsePatch(body: Json): GroupPatch | string {
  const patch: GroupPatch = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return "'name' must be a string";
    const trimmed = body.name.trim();
    if (trimmed.length === 0 || codePoints(trimmed) > MAX_NAME) return `'name' must be 1 to ${MAX_NAME} characters`;
    patch.name = trimmed;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || codePoints(body.description) > MAX_DESCRIPTION) {
      return `'description' must be a string of at most ${MAX_DESCRIPTION} characters`;
    }
    patch.description = body.description;
  }
  for (const key of ["announcement", "approval"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") return `'${key}' must be a boolean`;
      patch[key] = body[key] as boolean;
    }
  }
  if (Object.keys(patch).length === 0) return "give at least one of name, description, announcement, approval";
  return patch;
}

function parseParticipants(body: Json): ParticipantsRequest | string {
  const { action, phones, memberIds } = body;
  if (phones !== undefined && memberIds !== undefined) return "give either 'phones' or 'memberIds', not both";
  if (action === "add") {
    if (memberIds !== undefined) return "'add' takes 'phones', not 'memberIds'";
    const list = stringArray(phones);
    if (!list || list.length === 0) return "'phones' must be a non-empty array of E.164 phone numbers";
    if (list.length > MAX_PARTICIPANTS) return `at most ${MAX_PARTICIPANTS} people per request`;
    if (!list.every(isE164)) return "every phone must be strict E.164 (+447700900123)";
    return { action, phones: list };
  }
  if (action === "remove" || action === "promote" || action === "demote") {
    if (phones !== undefined) return `'${action}' takes 'memberIds', not 'phones'`;
    const list = stringArray(memberIds);
    if (!list || list.length === 0) return "'memberIds' must be a non-empty array of member ids";
    if (list.length > MAX_PARTICIPANTS) return `at most ${MAX_PARTICIPANTS} people per request`;
    if (!list.every((m) => MEMBER_ID_RE.test(m))) return "every member id must be a WhatsApp member id from the group details";
    return { action, memberIds: list };
  }
  return "'action' must be one of add, remove, promote, demote";
}

/** Returns true when the request was a group-management route (and has been answered). */
export async function handleGroupManagementRoute(req: IncomingMessage, res: ServerResponse, parts: string[], manager: GroupRouteManager): Promise<boolean> {
  if (parts[0] !== "sessions" || parts[2] !== "groups") return false;
  const coachId = parts[1];
  const method = req.method;

  // POST /sessions/:id/groups
  if (parts.length === 3) {
    if (method !== "POST") return false;
    const body = await readJsonBody(req);
    if (!body) return invalidBody(res, "body must be a JSON object under 64KB"), true;
    const input = parseCreate(body);
    if (typeof input === "string") return invalidBody(res, input), true;
    const ok = unwrap(res, await manager.createGroup(coachId, input));
    if (ok) sendJson(res, 200, { ok: true, jid: ok.value.jid, name: ok.value.name, addedPhone: ok.value.addedPhone, path: ok.value.path, ...(ok.value.replayed ? { replayed: true } : {}) });
    return true;
  }

  // Everything below is /sessions/:id/groups/:jid[/…]. "refresh" is its own route in server.ts.
  if (parts[3] === "refresh") return false;
  const sub = parts.slice(4).join("/");
  const known =
    (sub === "" && (method === "GET" || method === "PATCH")) ||
    (sub === "participants" && method === "POST") ||
    (sub === "invite" && method === "GET") ||
    (sub === "invite/reset" && method === "POST") ||
    (sub === "leave" && method === "POST");
  if (!known) return false;

  let jid: string;
  try {
    jid = decodeURIComponent(parts[3]);
  } catch {
    sendError(res, 400, "invalid_group_jid", "group id is not a valid WhatsApp group id");
    return true;
  }
  if (!isGroupJid(jid)) {
    sendError(res, 400, "invalid_group_jid", "group id is not a valid WhatsApp group id");
    return true;
  }

  if (sub === "" && method === "GET") {
    const ok = unwrap(res, await manager.getGroupDetail(coachId, jid));
    if (ok) sendJson(res, 200, { ok: true, group: ok.value });
    return true;
  }
  if (sub === "" && method === "PATCH") {
    const body = await readJsonBody(req);
    if (!body) return invalidBody(res, "body must be a JSON object under 64KB"), true;
    const patch = parsePatch(body);
    if (typeof patch === "string") return invalidBody(res, patch), true;
    if (unwrap(res, await manager.updateGroup(coachId, jid, patch))) sendJson(res, 200, { ok: true });
    return true;
  }
  if (sub === "participants") {
    const body = await readJsonBody(req);
    if (!body) return invalidBody(res, "body must be a JSON object under 64KB"), true;
    const request = parseParticipants(body);
    if (typeof request === "string") return invalidBody(res, request), true;
    const ok = unwrap(res, await manager.updateGroupParticipants(coachId, jid, request));
    if (ok) sendJson(res, 200, { ok: true, results: ok.value });
    return true;
  }
  if (sub === "invite" || sub === "invite/reset") {
    const ok = unwrap(res, sub === "invite" ? await manager.getGroupInviteLink(coachId, jid) : await manager.resetGroupInviteLink(coachId, jid));
    if (ok) sendJson(res, 200, { ok: true, link: ok.value.link });
    return true;
  }
  // leave
  if (unwrap(res, await manager.leaveGroup(coachId, jid))) sendJson(res, 200, { ok: true });
  return true;
}
