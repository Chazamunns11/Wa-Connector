import { sendingGate } from "@/lib/billing/gate";
import { isE164, normalisePhoneE164 } from "@/lib/phone";
import type { GroupJobOutcome, GroupMemberState, WhatsappGroupJob, WhatsappGroupMember } from "@/lib/types";
import type { AddPlan, CandidateMember, GateInput, ReconcilePlan } from "@/lib/groups/types";

export type { AddPlan, CandidateMember, GateInput, ReconcilePlan } from "@/lib/groups/types";

export const GROUP_MEMBER_CAP = 256;
export const ADD_BATCH_MAX = 50;
export const CREATE_PARTICIPANTS_MAX = 5;
export const SUBJECT_MAX = 100;
export const DESCRIPTION_MAX = 2048;
export const POST_TEXT_MAX = 4096;

export const REASON_GROUPS_DISABLED = "WhatsApp groups aren't switched on for this deployment yet";
export const REASON_NOT_CONNECTED = "This number isn't connected to WhatsApp. Connect it from the dashboard first";
export const REASON_CONSENT_REQUIRED = "Tick the box to confirm these people have agreed to be in this group";
export const REASON_BATCH_TOO_LARGE = `Add up to ${ADD_BATCH_MAX} people at a time`;
export const REASON_NO_VALID_NUMBERS = "None of those numbers could be read as a phone number";
export const REASON_OPTED_OUT = "replied STOP to this number — not added";
export const REASON_INVITE_NEEDED = "their privacy settings only allow invites — invite link sent";
export const REASON_RECENTLY_LEFT = "left this group recently — WhatsApp won't let them be re-added yet";
export const REASON_ALREADY_MEMBER = "already in the group";
export const REASON_NOT_ON_WHATSAPP = "no WhatsApp account on this number";
export const REASON_GROUP_FULL = "the group is full";
export const REASON_WHATSAPP_REFUSED = "WhatsApp refused this add";
export const REASON_INTERRUPTED = "the add was interrupted — try again";
export const REASON_INVITE_SKIPPED_OPT_OUT = "replied STOP before the invite went out — not invited";

export function reasonMemberCap(brandName: string): string {
  return `A group can have up to ${GROUP_MEMBER_CAP} people in ${brandName}`;
}

/** `null` when the location may use groups, otherwise the fixed customer-facing refusal. */
export function groupGate(i: GateInput): string | null {
  if (!i.groupsEnabled) return REASON_GROUPS_DISABLED;
  const loc = i.location ?? { accountId: null, activatedAt: null };
  const gate = sendingGate(loc, i.billingStatus, i.brandName);
  if (gate) return gate;
  if (i.sessionStatus !== "connected") return REASON_NOT_CONNECTED;
  return null;
}

type Valid<T> = { ok: true; value: T } | { ok: false; reason: string };

export function validateSubject(raw: string): Valid<string> {
  const v = raw.trim();
  if (v.length < 1) return { ok: false, reason: "Give the group a name" };
  if (v.length > SUBJECT_MAX) return { ok: false, reason: `The group name can be up to ${SUBJECT_MAX} characters` };
  return { ok: true, value: v };
}

export function validateDescription(raw: string): Valid<string | null> {
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  if (v.length > DESCRIPTION_MAX) return { ok: false, reason: `The description can be up to ${DESCRIPTION_MAX} characters` };
  return { ok: true, value: v };
}

export function validatePostText(raw: string): Valid<string> {
  const v = raw.trim();
  if (v.length < 1) return { ok: false, reason: "Write a message to post" };
  if (v.length > POST_TEXT_MAX) return { ok: false, reason: `A message can be up to ${POST_TEXT_MAX} characters` };
  return { ok: true, value: v };
}

export function parsePastedNumbers(raw: string): { phone: string }[] {
  const seen = new Set<string>();
  const out: { phone: string }[] = [];
  for (const part of raw.split(/[\n\r,;]+/)) {
    const phone = normalisePhoneE164(part, "GB");
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push({ phone });
  }
  return out;
}

export function planAddMembers(i: {
  candidates: CandidateMember[];
  existingPhones: Set<string>;
  optedOutPhones: Set<string>;
  currentCount: number;
  consent: boolean;
  brandName: string;
}): AddPlan {
  const empty = (refusal: string): AddPlan => ({ toAdd: [], skippedExisting: 0, optedOut: [], refusal });
  if (!i.consent) return empty(REASON_CONSENT_REQUIRED);

  const seen = new Set<string>();
  const toAdd: CandidateMember[] = [];
  const optedOut: CandidateMember[] = [];
  let skippedExisting = 0;
  for (const c of i.candidates) {
    if (seen.has(c.phone)) continue;
    seen.add(c.phone);
    if (!isE164(c.phone)) continue;
    if (i.existingPhones.has(c.phone)) {
      skippedExisting += 1;
      continue;
    }
    if (i.optedOutPhones.has(c.phone)) optedOut.push(c);
    else toAdd.push(c);
  }

  const plan = (refusal: string | null): AddPlan => ({ toAdd, skippedExisting, optedOut, refusal });
  if (toAdd.length === 0 && optedOut.length === 0) return plan(REASON_NO_VALID_NUMBERS);
  if (toAdd.length > ADD_BATCH_MAX) return plan(REASON_BATCH_TOO_LARGE);
  if (i.currentCount + toAdd.length > GROUP_MEMBER_CAP) return plan(reasonMemberCap(i.brandName));
  return plan(null);
}

export function memberStateForOutcome(o: GroupJobOutcome): { state: GroupMemberState; reason: string | null } {
  switch (o) {
    case "added":
      return { state: "added", reason: null };
    case "invite_needed":
      return { state: "invite_needed", reason: REASON_INVITE_NEEDED };
    case "recently_left":
      return { state: "recently_left", reason: REASON_RECENTLY_LEFT };
    case "already_member":
      return { state: "already_member", reason: REASON_ALREADY_MEMBER };
    case "not_on_whatsapp":
      return { state: "not_on_whatsapp", reason: REASON_NOT_ON_WHATSAPP };
    case "group_full":
      return { state: "group_full", reason: REASON_GROUP_FULL };
    default:
      return { state: "failed", reason: REASON_WHATSAPP_REFUSED };
  }
}

export function inviteText(i: { subject: string; inviteCode: string }): string {
  return `You're invited to the WhatsApp group "${i.subject}". Tap to join: https://chat.whatsapp.com/${i.inviteCode}`;
}

export function inviteIdempotencyKey(memberId: string): string {
  return `grp-inv-${memberId}`;
}

export function reconcileJob(job: WhatsappGroupJob, members: WhatsappGroupMember[], optedOutPhones: Set<string>): ReconcilePlan {
  const pending = new Map<string, WhatsappGroupMember>();
  for (const m of members) if (m.jobId === job.id && m.state === "pending") pending.set(m.phone, m);

  const plan: ReconcilePlan = { updates: [], invites: [] };
  for (const r of job.results) {
    const m = pending.get(r.phone);
    if (!m) continue;
    pending.delete(r.phone);
    const { state, reason } = memberStateForOutcome(r.outcome);
    if (r.outcome === "invite_needed" && optedOutPhones.has(m.phone)) {
      plan.updates.push({ memberId: m.id, state: "opted_out", reason: REASON_INVITE_SKIPPED_OPT_OUT });
      continue;
    }
    plan.updates.push({ memberId: m.id, state, reason });
    if (r.outcome === "invite_needed") plan.invites.push({ memberId: m.id, phone: m.phone });
  }
  if (job.status === "interrupted") {
    for (const m of pending.values()) plan.updates.push({ memberId: m.id, state: "failed", reason: REASON_INTERRUPTED });
  }
  return plan;
}

export const REASON_NOT_FOUND = "not_found";
export const REASON_BRIDGE_UNAVAILABLE = "WhatsApp couldn't do that right now. Try again shortly";
export const REASON_ADD_CAP_REACHED = "This number has reached today's limit for adding people to groups. Try again tomorrow";
export const REASON_CREATE_CAP_REACHED = "This number has reached today's limit for creating groups. Try again tomorrow";
export const REASON_SEND_CAP_REACHED = "This number has reached today's sending limit. Try again tomorrow";
export const REASON_NOT_ADMIN = "This number isn't an admin of the group";
export const REASON_GHL_UNAVAILABLE = "GoHighLevel contacts couldn't be loaded for this sub-account. Reconnect it and try again";
export const REASON_INVALID_TOKEN = "That form has expired. Reload the page and try again";
export const GROUP_POST_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Maps a bridge failure code to a fixed customer-facing reason; never upstream text. */
export function reasonForBridgeFailure(code: string): string {
  switch (code) {
    case "session_not_connected":
      return REASON_NOT_CONNECTED;
    case "groups_disabled":
      return REASON_GROUPS_DISABLED;
    case "group_add_cap_reached":
      return REASON_ADD_CAP_REACHED;
    case "group_create_cap_reached":
      return REASON_CREATE_CAP_REACHED;
    case "daily_cap_reached":
      return REASON_SEND_CAP_REACHED;
    case "not_admin":
      return REASON_NOT_ADMIN;
    default:
      return REASON_BRIDGE_UNAVAILABLE;
  }
}
