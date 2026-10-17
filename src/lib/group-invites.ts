/**
 * Group invites: turn GHL contacts into invitees, then invite each one to a
 * WhatsApp group (a direct add where WhatsApp allows it, otherwise the invite
 * link as a normal outbound message). Nothing here posts to GHL Conversations
 * (the route does that, once per entry of `delivered`). Never logs phones,
 * names, contact ids, links or message text.
 */
import { GHL_GROUP_CONTACT_TAG, getGhlContact, searchGhlContacts, type GhlContactLite } from "@/lib/ghl";
import { optedOutReason, sendAppOriginatedText } from "@/lib/ghl-provider";
import type { GhlProviderDeps, GhlProviderRepo, HandleProviderOutboundOutcome } from "@/lib/ghl-provider";
import { normalisePhoneE164 } from "@/lib/phone";
import {
  getWhatsappGroupInvite,
  updateWhatsappGroupParticipants,
  type BridgeInviteResult,
  type BridgeParticipantsResult,
  type WhatsappParticipantsRequest,
} from "@/lib/whatsapp-bridge";
import type { GhlAccount } from "@/lib/types";

export const DEFAULT_GROUP_INVITE_TEMPLATE = "Hi {first_name}, {coach_name} invited you to join {group_name} on WhatsApp: {link}";
export const INVITE_TEMPLATE_MISSING_LINK = "The invite message must include {link}.";
export const INVITE_TEMPLATE_TOO_LONG = "The invite message must be 500 characters or fewer.";
export const MAX_INVITE_TEMPLATE = 500;
export const MAX_INVITEES_PER_REQUEST = 100;
/** The bridge accepts at most this many phones in one direct-add call. */
const MAX_ADD_PHONES_PER_CALL = 50;

export const INVITE_LINK_UNAVAILABLE = "Couldn't get the group's invite link — try again";
export const INVITE_SEND_FAILED = "Couldn't send the invite — try again";
export const INVITEE_LOOKUP_FAILED = "Couldn't read those contacts from GoHighLevel — try again";

const codePoints = (s: string): number => [...s].length;

export function validateInviteTemplate(raw: unknown): { ok: true; template: string } | { ok: false; message: string } {
  const template = typeof raw === "string" ? raw.trim() : "";
  if (!template.includes("{link}")) return { ok: false, message: INVITE_TEMPLATE_MISSING_LINK };
  if (codePoints(template) > MAX_INVITE_TEMPLATE) return { ok: false, message: INVITE_TEMPLATE_TOO_LONG };
  return { ok: true, template };
}

/** Replaces every `{first_name}`, `{group_name}`, `{coach_name}` and `{link}` in one pass (values are never re-expanded); other `{…}` text stays. */
export function renderInviteMessage(
  template: string,
  vars: { firstName: string | null; groupName: string; coachName: string; link: string }
): string {
  const values: Record<string, string> = {
    first_name: vars.firstName?.trim() || "there",
    group_name: vars.groupName,
    coach_name: vars.coachName,
    link: vars.link,
  };
  return template.replace(/\{(first_name|group_name|coach_name|link)\}/g, (_m, key: string) => values[key]);
}

export type Invitee = { contactId: string; firstName: string | null; phone: string };
export type SkippedInvitee = { contactId: string; name: string | null; reason: "no_phone" | "group_contact" | "duplicate_phone" | "opted_out" };

export interface ResolveInviteesDeps {
  getContact: typeof getGhlContact;
  searchContacts: typeof searchGhlContacts;
  /** Location-wide STOP check for a phone: a reason, or null. */
  optedOutReason: (locationId: string, tenantId: string, phone: string) => Promise<string | null>;
}

export function defaultResolveInviteesDeps(repo: GhlProviderRepo): ResolveInviteesDeps {
  return {
    getContact: getGhlContact,
    searchContacts: searchGhlContacts,
    optedOutReason: (locationId, tenantId, phone) => optedOutReason(repo, locationId, tenantId, phone),
  };
}

export async function resolveInvitees(
  deps: ResolveInviteesDeps,
  input: { accessToken: string; locationId: string; tenantId: string; contactIds?: string[]; tag?: string }
): Promise<{ ok: true; invitees: Invitee[]; skipped: SkippedInvitee[]; truncated: boolean } | { ok: false; message: string }> {
  const ids = [...new Set(input.contactIds ?? [])];
  const tag = input.tag?.trim();
  if (ids.length === 0 && !tag) return { ok: false, message: "Choose at least one contact or a tag." };

  const contacts: GhlContactLite[] = [];
  const seenIds = new Set<string>();
  const add = (c: GhlContactLite): void => {
    if (seenIds.has(c.id)) return;
    seenIds.add(c.id);
    contacts.push(c);
  };
  let truncated = ids.length > MAX_INVITEES_PER_REQUEST;
  for (const id of ids.slice(0, MAX_INVITEES_PER_REQUEST)) {
    const got = await deps.getContact(input.accessToken, id);
    if (!got.ok) return { ok: false, message: INVITEE_LOOKUP_FAILED };
    add(got.contact);
  }
  if (tag) {
    const found = await deps.searchContacts(input.accessToken, input.locationId, { tag }, MAX_INVITEES_PER_REQUEST);
    if (!found.ok) return { ok: false, message: INVITEE_LOOKUP_FAILED };
    if (found.truncated) truncated = true;
    for (const c of found.contacts) add(c);
  }
  if (contacts.length > MAX_INVITEES_PER_REQUEST) {
    contacts.length = MAX_INVITEES_PER_REQUEST;
    truncated = true;
  }

  const invitees: Invitee[] = [];
  const skipped: SkippedInvitee[] = [];
  const seenPhones = new Set<string>();
  try {
    for (const c of contacts) {
      const skip = (reason: SkippedInvitee["reason"]): void => {
        skipped.push({ contactId: c.id, name: c.name, reason });
      };
      if (c.tags.some((t) => t.toLowerCase() === GHL_GROUP_CONTACT_TAG)) {
        skip("group_contact");
        continue;
      }
      const phone = c.phone ? normalisePhoneE164(c.phone, "GB") : null;
      if (!phone) {
        skip("no_phone");
        continue;
      }
      if (seenPhones.has(phone)) {
        skip("duplicate_phone");
        continue;
      }
      seenPhones.add(phone);
      if ((await deps.optedOutReason(input.locationId, input.tenantId, phone)) !== null) {
        skip("opted_out");
        continue;
      }
      invitees.push({ contactId: c.id, firstName: c.firstName, phone });
    }
  } catch (err) {
    console.error("[group-invites] resolveInvitees: opt-out check failed:", err instanceof Error ? err.name : "unknown");
    return { ok: false, message: INVITEE_LOOKUP_FAILED };
  }
  return { ok: true, invitees, skipped, truncated };
}

export interface SendGroupInvitesDeps {
  getInvite: (coachId: string, jid: string) => Promise<BridgeInviteResult>;
  updateParticipants: (coachId: string, jid: string, req: WhatsappParticipantsRequest) => Promise<BridgeParticipantsResult>;
  /** The sub-account's saved invite message, or null (the default wording is then used). */
  getTemplate: (locationId: string) => Promise<string | null>;
  hasInboundFromPhone: (tenantId: string, phone: string) => Promise<boolean>;
  /** Location-wide STOP check for a phone: a reason, or null. */
  optedOutReason: (locationId: string, tenantId: string, phone: string) => Promise<string | null>;
  sendText: (input: { account: GhlAccount; tenantId: string; ghlContactId: string; toPhone: string; text: string }) => Promise<HandleProviderOutboundOutcome>;
}

export function defaultSendGroupInvitesDeps(
  repo: GhlProviderRepo & { getGroupInviteTemplate(locationId: string): Promise<string | null>; hasInboundFromPhone(tenantId: string, phone: string): Promise<boolean> },
  providerDeps: GhlProviderDeps
): SendGroupInvitesDeps {
  return {
    getInvite: getWhatsappGroupInvite,
    updateParticipants: updateWhatsappGroupParticipants,
    getTemplate: (locationId) => repo.getGroupInviteTemplate(locationId),
    hasInboundFromPhone: (tenantId, phone) => repo.hasInboundFromPhone(tenantId, phone),
    optedOutReason: (locationId, tenantId, phone) => optedOutReason(repo, locationId, tenantId, phone),
    sendText: (i) => sendAppOriginatedText(repo, providerDeps, i),
  };
}

/**
 * What happened to each invitee.
 *  - `added`: contact ids added straight to the group (no message sent).
 *  - `sent`: invite messages accepted by the bridge, plus those queued for retry.
 *  - `held`: invite messages held until the number reconnects.
 *  - `refused`: contact id and a reason GHL can show as-is.
 *  - `delivered`: one entry per message counted in `sent` or `held`, in send
 *    order, with the rendered text. The route posts each into the contact's
 *    GHL conversation, once. Never contains added, refused or skipped contacts.
 */
export type SendGroupInvitesResult = {
  added: string[];
  sent: number;
  held: number;
  refused: { contactId: string; reason: string }[];
  delivered: { contactId: string; text: string }[];
};

export async function sendGroupInvites(
  deps: SendGroupInvitesDeps,
  input: { account: GhlAccount; tenantId: string; group: { jid: string; name: string }; invitees: Invitee[]; directAdd: boolean; coachName: string }
): Promise<SendGroupInvitesResult> {
  const result: SendGroupInvitesResult = { added: [], sent: 0, held: 0, refused: [], delivered: [] };
  const { account, tenantId, group, invitees } = input;
  if (invitees.length === 0) return result;

  // The link comes first: a failed add needs the link fallback, so with no
  // link nothing is added or sent.
  const invite = await deps.getInvite(tenantId, group.jid);
  if (!invite.ok) {
    result.refused = invitees.map((i) => ({ contactId: i.contactId, reason: INVITE_LINK_UNAVAILABLE }));
    return result;
  }

  let template = DEFAULT_GROUP_INVITE_TEMPLATE;
  try {
    const stored = await deps.getTemplate(account.locationId);
    if (stored !== null) {
      const valid = validateInviteTemplate(stored);
      if (valid.ok) template = valid.template;
    }
  } catch (err) {
    console.error("[group-invites] sendGroupInvites: template read failed (default wording used):", err instanceof Error ? err.name : "unknown");
  }

  // Direct add: only people who have messaged this number before and haven't said STOP.
  const addedPhones = new Set<string>();
  if (input.directAdd) {
    const candidates: Invitee[] = [];
    for (const i of invitees) {
      try {
        if ((await deps.optedOutReason(account.locationId, tenantId, i.phone)) !== null) continue;
        if (await deps.hasInboundFromPhone(tenantId, i.phone)) candidates.push(i);
      } catch (err) {
        console.error("[group-invites] sendGroupInvites: eligibility check failed (invite by link instead):", err instanceof Error ? err.name : "unknown");
      }
    }
    for (let at = 0; at < candidates.length; at += MAX_ADD_PHONES_PER_CALL) {
      const chunk = candidates.slice(at, at + MAX_ADD_PHONES_PER_CALL);
      const res = await deps.updateParticipants(tenantId, group.jid, { action: "add", phones: chunk.map((c) => c.phone) });
      // Any failure (add_limit, warmup, ...) means: invite those by link.
      if (!res.ok) {
        if (res.code === "add_limit" || res.code === "warmup") break;
        continue;
      }
      for (const c of chunk) {
        const r = res.results.find((x) => x.phone === c.phone);
        if (r && (r.result === "ok" || r.result === "already_member")) {
          addedPhones.add(c.phone);
          result.added.push(c.contactId);
        }
      }
      if (res.results.some((x) => x.result === "limit_reached" || x.result === "warmup")) break;
    }
  }

  for (const i of invitees) {
    if (addedPhones.has(i.phone)) continue;
    const text = renderInviteMessage(template, { firstName: i.firstName, groupName: group.name, coachName: input.coachName, link: invite.link });
    const outcome = await deps.sendText({ account, tenantId, ghlContactId: i.contactId, toPhone: i.phone, text });
    switch (outcome.kind) {
      case "accepted":
      case "pending_retry":
        result.sent += 1;
        result.delivered.push({ contactId: i.contactId, text });
        break;
      case "held":
        result.held += 1;
        result.delivered.push({ contactId: i.contactId, text });
        break;
      case "refused":
        result.refused.push({ contactId: i.contactId, reason: outcome.reason });
        break;
      default:
        // "error", and anything the outbound path adds later: never a sent invite.
        result.refused.push({ contactId: i.contactId, reason: INVITE_SEND_FAILED });
    }
  }
  return result;
}
