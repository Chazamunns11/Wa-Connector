/**
 * Group management — create groups, add/remove/promote/demote members,
 * settings, invite links, leave (docs/superpowers/plans/
 * 2026-10-17-group-management.md, Task 3). The Baileys calls and every safety
 * rule live here; src/sessions.ts only resolves the session and delegates.
 *
 * RULES, all enforced here:
 * - Only a group that passes `isGroupJid` AND is in the session's enabled
 *   set may be managed (create excepted). Every mutating op except leave
 *   first checks, from fresh `groupMetadata`, that our number is an admin.
 * - Direct adds go only to a phone that has messaged this number in the last
 *   90 days (`store.hasInboundFromPhone`), then through `onWhatsApp`, and use
 *   the JID WhatsApp returns (hard rule 3). Never during warm-up. At most the
 *   day's grant from `GroupActionLimits`; the rest are `limit_reached` and
 *   the caller sends them an invite link instead.
 * - Remove/promote/demote address members by the exact member id
 *   `groupMetadata` lists (a LID-only member has no phone). Our own number
 *   is never removed (Leave is the way out) and no demote may leave the
 *   group without an admin.
 * - Create tries an EMPTY group first. Only if WhatsApp refuses that does it
 *   retry with the first eligible contact (one direct add). A create counts
 *   against the day once it is reserved, whether or not WhatsApp then makes
 *   the group. A repeated `requestId` within 10 minutes replays the first
 *   outcome instead of making a second group.
 * - Every mutating op writes a `whatsapp_group_actions` row (create/add rows
 *   via `GroupActionLimits`, which fails closed; the others are an audit
 *   trail, best effort).
 *
 * PRIVACY: never logged — group names, descriptions, invite codes or links,
 * phone numbers, member ids, group JIDs. Tenant id, op name and error NAME
 * only (a Baileys error message can quote any of those).
 */
import type { Logger } from "pino";
import { isBoom } from "@hapi/boom";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import type { BridgeStore, GroupActionKind } from "./store.js";
import type { GroupActionLimits } from "./group-limits.js";
import {
  GROUP_ADD_LIMIT_REASON,
  GROUP_NEEDS_MEMBER_REASON,
  GROUP_NOT_ADMIN_REASON,
  GROUP_WARMUP_REASON,
  groupCreateLimitReason,
  isGroupJid,
  isOwnNumberAParticipant,
  toMemberView,
  type GroupDetail,
  type OwnIdentity,
  type ParticipantLike,
} from "./groups.js";
import { isE164 } from "./phone.js";

export type ParticipantResult = {
  phone?: string;
  memberId?: string;
  result: "ok" | "invite_required" | "not_eligible" | "not_on_whatsapp" | "already_member" | "limit_reached" | "warmup" | "self" | "last_admin" | "not_member" | "duplicate" | "failed";
};

export type GroupRefusalCode = "create_limit" | "add_limit" | "warmup" | "needs_member" | "not_admin" | "limits_unavailable";

export type GroupOpOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "session_not_connected" }
  | { kind: "group_not_enabled" }
  | { kind: "refused"; code: GroupRefusalCode; message: string }
  | { kind: "too_many" }
  | { kind: "failed" };

export interface CreateGroupInput {
  requestId: string;
  name: string;
  description?: string;
  /** E.164 fallback candidates for the first member, in order, used only if WhatsApp refuses an empty group. */
  participants: string[];
}

export interface CreatedGroup {
  jid: string;
  name: string;
  addedPhone: string | null;
  path: "empty" | "with_member";
  /** Set when CreateRequestCache served an existing entry for this requestId: the first call already made (or is making) the group, so the caller must not record it or send invites again. */
  replayed?: true;
}

export interface GroupPatch {
  name?: string;
  description?: string;
  announcement?: boolean;
  approval?: boolean;
}

export type ParticipantsRequest = { action: "add"; phones: string[] } | { action: "remove" | "promote" | "demote"; memberIds: string[] };

/** Fixed message for a limits read/write that failed (fail closed). Not one of the GHL-facing strings: the route answers 503. */
export const GROUP_LIMITS_UNAVAILABLE_REASON = "Group limits are unavailable right now. Try again shortly.";

/** The most people one participants request may name (the largest count one action row may hold). */
const MAX_PARTICIPANTS_PER_CALL = 50;

/** The parts of Baileys' group metadata this module reads. */
interface ManagedGroupMetadata {
  id: string;
  subject: string;
  desc?: string;
  announce?: boolean;
  joinApprovalMode?: boolean;
  participants: ParticipantLike[];
}

/** The Baileys socket surface (7.0.0-rc14, Socket/groups.d.ts) this module calls — narrow so tests fake it. */
export interface GroupSocket {
  user?: OwnIdentity;
  groupMetadata(jid: string): Promise<ManagedGroupMetadata>;
  groupCreate(subject: string, participants: string[]): Promise<{ id: string; subject?: string }>;
  groupParticipantsUpdate(jid: string, participants: string[], action: "add" | "remove" | "promote" | "demote"): Promise<{ status: string; jid?: string }[]>;
  groupUpdateSubject(jid: string, subject: string): Promise<void>;
  groupUpdateDescription(jid: string, description?: string): Promise<void>;
  groupSettingUpdate(jid: string, setting: "announcement" | "not_announcement"): Promise<void>;
  groupJoinApprovalMode(jid: string, mode: "on" | "off"): Promise<void>;
  groupInviteCode(jid: string): Promise<string | undefined>;
  groupRevokeInvite(jid: string): Promise<string | undefined>;
  groupLeave(jid: string): Promise<void>;
  groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string; owner?: string; ownerPn?: string; creation?: number }>>;
  onWhatsApp(...phoneNumbers: string[]): Promise<{ jid: string; exists: boolean }[] | undefined>;
}

/** Everything one op needs from its session. `groups` is read at call time: `enabledGroups` is replaced wholesale by each load. */
export interface GroupOpContext {
  coachId: string;
  sock: GroupSocket;
  groups: { enabledGroups: Set<string>; recentlyCreated: Map<string, number> };
  limits: Pick<GroupActionLimits, "reserveCreate" | "reserveAdds">;
  createDaily: number;
  inWarmup: () => boolean;
  store: Pick<BridgeStore, "hasInboundFromPhone" | "recordGroupAction">;
  createRequests: CreateRequestCache;
  log: Logger;
  now: () => number;
}

const CREATE_REPLAY_MS = 10 * 60 * 1000;

/**
 * Remembers each create `requestId` for 10 minutes so a double click or a
 * retried request (the embed timed out after WhatsApp had made the group)
 * gets the first call's outcome instead of a second group. A concurrent
 * duplicate shares the in-flight call. A served entry's ok outcome carries
 * `replayed: true`, so the caller knows the first call owns the follow-up.
 *
 * Only two outcomes are kept: a success, and a failure after WhatsApp's
 * create was reached (the group may exist). A refusal is never kept: every
 * refusal means no group was made, so the same form can try again after
 * fixing the cause.
 */
export class CreateRequestCache {
  private readonly entries = new Map<string, { at: number; outcome: Promise<GroupOpOutcome<CreatedGroup>> }>();

  constructor(private readonly now: () => number = Date.now) {}

  run(requestId: string, fn: (markReachedWhatsApp: () => void) => Promise<GroupOpOutcome<CreatedGroup>>): Promise<GroupOpOutcome<CreatedGroup>> {
    const now = this.now();
    for (const [id, entry] of this.entries) if (now - entry.at >= CREATE_REPLAY_MS) this.entries.delete(id);
    const existing = this.entries.get(requestId);
    if (existing) {
      return existing.outcome.then((result): GroupOpOutcome<CreatedGroup> => (result.kind === "ok" ? { kind: "ok", value: { ...result.value, replayed: true } } : result));
    }
    let reached = false;
    const outcome = fn(() => (reached = true));
    const entry = { at: now, outcome };
    this.entries.set(requestId, entry);
    void outcome.then(
      (result) => {
        const keep = result.kind === "ok" || (result.kind !== "refused" && reached);
        if (!keep && this.entries.get(requestId) === entry) this.entries.delete(requestId);
      },
      () => {
        if (this.entries.get(requestId) === entry) this.entries.delete(requestId);
      }
    );
    return outcome;
  }
}

function refused(code: GroupRefusalCode, message: string): { kind: "refused"; code: GroupRefusalCode; message: string } {
  return { kind: "refused", code, message };
}

function logFailure(ctx: GroupOpContext, op: string, err: unknown): void {
  ctx.log.error({ coachId: ctx.coachId, op, err: (err as Error)?.name ?? "Error" }, "group action failed");
}

/**
 * Audit row for a non-limited action (remove, promote, demote, update,
 * invite_reset, leave). Written BEFORE the Baileys call, so it records the
 * ATTEMPT, whether or not WhatsApp then carries it out. Best effort: a
 * failed write is logged and swallowed, never blocking the action.
 */
async function audit(ctx: GroupOpContext, action: GroupActionKind, count: number, groupJid: string): Promise<void> {
  try {
    await ctx.store.recordGroupAction(ctx.coachId, action, Math.min(count, MAX_PARTICIPANTS_PER_CALL), groupJid);
  } catch (err) {
    ctx.log.warn({ coachId: ctx.coachId, op: action, err: (err as Error)?.name ?? "Error" }, "group action audit write failed");
  }
}

function isEnabled(ctx: GroupOpContext, jid: string): boolean {
  return isGroupJid(jid) && ctx.groups.enabledGroups.has(jid);
}

function weAreAdmin(participants: readonly ParticipantLike[], me: OwnIdentity | undefined): boolean {
  return participants.some((p) => (p.admin === "admin" || p.admin === "superadmin") && isOwnNumberAParticipant([p], me));
}

/** Fresh metadata with the admin check. `failed` if the lookup throws. */
async function adminMetadata(ctx: GroupOpContext, jid: string, op: string): Promise<{ ok: ManagedGroupMetadata } | { outcome: GroupOpOutcome<never> }> {
  let metadata: ManagedGroupMetadata;
  try {
    metadata = await ctx.sock.groupMetadata(jid);
  } catch (err) {
    logFailure(ctx, op, err);
    return { outcome: { kind: "failed" } };
  }
  if (!weAreAdmin(metadata.participants ?? [], ctx.sock.user)) return { outcome: refused("not_admin", GROUP_NOT_ADMIN_REASON) };
  return { ok: metadata };
}

/** The JID WhatsApp returns for `phone`, or null if it is not on WhatsApp (hard rule 3). Throws if the lookup fails. */
async function resolveOnWhatsApp(sock: GroupSocket, phone: string): Promise<string | null> {
  const results = await sock.onWhatsApp(phone);
  return results?.find((r) => r.exists)?.jid ?? null;
}

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

type CreateResult = { id: string; subject?: string };

/**
 * True iff `err` is WhatsApp answering the IQ with an error node — Baileys
 * 7.0.0-rc14 throws those as `new Boom(text, { data: +code })`
 * (WABinary/generic-utils.js `assertNodeErrorFree`). Only then do we know
 * WhatsApp refused and made nothing. A timeout (408), "Connection Closed",
 * or a reply missing its <group> node carries no numeric `data`.
 */
function isWhatsAppErrorNode(err: unknown): boolean {
  return isBoom(err) && typeof err.data === "number";
}

/** How recently a group must have been created to count as the one an ambiguous create made. */
const JUST_CREATED_WINDOW_S = 120;

/**
 * After an ambiguous create error: one `groupFetchAllParticipating` scan for
 * a group with exactly this subject, owned by our own number, created in
 * the last 2 minutes. Found -> that is the group the call made. Not found
 * (or the scan fails) -> null, and the caller reports `failed`. Logs the
 * error name only — never the subject.
 */
async function findJustCreatedGroup(ctx: GroupOpContext, subject: string, err: unknown): Promise<CreateResult | null> {
  try {
    const all = await ctx.sock.groupFetchAllParticipating();
    const nowS = ctx.now() / 1000;
    const match = Object.values(all).find(
      (g) =>
        isGroupJid(g.id) &&
        // An earlier create in the same window is not this one.
        !ctx.groups.recentlyCreated.has(g.id) &&
        g.subject === subject &&
        typeof g.creation === "number" &&
        nowS - g.creation <= JUST_CREATED_WINDOW_S &&
        g.creation - nowS <= JUST_CREATED_WINDOW_S &&
        isOwnNumberAParticipant([{ id: g.owner ?? "", phoneNumber: g.ownerPn }], ctx.sock.user)
    );
    if (match) {
      ctx.log.warn({ coachId: ctx.coachId, op: "create", err: (err as Error)?.name ?? "Error" }, "group create errored but the group was made — using it");
      return { id: match.id, subject: match.subject };
    }
    ctx.log.error({ coachId: ctx.coachId, op: "create", err: (err as Error)?.name ?? "Error" }, "group create failed ambiguously and no new group was found");
  } catch (scanErr) {
    ctx.log.error({ coachId: ctx.coachId, op: "create", err: (err as Error)?.name ?? "Error", scanErr: (scanErr as Error)?.name ?? "Error" }, "group create failed ambiguously and the group scan failed");
  }
  return null;
}

/** A `whatsapp_groups` row's switch state, as `BridgeStore.groupRowStates` reads it. */
export interface GroupRowState {
  jid: string;
  enabled: boolean;
  left: boolean;
}

/**
 * The enabled set a load returned, plus every group this session created in
 * the last 10 minutes that is still meant to be on — the app records a new
 * group and refreshes shortly after the create, and a socket bounce or an
 * older in-flight load before that must not switch it off. For each recent
 * group missing from the loaded list, its row decides:
 *   - no row yet (the app has not recorded it): kept on;
 *   - row enabled and not left (written between the two reads): kept on;
 *   - row disabled or left (switched off since): forgotten, stays off.
 * Prunes expired entries. If the row lookup fails, nothing is forced in
 * (fail closed) and `lookupFailed` is set; the entries are kept for the next load.
 */
export async function withRecentlyCreated(
  loaded: Iterable<string>,
  recentlyCreated: Map<string, number>,
  now: number,
  groupRowStates: (jids: string[]) => Promise<GroupRowState[]>
): Promise<{ enabled: Set<string>; lookupFailed: boolean }> {
  const enabled = new Set(loaded);
  const pending: string[] = [];
  for (const [jid, at] of recentlyCreated) {
    if (now - at >= RECENTLY_CREATED_MS || !isGroupJid(jid)) recentlyCreated.delete(jid);
    else if (!enabled.has(jid)) pending.push(jid);
  }
  if (pending.length === 0) return { enabled, lookupFailed: false };
  let rows: Map<string, GroupRowState>;
  try {
    rows = new Map((await groupRowStates(pending)).map((r) => [r.jid, r]));
  } catch {
    return { enabled, lookupFailed: true };
  }
  for (const jid of pending) {
    const row = rows.get(jid);
    if (row && (!row.enabled || row.left)) recentlyCreated.delete(jid);
    else enabled.add(jid);
  }
  return { enabled, lookupFailed: false };
}

const RECENTLY_CREATED_MS = 10 * 60 * 1000;

export function createGroup(ctx: GroupOpContext, input: CreateGroupInput): Promise<GroupOpOutcome<CreatedGroup>> {
  return ctx.createRequests.run(input.requestId, (markReached) => doCreateGroup(ctx, input, markReached));
}

async function doCreateGroup(ctx: GroupOpContext, input: CreateGroupInput, markReached: () => void): Promise<GroupOpOutcome<CreatedGroup>> {
  if (ctx.inWarmup()) return refused("warmup", GROUP_WARMUP_REASON);
  const reservation = await ctx.limits.reserveCreate(ctx.coachId);
  if (reservation === "limit") return refused("create_limit", groupCreateLimitReason(ctx.createDaily));
  if (reservation === "unavailable") return refused("limits_unavailable", GROUP_LIMITS_UNAVAILABLE_REASON);

  // From here a group may exist on WhatsApp, so a failure from here on is
  // replayed — a retry must never make a second group. (Refusals below are
  // still forgotten: each means WhatsApp made nothing.)
  markReached();
  let created: CreateResult | null = null;
  let addedPhone: string | null = null;
  try {
    created = await ctx.sock.groupCreate(input.name, []);
  } catch (err) {
    if (!isWhatsAppErrorNode(err)) {
      // Ambiguous (timeout, closed connection, malformed reply): the group
      // may have been made. Look for it rather than risk a second one.
      created = await findJustCreatedGroup(ctx, input.name, err);
      if (!created) return { kind: "failed" };
    } else {
      // WhatsApp answered with an error: it refused the empty group. None was made.
      ctx.log.warn({ coachId: ctx.coachId, op: "create", err: (err as Error).name, code: (err as { data: number }).data }, "empty group create refused — trying with one eligible member");
    }
  }

  if (!created) {
    let member: { phone: string; jid: string } | null = null;
    try {
      for (const phone of input.participants) {
        if (!isE164(phone)) continue;
        if (!(await ctx.store.hasInboundFromPhone(ctx.coachId, phone))) continue;
        const jid = await resolveOnWhatsApp(ctx.sock, phone);
        if (jid) {
          member = { phone, jid };
          break;
        }
      }
    } catch (err) {
      logFailure(ctx, "create_member_lookup", err);
      return { kind: "failed" };
    }
    if (!member) return refused("needs_member", GROUP_NEEDS_MEMBER_REASON);
    const grant = await ctx.limits.reserveAdds(ctx.coachId, 1, null);
    if ("unavailable" in grant) return refused("limits_unavailable", GROUP_LIMITS_UNAVAILABLE_REASON);
    if (grant.granted < 1) return refused("add_limit", GROUP_ADD_LIMIT_REASON);
    try {
      created = await ctx.sock.groupCreate(input.name, [member.jid]);
    } catch (err) {
      created = isWhatsAppErrorNode(err) ? null : await findJustCreatedGroup(ctx, input.name, err);
      if (!created) {
        if (isWhatsAppErrorNode(err)) logFailure(ctx, "create", err);
        return { kind: "failed" };
      }
    }
    addedPhone = member.phone;
  }

  if (!isGroupJid(created.id)) {
    ctx.log.error({ coachId: ctx.coachId, op: "create" }, "group create returned a malformed group id");
    return { kind: "failed" };
  }
  const jid = created.id;
  // Manageable at once, before the app's record + refresh lands — and kept
  // in through any reload for the next 10 minutes (`withRecentlyCreated`).
  ctx.groups.enabledGroups.add(jid);
  ctx.groups.recentlyCreated.set(jid, ctx.now());

  if (input.description !== undefined && input.description !== "") {
    try {
      await ctx.sock.groupUpdateDescription(jid, input.description);
    } catch (err) {
      // The group exists; reporting failure would invite a retry that makes a second one.
      ctx.log.warn({ coachId: ctx.coachId, op: "create_description", err: (err as Error)?.name ?? "Error" }, "group created but its description could not be set");
    }
  }
  ctx.log.info({ coachId: ctx.coachId, op: "create", withMember: addedPhone !== null }, "group created");
  return { kind: "ok", value: { jid, name: created.subject ?? input.name, addedPhone, path: addedPhone === null ? "empty" : "with_member" } };
}

// ---------------------------------------------------------------------------
// Detail and settings.
// ---------------------------------------------------------------------------

export async function getGroupDetail(ctx: GroupOpContext, jid: string): Promise<GroupOpOutcome<GroupDetail>> {
  if (!isEnabled(ctx, jid)) return { kind: "group_not_enabled" };
  let metadata: ManagedGroupMetadata;
  try {
    metadata = await ctx.sock.groupMetadata(jid);
  } catch (err) {
    logFailure(ctx, "detail", err);
    return { kind: "failed" };
  }
  const participants = metadata.participants ?? [];
  return {
    kind: "ok",
    value: {
      jid,
      name: metadata.subject,
      description: metadata.desc ?? null,
      announcement: metadata.announce === true,
      approval: metadata.joinApprovalMode === true,
      weAreAdmin: weAreAdmin(participants, ctx.sock.user),
      members: participants.map((p) => toMemberView(p, ctx.sock.user)),
    },
  };
}

export async function updateGroup(ctx: GroupOpContext, jid: string, patch: GroupPatch): Promise<GroupOpOutcome<null>> {
  if (!isEnabled(ctx, jid)) return { kind: "group_not_enabled" };
  const checked = await adminMetadata(ctx, jid, "update");
  if ("outcome" in checked) return checked.outcome;
  await audit(ctx, "update", 1, jid);
  try {
    if (patch.name !== undefined) await ctx.sock.groupUpdateSubject(jid, patch.name);
    if (patch.description !== undefined) await ctx.sock.groupUpdateDescription(jid, patch.description);
    if (patch.announcement !== undefined) await ctx.sock.groupSettingUpdate(jid, patch.announcement ? "announcement" : "not_announcement");
    if (patch.approval !== undefined) await ctx.sock.groupJoinApprovalMode(jid, patch.approval ? "on" : "off");
  } catch (err) {
    logFailure(ctx, "update", err);
    return { kind: "failed" };
  }
  return { kind: "ok", value: null };
}

// ---------------------------------------------------------------------------
// Participants.
// ---------------------------------------------------------------------------

function mapStatus(status: string, action: ParticipantsRequest["action"]): ParticipantResult["result"] {
  if (status === "200") return "ok";
  if (action === "add" && status === "403") return "invite_required";
  if (action === "add" && status === "409") return "already_member";
  return "failed";
}

/** One status per sent JID: matched by the JID WhatsApp echoes back, else by position when the counts line up. */
function statusesFor(sent: string[], response: { status: string; jid?: string }[]): (string | null)[] {
  const byJid = new Map(response.filter((r) => r.jid).map((r) => [r.jid as string, r.status]));
  return sent.map((jid, i) => byJid.get(jid) ?? (response.length === sent.length ? response[i]!.status : null));
}

export async function updateGroupParticipants(ctx: GroupOpContext, jid: string, req: ParticipantsRequest): Promise<GroupOpOutcome<ParticipantResult[]>> {
  if (!isEnabled(ctx, jid)) return { kind: "group_not_enabled" };
  const count = req.action === "add" ? req.phones.length : req.memberIds.length;
  if (count > MAX_PARTICIPANTS_PER_CALL) return { kind: "too_many" };
  const checked = await adminMetadata(ctx, jid, req.action);
  if ("outcome" in checked) return checked.outcome;
  return req.action === "add" ? addParticipants(ctx, jid, req.phones) : changeMembers(ctx, jid, req.action, req.memberIds, checked.ok.participants ?? []);
}

async function addParticipants(ctx: GroupOpContext, groupJid: string, phones: string[]): Promise<GroupOpOutcome<ParticipantResult[]>> {
  const results: ParticipantResult[] = phones.map((phone) => ({ phone, result: "failed" }));
  const eligible: number[] = [];
  try {
    for (const [index, phone] of phones.entries()) {
      if (isE164(phone) && (await ctx.store.hasInboundFromPhone(ctx.coachId, phone))) eligible.push(index);
      else results[index]!.result = "not_eligible";
    }
  } catch (err) {
    logFailure(ctx, "add_eligibility", err);
    return { kind: "failed" };
  }
  if (eligible.length === 0) return { kind: "ok", value: results };
  // Warm-up: no direct adds, and no contact-discovery lookups either. The
  // caller sends these an invite link.
  if (ctx.inWarmup()) {
    for (const index of eligible) results[index]!.result = "warmup";
    return { kind: "ok", value: results };
  }

  // Existence check (hard rule 3): each phone is added by the JID WhatsApp
  // returns for it. One batched call first; a result is credited to a phone
  // only when it is exactly that phone's PN JID. WhatsApp may canonicalise a
  // number differently (e.g. Brazil's extra 9), and Baileys drops results
  // without a contact, so count and order prove nothing: every phone the
  // batch did not answer unambiguously is looked up on its own.
  const resolved = new Map<string, string | null>();
  try {
    const unique = [...new Set(eligible.map((i) => phones[i]!))];
    const lookup = await ctx.sock.onWhatsApp(...unique);
    const byPnJid = new Map<string, string>();
    for (const r of lookup ?? []) {
      const key = r.exists ? jidNormalizedUser(r.jid) : "";
      if (key && !byPnJid.has(key)) byPnJid.set(key, r.jid);
    }
    for (const phone of unique) {
      const exact = byPnJid.get(`${phone.slice(1)}@s.whatsapp.net`);
      resolved.set(phone, exact ?? (await resolveOnWhatsApp(ctx.sock, phone)));
    }
  } catch (err) {
    logFailure(ctx, "add_lookup", err);
    return { kind: "failed" };
  }
  const candidates: { index: number; jid: string }[] = [];
  const queued = new Set<string>();
  for (const index of eligible) {
    const waJid = resolved.get(phones[index]!) ?? null;
    if (!waJid) results[index]!.result = "not_on_whatsapp";
    else if (queued.has(waJid)) results[index]!.result = "duplicate";
    else {
      queued.add(waJid);
      candidates.push({ index, jid: waJid });
    }
  }
  if (candidates.length === 0) return { kind: "ok", value: results };

  const grant = await ctx.limits.reserveAdds(ctx.coachId, candidates.length, groupJid);
  if ("unavailable" in grant) return refused("limits_unavailable", GROUP_LIMITS_UNAVAILABLE_REASON);
  const granted = candidates.slice(0, grant.granted);
  for (const c of candidates.slice(grant.granted)) results[c.index]!.result = "limit_reached";
  if (granted.length === 0) return { kind: "ok", value: results };

  const sent = granted.map((c) => c.jid);
  let response: { status: string; jid?: string }[];
  try {
    response = await ctx.sock.groupParticipantsUpdate(groupJid, sent, "add");
  } catch (err) {
    logFailure(ctx, "add", err);
    return { kind: "failed" };
  }
  const statuses = statusesFor(sent, response);
  granted.forEach((c, i) => {
    const status = statuses[i];
    results[c.index]!.result = status === null || status === undefined ? "failed" : mapStatus(status, "add");
  });
  ctx.log.info({ coachId: ctx.coachId, op: "add", requested: phones.length, sent: sent.length }, "group participants added");
  return { kind: "ok", value: results };
}

async function changeMembers(
  ctx: GroupOpContext,
  groupJid: string,
  action: "remove" | "promote" | "demote",
  memberIds: string[],
  participants: ParticipantLike[]
): Promise<GroupOpOutcome<ParticipantResult[]>> {
  const results: ParticipantResult[] = memberIds.map((memberId) => ({ memberId, result: "failed" }));
  const byId = new Map(participants.map((p) => [p.id, p]));
  const admins = new Set(participants.filter((p) => p.admin === "admin" || p.admin === "superadmin").map((p) => p.id));
  const targets: { index: number; jid: string }[] = [];
  const seen = new Set<string>();
  for (const [index, memberId] of memberIds.entries()) {
    const participant = byId.get(memberId);
    if (!participant || seen.has(memberId)) {
      results[index]!.result = "not_member";
      continue;
    }
    if (action === "remove" && isOwnNumberAParticipant([participant], ctx.sock.user)) {
      results[index]!.result = "self";
      continue;
    }
    if (action === "demote" && admins.has(memberId)) {
      if (admins.size <= 1) {
        results[index]!.result = "last_admin";
        continue;
      }
      admins.delete(memberId);
    }
    seen.add(memberId);
    targets.push({ index, jid: memberId });
  }
  if (targets.length === 0) return { kind: "ok", value: results };

  const sent = targets.map((t) => t.jid);
  await audit(ctx, action, sent.length, groupJid);
  let response: { status: string; jid?: string }[];
  try {
    response = await ctx.sock.groupParticipantsUpdate(groupJid, sent, action);
  } catch (err) {
    logFailure(ctx, action, err);
    return { kind: "failed" };
  }
  const statuses = statusesFor(sent, response);
  targets.forEach((t, i) => {
    const status = statuses[i];
    results[t.index]!.result = status === null || status === undefined ? "failed" : mapStatus(status, action);
  });
  return { kind: "ok", value: results };
}

// ---------------------------------------------------------------------------
// Invite link and leave.
// ---------------------------------------------------------------------------

/** WhatsApp invite codes are base62-ish; anything else is not turned into a link. */
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;

export async function getGroupInviteLink(ctx: GroupOpContext, jid: string, reset = false): Promise<GroupOpOutcome<{ link: string }>> {
  if (!isEnabled(ctx, jid)) return { kind: "group_not_enabled" };
  const op = reset ? "invite_reset" : "invite";
  const checked = await adminMetadata(ctx, jid, op);
  if ("outcome" in checked) return checked.outcome;
  if (reset) await audit(ctx, "invite_reset", 1, jid);
  let code: string | undefined;
  try {
    code = reset ? await ctx.sock.groupRevokeInvite(jid) : await ctx.sock.groupInviteCode(jid);
  } catch (err) {
    logFailure(ctx, op, err);
    return { kind: "failed" };
  }
  if (!code || !INVITE_CODE_RE.test(code)) {
    ctx.log.error({ coachId: ctx.coachId, op }, "group invite code missing or malformed");
    return { kind: "failed" };
  }
  return { kind: "ok", value: { link: `https://chat.whatsapp.com/${code}` } };
}

export async function leaveGroup(ctx: GroupOpContext, jid: string): Promise<GroupOpOutcome<null>> {
  if (!isEnabled(ctx, jid)) return { kind: "group_not_enabled" };
  await audit(ctx, "leave", 1, jid);
  try {
    await ctx.sock.groupLeave(jid);
  } catch (err) {
    logFailure(ctx, "leave", err);
    return { kind: "failed" };
  }
  ctx.groups.enabledGroups.delete(jid);
  ctx.groups.recentlyCreated.delete(jid);
  return { kind: "ok", value: null };
}
