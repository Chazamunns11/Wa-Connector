/**
 * Opt-in WhatsApp groups — the pure helpers the group paths in sessions.ts,
 * inbound.ts, store.ts and server.ts share (docs/superpowers/specs/
 * 2026-10-17-whatsapp-groups-design.md).
 *
 * OPT-IN, FAIL CLOSED: a linked number is often its owner's personal phone,
 * sitting in family and friends groups that must never land in a CRM.
 * Nothing about a group is stored or forwarded until the owner enables it
 * (`whatsapp_groups.enabled`, 0004). The bridge keeps each session's enabled
 * set in memory (`Session.enabledGroups`, sessions.ts), loaded on every
 * connection 'open' and on `POST /sessions/:id/groups/refresh`; until a load
 * lands, and after any failed load, the set is EMPTY, so group traffic is
 * dropped rather than guessed at.
 *
 * HARD RULE 3 STILL HOLDS: a group JID is never built by string
 * concatenation. It comes from Baileys' own group list
 * (`groupFetchAllParticipating`), is stored when the owner enables it, and
 * must match `GROUP_JID_RE` (the same pattern as 0004's and 0005's CHECKs)
 * before ANY store write — including inbound rows, whose `group_jid` column
 * has no CHECK of its own.
 *
 * PRIVACY: group names and JIDs are never logged anywhere in this package —
 * tenant ids and message ids only.
 */
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import { isBoom } from "@hapi/boom";

/** The one group-JID shape this bridge accepts — byte-identical to whatsapp_groups.group_jid's CHECK (0004) and whatsapp_messages.group_jid's (0005). */
export const GROUP_JID_RE = /^[0-9]+(-[0-9]+)?@g\.us$/;

/** True iff `jid` is a well-formed WhatsApp group id (`120363…@g.us`, or the older `<creator>-<timestamp>@g.us`). */
export function isGroupJid(jid: string): boolean {
  return typeof jid === "string" && GROUP_JID_RE.test(jid);
}

/**
 * Daily-cap units one group send costs (global constraint). A group message
 * reaches every member at once, so it carries more ban risk than a 1:1 send;
 * the pacer counts it as five (`SessionPacer.recordSend(units)`, and the
 * accept-time reservation in sessions.ts).
 */
export const GROUP_SEND_CAP_UNITS = 5;

/** Fixed refusal (global constraint, verbatim): our number has left, or was removed from, the group. */
export const NOT_IN_GROUP_REASON = "This WhatsApp number is no longer in that group";

/** Fixed refusal (global constraint, verbatim): the owner switched the group off after the send was accepted. */
export const GROUP_SYNC_OFF_REASON = "WhatsApp group sync is turned off for this group";

/** What `GET /sessions/:id/groups` returns per group. Shown to the owner only; never stored by the bridge. */
export interface GroupListEntry {
  jid: string;
  name: string;
  size: number;
}

/** The parts of Baileys' `GroupParticipant` (a `Contact`) this module reads. */
export interface ParticipantLike {
  id: string;
  lid?: string;
  phoneNumber?: string;
}

/** The parts of Baileys' `GroupMetadata` this module reads. */
export interface GroupMetadataLike {
  id: string;
  subject: string;
  size?: number;
  participants: ParticipantLike[];
}

/** The linked device's own identity (`sock.user`, a Baileys `Contact`). */
export interface OwnIdentity {
  id?: string;
  lid?: string;
  phoneNumber?: string;
}

/**
 * Maps `groupFetchAllParticipating()` to the list route's shape. A group
 * whose id does not pass `isGroupJid` is left out: the app stores what the
 * owner enables under 0004's CHECK, so offering one it could never store
 * would only fail later.
 */
export function toGroupList(all: Record<string, GroupMetadataLike>): GroupListEntry[] {
  return Object.values(all)
    .filter((group) => isGroupJid(group.id))
    .map((group) => ({ jid: group.id, name: group.subject, size: group.size ?? group.participants.length }));
}

/**
 * `user@server` with the device part stripped (`447…:12@s.whatsapp.net` ->
 * `447…@s.whatsapp.net`, `200…:12@lid` -> `200…@lid`), or null. The SERVER is
 * kept on purpose: a LID's digits can equal some phone number's digits, so
 * comparing user parts alone could mistake a stranger's LID for our PN.
 */
function normalisedUser(jid: string | undefined): string | null {
  if (!jid) return null;
  return jidNormalizedUser(jid) || null;
}

/**
 * True iff our own number is among `participants`. Baileys 7 may list a
 * participant by LID or by PN (`id`), with the other form in `lid` /
 * `phoneNumber` when it knows it; our own identity likewise has a PN
 * (`user.id`) and usually a LID (`user.lid`). Any match between the two
 * sets counts.
 */
export function isOwnNumberAParticipant(participants: readonly ParticipantLike[], me: OwnIdentity | undefined): boolean {
  if (!me) return false;
  const mine = new Set([normalisedUser(me.id), normalisedUser(me.lid), normalisedUser(me.phoneNumber)].filter((v): v is string => v !== null));
  if (mine.size === 0) return false;
  return participants.some((p) => [p.id, p.lid, p.phoneNumber].some((jid) => {
    const user = normalisedUser(jid);
    return user !== null && mine.has(user);
  }));
}

/** The one socket surface the participant check needs — narrow so tests fake it without a Baileys socket. */
export interface GroupMembershipSocket {
  user?: OwnIdentity;
  groupMetadata(jid: string): Promise<{ participants: ParticipantLike[] }>;
}

export type GroupMembershipCheck = { kind: "member" } | { kind: "not_member" } | { kind: "check_failed"; err: Error };

/** WhatsApp's IQ error codes for "you are not in this group": 403 forbidden (left or removed), 404 item-not-found. */
const NOT_IN_GROUP_CODES: ReadonlySet<number> = new Set([403, 404]);

/**
 * True iff `err` is WhatsApp refusing a group lookup because our number is
 * no longer in the group. Baileys 7.0.0-rc14 throws an IQ error node as
 * `new Boom(text, { data: +code })` (WABinary/generic-utils.js
 * `assertNodeErrorFree`), so the WhatsApp code is in `data` and statusCode
 * stays 500; a Boom built with the code as its statusCode counts too.
 * Anything else (timeouts, a closed connection, other codes, a non-Boom
 * error) is not this.
 */
export function isNotInGroupError(err: unknown): boolean {
  if (!isBoom(err)) return false;
  return (typeof err.data === "number" && NOT_IN_GROUP_CODES.has(err.data)) || NOT_IN_GROUP_CODES.has(err.output.statusCode);
}

/**
 * The group counterpart of the `onWhatsApp` existence check (sessions.ts's
 * `drainQueue`): ask WhatsApp for the group's current members and confirm
 * our own number is one. Once the number has left or been removed,
 * WhatsApp usually refuses the lookup (403/404, `isNotInGroupError`) rather
 * than listing members without us; both mean `not_member`. Never throws —
 * any other failed lookup is `check_failed`, which the caller fails as NOT
 * dispatched, exactly like a failed existence check.
 */
export async function checkGroupMembership(sock: GroupMembershipSocket, groupJid: string): Promise<GroupMembershipCheck> {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    return isOwnNumberAParticipant(metadata.participants ?? [], sock.user) ? { kind: "member" } : { kind: "not_member" };
  } catch (err) {
    if (isNotInGroupError(err)) return { kind: "not_member" };
    return { kind: "check_failed", err: err as Error };
  }
}
