/**
 * The GHL Custom Page embed's group management for one number: create a
 * WhatsApp group, invite GHL contacts to it, search contacts for the picker,
 * and manage a group (details, settings, members, invite link, leave). Split
 * out of `route.ts` so `scripts/test/embed-group-manage.test.ts` can drive it
 * with a fake repo and fake bridge/GHL calls, the same split as
 * `../logic.ts`. DELIBERATELY ZERO NEXT IMPORTS.
 *
 * ONE NUMBER, FROM THE SLOT GUARD. `ctx.tenantId` is `authorizeGhlEmbedRequest`'s
 * answer for the request's `{ slot }`, never anything the client sent. Every
 * bridge call, repo call and app-originated send uses exactly that tenant
 * (`sendAppOriginatedText` refuses any other).
 *
 * WHAT IS RETURNED: every body is built by listing its fields, never by
 * spreading a bridge or repo object (a `WhatsappGroup` carries the tenant
 * id). No tenant id ever. No phone numbers, except group members' own
 * numbers in `detail` (the coach's WhatsApp already shows them; the manage
 * panel labels members by them). Contact ids and group JIDs are returned.
 *
 * FAILURES ARE FIXED SENTENCES. A bridge message is passed through only for
 * the refusal codes whose messages are the spec's fixed strings
 * (create_limit, add_limit, warmup, needs_member at 422, not_admin at 403,
 * limits_unavailable at 503). Everything else maps to a string written here.
 *
 * INVITES APPEAR IN GHL (Charlie, 17 Oct): after `sendGroupInvites`, each
 * `delivered` entry the bridge accepted is posted once into the contact's GHL
 * conversation as an outbound message. Held and pending-retry invites have
 * not gone out, so they are not posted. A failed post never changes the
 * invite result; it is logged with a fixed string and the HTTP status only.
 *
 * NEVER LOGGED: phones, names, JIDs, contact ids, links, message text,
 * tenant ids.
 */
import type { GhlRepository } from "@/lib/data";
import { requestedSlotFromBody } from "@/app/api/crm/embed/guard";
import type { SlotParseResult } from "@/lib/location-numbers";
import type { GhlAccount } from "@/lib/types";
import type { addGhlOutboundMessage, searchGhlContacts } from "@/lib/ghl";
import { GHL_GROUP_CONTACT_TAG } from "@/lib/ghl";
import { normalisePhoneE164 } from "@/lib/phone";
import {
  MAX_INVITEES_PER_REQUEST,
  type Invitee,
  type SendGroupInvitesResult,
  type SkippedInvitee,
  type resolveInvitees,
  type sendGroupInvites,
} from "@/lib/group-invites";
import {
  isWhatsappGroupJid,
  type BridgeCreateGroupResult,
  type BridgeGroupDetailResult,
  type BridgeInviteResult,
  type BridgeOkResult,
  type BridgeParticipantOutcome,
  type BridgeParticipantsResult,
  type CreateWhatsappGroupInput,
  type WhatsappGroupPatch,
  type WhatsappParticipantsRequest,
} from "@/lib/whatsapp-bridge";

/** The narrow repo slice this module touches. */
export type GroupManageRepo = Pick<
  GhlRepository,
  "listWhatsappGroups" | "recordCreatedWhatsappGroup" | "renameWhatsappGroup" | "markWhatsappGroupLeft" | "hasInboundFromPhone"
>;

/** Bridge and GHL calls, injected. Production wiring is in `route.ts`. */
export interface GroupManageDeps {
  createGroup: (tenantId: string, input: CreateWhatsappGroupInput) => Promise<BridgeCreateGroupResult>;
  getDetail: (tenantId: string, jid: string) => Promise<BridgeGroupDetailResult>;
  updateGroup: (tenantId: string, jid: string, patch: WhatsappGroupPatch) => Promise<BridgeOkResult>;
  updateParticipants: (tenantId: string, jid: string, req: WhatsappParticipantsRequest) => Promise<BridgeParticipantsResult>;
  getInvite: (tenantId: string, jid: string) => Promise<BridgeInviteResult>;
  resetInvite: (tenantId: string, jid: string) => Promise<BridgeInviteResult>;
  leaveGroup: (tenantId: string, jid: string) => Promise<BridgeOkResult>;
  refreshGroups: (tenantId: string) => Promise<BridgeOkResult>;
  /** The location's GHL access token (refreshed if needed), or null when GHL isn't usable. */
  resolveAccessToken: (account: GhlAccount) => Promise<string | null>;
  resolveInvitees: (input: Parameters<typeof resolveInvitees>[1]) => ReturnType<typeof resolveInvitees>;
  sendInvites: (input: Parameters<typeof sendGroupInvites>[1]) => Promise<SendGroupInvitesResult>;
  searchContacts: typeof searchGhlContacts;
  /** Location-wide STOP check for a phone: a reason, or null. */
  optedOutReason: (locationId: string, tenantId: string, phone: string) => Promise<string | null>;
  postOutboundMessage: typeof addGhlOutboundMessage;
  /** `GHL_CONVERSATION_PROVIDER_ID`, used when the account has no override. */
  envConversationProviderId: string | null;
}

export interface GroupManageContext {
  /** From the slot guard. Never returned. */
  tenantId: string;
  /** Loaded by the route for the guard's tenant. Never returned. */
  account: GhlAccount;
  /** The slot's number label, or null. */
  slotLabel: string | null;
}

export type GroupManageResult = { status: number; body: Record<string, unknown> };

const LOG = "[api/crm/embed/groups/manage]";
const MAX_NAME = 100;
const MAX_DESCRIPTION = 512;
const MAX_TAG = 100;
const MAX_SEARCH_TEXT = 100;
/** The bridge's own per-request limit for member changes. */
const MAX_MEMBER_IDS = 50;
/** The bridge accepts at most this many fallback first-member candidates on a create. */
const MAX_CREATE_FALLBACK_CANDIDATES = 50;
const SEARCH_LIMIT = 25;
const SEARCH_CHECK_CONCURRENCY = 5;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CONTACT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Same as the bridge's MEMBER_ID_RE (services/whatsapp-bridge/src/groups.ts). */
const MEMBER_ID_RE = /^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/;

// Fixed strings, shown in GHL verbatim.
export const MSG_MALFORMED = "Malformed request.";
export const MSG_UNKNOWN_GROUP = "That WhatsApp group wasn't found on this number.";
export const MSG_OFFLINE = "This WhatsApp number is offline. Reconnect it and try again.";
export const MSG_NO_RESPONSE = "WhatsApp didn't respond. Try again.";
export const MSG_TOO_MANY = "That's too many people for one request. Choose 50 or fewer.";
export const MSG_GHL_NOT_CONNECTED = "GoHighLevel isn't connected for this sub-account. Reload the page and try again.";
export const MSG_NAME = `The group name must be 1 to ${MAX_NAME} characters.`;
export const MSG_DESCRIPTION = `The description must be ${MAX_DESCRIPTION} characters or fewer.`;
export const MSG_SELF = "You can't remove this WhatsApp number from the group. Use Leave instead.";
export const MSG_LAST_ADMIN = "You can't remove the group's last admin.";
export const MSG_NOT_MEMBER = "That person isn't in this group any more.";
export const MSG_MEMBER_FAILED = "WhatsApp didn't make that change. Try again.";

const codePoints = (s: string): number => [...s].length;

function fail(status: number, code: string, message: string): GroupManageResult {
  return { status, body: { ok: false, code, message } };
}
const malformed = (message: string = MSG_MALFORMED) => fail(400, "invalid_body", message);
const unknownGroup = () => fail(404, "unknown_group", MSG_UNKNOWN_GROUP);

/** Bridge refusal codes whose message is the spec's fixed string, with the status they answer. */
const PASS_THROUGH_STATUS: Readonly<Record<string, number>> = {
  create_limit: 422,
  add_limit: 422,
  warmup: 422,
  needs_member: 422,
  not_admin: 403,
  limits_unavailable: 503,
};

/**
 * Create failures whose outcome is unknown: the bridge was unreachable or
 * timed out (`unreachable`; `timeout` too, should a caller ever name it), WhatsApp's create errored ambiguously
 * (`group_action_failed`), or the bridge answered something malformed or
 * crashed mid-call (`internal`). Anything else (`unconfigured`, a refusal, an
 * auth or body error) made no group.
 */
const CREATE_MAY_EXIST_CODES: ReadonlySet<string> = new Set(["unreachable", "timeout", "group_action_failed", "internal"]);

/** Maps a bridge failure to the response. `forCreate` marks an unknown-outcome create failure `mayExist: true`. */
function bridgeFailure(failure: { code: string; message: string }, forCreate = false): GroupManageResult {
  const passStatus = PASS_THROUGH_STATUS[failure.code];
  if (passStatus !== undefined) return fail(passStatus, failure.code, failure.message);
  if (failure.code === "session_not_connected" || failure.code === "not_found") return fail(409, "session_not_connected", MSG_OFFLINE);
  if (failure.code === "too_many") return fail(400, "too_many", MSG_TOO_MANY);
  if (failure.code === "group_not_enabled") return unknownGroup();
  console.warn(`${LOG} bridge call failed with code ${failure.code}`);
  const body: Record<string, unknown> = { ok: false, code: "bridge_unavailable", message: MSG_NO_RESPONSE };
  if (forCreate && CREATE_MAY_EXIST_CODES.has(failure.code)) body.mayExist = true;
  return { status: 502, body };
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : "unknown");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Audience = { contactIds?: string[]; tag?: string } | null;

/** `contactIds` and/or `tag`; null when neither is given; a string when malformed. */
function parseAudience(body: Record<string, unknown>): Audience | string {
  const out: { contactIds?: string[]; tag?: string } = {};
  if (body.contactIds !== undefined) {
    const ids = body.contactIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && CONTACT_ID_RE.test(id))) return MSG_MALFORMED;
    if (ids.length > MAX_INVITEES_PER_REQUEST) return `Choose ${MAX_INVITEES_PER_REQUEST} people or fewer.`;
    if (ids.length > 0) out.contactIds = ids as string[];
  }
  if (body.tag !== undefined) {
    if (typeof body.tag !== "string" || codePoints(body.tag.trim()) > MAX_TAG) return MSG_MALFORMED;
    if (body.tag.trim() !== "") out.tag = body.tag.trim();
  }
  return out.contactIds || out.tag ? out : null;
}

function parseDirectAdd(body: Record<string, unknown>): boolean | null {
  if (body.directAdd === undefined) return false;
  return typeof body.directAdd === "boolean" ? body.directAdd : null;
}

/** A trimmed 1-100 code point name, or an error message. */
function parseName(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: MSG_NAME };
  const name = raw.trim();
  if (name.length === 0 || codePoints(name) > MAX_NAME) return { error: MSG_NAME };
  return name;
}

function parseDescription(raw: unknown): string | { error: string } {
  if (typeof raw !== "string" || codePoints(raw) > MAX_DESCRIPTION) return { error: MSG_DESCRIPTION };
  return raw;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

function coachName(ctx: GroupManageContext): string {
  return ctx.slotLabel?.trim() || ctx.account.label?.trim() || "your coach";
}

/** Posts each accepted invite into the contact's GHL conversation, once. Never throws, never changes the invite result. */
async function postAcceptedInvitesToGhl(
  deps: GroupManageDeps,
  account: GhlAccount,
  accessToken: string,
  delivered: SendGroupInvitesResult["delivered"]
): Promise<void> {
  const accepted = delivered.filter((d) => d.outcome === "accepted");
  if (accepted.length === 0) return;
  const conversationProviderId = account.conversationProviderId ?? deps.envConversationProviderId;
  if (!conversationProviderId) {
    console.warn(`${LOG} invites sent but not shown in GoHighLevel: no conversation provider id`);
    return;
  }
  for (const d of accepted) {
    try {
      const posted = await deps.postOutboundMessage(accessToken, { contactId: d.contactId, message: d.text, conversationProviderId });
      if (!posted.ok) console.warn(`${LOG} an invite was sent but couldn't be shown in GoHighLevel (HTTP ${posted.status ?? "none"})`);
    } catch (err) {
      console.warn(`${LOG} an invite was sent but couldn't be shown in GoHighLevel (${errName(err)})`);
    }
  }
}

/** The `invites` field of a create/invite response. Contact ids only, never phones. */
function invitesView(
  sent: SendGroupInvitesResult,
  skipped: SkippedInvitee[],
  extraAdded: string[],
  truncated: boolean,
  invitees: readonly Invitee[]
): Record<string, unknown> {
  const firstNames = new Map(invitees.map((i) => [i.contactId, i.firstName?.trim() || null]));
  return {
    added: [...extraAdded, ...sent.added],
    alreadyMember: [...sent.alreadyMember],
    sent: sent.delivered.filter((d) => d.outcome !== "held").map((d) => d.contactId),
    held: sent.delivered.filter((d) => d.outcome === "held").map((d) => d.contactId),
    refused: sent.refused.map((r) => ({ contactId: r.contactId, name: firstNames.get(r.contactId) ?? null, reason: r.reason })),
    skipped: skipped.map((s) => ({ contactId: s.contactId, name: s.name, reason: s.reason })),
    truncated,
  };
}

const EMPTY_SEND: SendGroupInvitesResult = { added: [], alreadyMember: [], sent: 0, held: 0, refused: [], delivered: [] };

type ResolvedAudience = { invitees: Invitee[]; skipped: SkippedInvitee[]; truncated: boolean; accessToken: string | null };

/** Resolves the audience to invitees (needs GHL). `null` audience → nobody, no GHL call. */
async function resolveAudience(deps: GroupManageDeps, ctx: GroupManageContext, audience: Audience): Promise<ResolvedAudience | GroupManageResult> {
  if (audience === null) return { invitees: [], skipped: [], truncated: false, accessToken: null };
  const accessToken = await deps.resolveAccessToken(ctx.account);
  if (!accessToken) return fail(409, "ghl_not_connected", MSG_GHL_NOT_CONNECTED);
  const resolved = await deps.resolveInvitees({ accessToken, locationId: ctx.account.locationId, tenantId: ctx.tenantId, ...audience });
  if (!resolved.ok) return fail(502, "invitee_lookup_failed", resolved.message);
  return { invitees: resolved.invitees, skipped: resolved.skipped, truncated: resolved.truncated, accessToken };
}

async function inviteAndPost(
  deps: GroupManageDeps,
  ctx: GroupManageContext,
  group: { jid: string; name: string },
  audience: ResolvedAudience,
  invitees: Invitee[],
  directAdd: boolean
): Promise<SendGroupInvitesResult> {
  if (invitees.length === 0 || !audience.accessToken) return EMPTY_SEND;
  const sent = await deps.sendInvites({ account: ctx.account, tenantId: ctx.tenantId, group, invitees, directAdd, coachName: coachName(ctx) });
  await postAcceptedInvitesToGhl(deps, ctx.account, audience.accessToken, sent.delivered);
  return sent;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleCreate(repo: GroupManageRepo, deps: GroupManageDeps, ctx: GroupManageContext, body: Record<string, unknown>): Promise<GroupManageResult> {
  if (typeof body.requestId !== "string" || !REQUEST_ID_RE.test(body.requestId)) return malformed();
  const name = parseName(body.name);
  if (typeof name !== "string") return malformed(name.error);
  let description: string | undefined;
  if (body.description !== undefined) {
    const parsed = parseDescription(body.description);
    if (typeof parsed !== "string") return malformed(parsed.error);
    if (parsed.trim() !== "") description = parsed;
  }
  const audienceInput = parseAudience(body);
  if (typeof audienceInput === "string") return malformed(audienceInput);
  const directAdd = parseDirectAdd(body);
  if (directAdd === null) return malformed();

  const audience = await resolveAudience(deps, ctx, audienceInput);
  if ("status" in audience) return audience;

  const created = await deps.createGroup(ctx.tenantId, {
    requestId: body.requestId,
    name,
    ...(description !== undefined ? { description } : {}),
    // Fallback candidates for the first member, used only if WhatsApp refuses an empty group.
    participants: audience.invitees.slice(0, MAX_CREATE_FALLBACK_CANDIDATES).map((i) => i.phone),
  });
  if (!created.ok) return bridgeFailure(created, true);
  const group = { jid: created.jid, name: created.name };

  // A replay: the bridge answers a repeated requestId with the first outcome,
  // and that first request owns the record and the invites. Never invite
  // twice; the coach uses Invite more to add anyone missed. The bridge's own
  // `replayed` flag decides first, so this never depends on the DB; the
  // createdByUs row is a second check. If the row can't be read, fail safe:
  // treat it as a replay rather than risk inviting everyone twice.
  let replayed = created.replayed === true;
  if (!replayed) {
    try {
      replayed = (await repo.listWhatsappGroups(ctx.tenantId)).some((g) => g.groupJid === group.jid && g.createdByUs);
    } catch (err) {
      console.error(`${LOG} couldn't check for a replayed create (treated as a replay):`, errName(err));
      replayed = true;
    }
  }
  if (replayed) {
    return {
      status: 200,
      body: { ok: true, group: { jid: group.jid, name: group.name }, invites: invitesView(EMPTY_SEND, [], [], false, []), replayed: true },
    };
  }

  // The group exists on WhatsApp now: a failed record or reload is logged, never a failed create.
  let recorded = false;
  try {
    await repo.recordCreatedWhatsappGroup(ctx.tenantId, group.jid, group.name);
    recorded = true;
  } catch (err) {
    console.error(`${LOG} group created on WhatsApp but not recorded:`, errName(err));
  }
  if (recorded) {
    const refreshed = await deps.refreshGroups(ctx.tenantId);
    if (!refreshed.ok) console.warn(`${LOG} group created but the bridge reload failed with code ${refreshed.code}`);
  }

  const firstMember = created.addedPhone ? audience.invitees.find((i) => i.phone === created.addedPhone) : undefined;
  const rest = firstMember ? audience.invitees.filter((i) => i !== firstMember) : audience.invitees;
  const sent = await inviteAndPost(deps, ctx, group, audience, rest, directAdd);
  return {
    status: 200,
    body: {
      ok: true,
      group: { jid: group.jid, name: group.name },
      invites: invitesView(sent, audience.skipped, firstMember ? [firstMember.contactId] : [], audience.truncated, audience.invitees),
    },
  };
}

async function handleSearchContacts(repo: GroupManageRepo, deps: GroupManageDeps, ctx: GroupManageContext, body: Record<string, unknown>): Promise<GroupManageResult> {
  const text = body.text === undefined ? "" : body.text;
  const tag = body.tag === undefined ? "" : body.tag;
  if (typeof text !== "string" || typeof tag !== "string" || codePoints(text.trim()) > MAX_SEARCH_TEXT || codePoints(tag.trim()) > MAX_TAG) return malformed();
  const accessToken = await deps.resolveAccessToken(ctx.account);
  if (!accessToken) return fail(409, "ghl_not_connected", MSG_GHL_NOT_CONNECTED);
  const query: { text?: string; tag?: string } = {};
  if (text.trim()) query.text = text.trim();
  if (tag.trim()) query.tag = tag.trim();
  const found = await deps.searchContacts(accessToken, ctx.account.locationId, query, SEARCH_LIMIT);
  if (!found.ok) return fail(502, "contact_search_failed", "Couldn't search your GoHighLevel contacts. Try again.");

  const people = found.contacts.filter((c) => !c.tags.some((t) => t.toLowerCase() === GHL_GROUP_CONTACT_TAG));
  const contacts: Record<string, unknown>[] = [];
  for (let at = 0; at < people.length; at += SEARCH_CHECK_CONCURRENCY) {
    const batch = await Promise.all(
      people.slice(at, at + SEARCH_CHECK_CONCURRENCY).map(async (c) => {
        const phone = c.phone ? normalisePhoneE164(c.phone, "GB") : null;
        let canAddDirectly = false;
        if (phone) {
          try {
            canAddDirectly =
              (await repo.hasInboundFromPhone(ctx.tenantId, phone)) && (await deps.optedOutReason(ctx.account.locationId, ctx.tenantId, phone)) === null;
          } catch (err) {
            console.error(`${LOG} direct-add check failed (shown as invite by link):`, errName(err));
          }
        }
        return { id: c.id, name: c.name, hasPhone: phone !== null, canAddDirectly };
      })
    );
    contacts.push(...batch);
  }
  return { status: 200, body: { ok: true, contacts, truncated: found.truncated } };
}

type GroupAction = "detail" | "update" | "participants" | "invite_link" | "invite_reset" | "leave" | "invite";

/** The stored, enabled group for `groupJid` on this tenant, or the failure to answer. */
async function findManagedGroup(repo: GroupManageRepo, tenantId: string, rawJid: unknown): Promise<{ jid: string; name: string } | GroupManageResult> {
  if (typeof rawJid !== "string" || !isWhatsappGroupJid(rawJid)) return malformed();
  const row = (await repo.listWhatsappGroups(tenantId)).find((g) => g.groupJid === rawJid);
  // Only a synced group this number is still in: not stored, switched off, or left is unknown.
  if (!row || !row.enabled || row.leftAt !== null) return unknownGroup();
  return { jid: row.groupJid, name: row.name };
}

function participantMessage(result: BridgeParticipantOutcome): string | null {
  switch (result) {
    case "ok":
      return null;
    case "self":
      return MSG_SELF;
    case "last_admin":
      return MSG_LAST_ADMIN;
    case "not_member":
      return MSG_NOT_MEMBER;
    default:
      return MSG_MEMBER_FAILED;
  }
}

async function handleGroupAction(
  repo: GroupManageRepo,
  deps: GroupManageDeps,
  ctx: GroupManageContext,
  action: GroupAction,
  body: Record<string, unknown>
): Promise<GroupManageResult> {
  const group = await findManagedGroup(repo, ctx.tenantId, body.groupJid);
  if ("status" in group) return group;
  const { tenantId } = ctx;

  switch (action) {
    case "detail": {
      const res = await deps.getDetail(tenantId, group.jid);
      if (!res.ok) return bridgeFailure(res);
      const g = res.group;
      return {
        status: 200,
        body: {
          ok: true,
          group: {
            jid: group.jid,
            name: g.name,
            description: g.description,
            announcement: g.announcement,
            approval: g.approval,
            weAreAdmin: g.weAreAdmin,
            members: g.members.map((m) => ({ memberId: m.memberId, phone: m.phone, admin: m.admin, isUs: m.isUs })),
          },
        },
      };
    }

    case "update": {
      const patch: WhatsappGroupPatch = {};
      if (body.name !== undefined) {
        const name = parseName(body.name);
        if (typeof name !== "string") return malformed(name.error);
        patch.name = name;
      }
      if (body.description !== undefined) {
        const description = parseDescription(body.description);
        if (typeof description !== "string") return malformed(description.error);
        patch.description = description;
      }
      for (const key of ["announcement", "approval"] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== "boolean") return malformed();
        patch[key] = body[key] as boolean;
      }
      if (Object.keys(patch).length === 0) return malformed();
      const res = await deps.updateGroup(tenantId, group.jid, patch);
      if (!res.ok) return bridgeFailure(res);
      if (patch.name !== undefined) {
        try {
          await repo.renameWhatsappGroup(tenantId, group.jid, patch.name);
        } catch (err) {
          console.error(`${LOG} group renamed on WhatsApp but the stored name wasn't updated:`, errName(err));
        }
      }
      return { status: 200, body: { ok: true, groupJid: group.jid } };
    }

    case "participants": {
      const change = body.change;
      if (change !== "remove" && change !== "promote" && change !== "demote") return malformed();
      const ids = body.memberIds;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((m) => typeof m === "string" && MEMBER_ID_RE.test(m))) return malformed();
      if (ids.length > MAX_MEMBER_IDS) return fail(400, "too_many", MSG_TOO_MANY);
      const memberIds = [...new Set(ids as string[])];
      const res = await deps.updateParticipants(tenantId, group.jid, { action: change, memberIds });
      if (!res.ok) return bridgeFailure(res);
      const results = memberIds.map((memberId) => {
        const r = res.results.find((x) => x.memberId === memberId);
        const result: BridgeParticipantOutcome = r ? r.result : "failed";
        return { memberId, result, message: participantMessage(result) };
      });
      return { status: 200, body: { ok: true, groupJid: group.jid, results } };
    }

    case "invite_link":
    case "invite_reset": {
      const res = action === "invite_link" ? await deps.getInvite(tenantId, group.jid) : await deps.resetInvite(tenantId, group.jid);
      if (!res.ok) return bridgeFailure(res);
      return { status: 200, body: { ok: true, groupJid: group.jid, link: res.link } };
    }

    case "leave": {
      const res = await deps.leaveGroup(tenantId, group.jid);
      if (!res.ok) return bridgeFailure(res);
      try {
        await repo.markWhatsappGroupLeft(tenantId, group.jid);
      } catch (err) {
        console.error(`${LOG} left the group on WhatsApp but couldn't mark it left:`, errName(err));
      }
      const refreshed = await deps.refreshGroups(tenantId);
      if (!refreshed.ok) console.warn(`${LOG} left a group but the bridge reload failed with code ${refreshed.code}`);
      return { status: 200, body: { ok: true, groupJid: group.jid, left: true } };
    }

    case "invite": {
      const audienceInput = parseAudience(body);
      if (typeof audienceInput === "string") return malformed(audienceInput);
      if (audienceInput === null) return malformed("Choose at least one contact or a tag.");
      const directAdd = parseDirectAdd(body);
      if (directAdd === null) return malformed();
      const audience = await resolveAudience(deps, ctx, audienceInput);
      if ("status" in audience) return audience;
      const sent = await inviteAndPost(deps, ctx, group, audience, audience.invitees, directAdd);
      return { status: 200, body: { ok: true, groupJid: group.jid, invites: invitesView(sent, audience.skipped, [], audience.truncated, audience.invitees) } };
    }
  }
}

const GROUP_ACTIONS: readonly string[] = ["detail", "update", "participants", "invite_link", "invite_reset", "leave", "invite"];

/**
 * The slot the guard resolves for this route. A malformed or oversized body
 * (`null` from `readSmallJsonBody`) is guarded as slot 1 so the caller still
 * has to prove a valid token, and then gets 400 `invalid_body` from
 * `decideGroupManageRequest` rather than the guard's `invalid_slot`.
 */
export function manageSlotFromBody(body: Record<string, unknown> | null): SlotParseResult {
  return requestedSlotFromBody(body ?? {});
}

/** The whole route, for one already-authorised number. Never echoes a tenant id. `null` body is `readSmallJsonBody`'s malformed body. */
export async function decideGroupManageRequest(
  repo: GroupManageRepo,
  deps: GroupManageDeps,
  ctx: GroupManageContext,
  body: Record<string, unknown> | null
): Promise<GroupManageResult> {
  if (body === null || typeof body.action !== "string") return malformed();
  if (body.action === "create") return handleCreate(repo, deps, ctx, body);
  if (body.action === "search_contacts") return handleSearchContacts(repo, deps, ctx, body);
  if (GROUP_ACTIONS.includes(body.action)) return handleGroupAction(repo, deps, ctx, body.action as GroupAction, body);
  return malformed();
}
