import { normalisePhoneE164 } from "@/lib/phone";
import {
  REASON_ADD_CAP_REACHED,
  REASON_BATCH_TOO_LARGE,
  REASON_BRIDGE_UNAVAILABLE,
  REASON_CONSENT_REQUIRED,
  REASON_CREATE_CAP_REACHED,
  REASON_GHL_UNAVAILABLE,
  REASON_GROUPS_DISABLED,
  REASON_INVALID_TOKEN,
  REASON_NOT_ADMIN,
  REASON_NOT_CONNECTED,
  REASON_NO_VALID_NUMBERS,
  REASON_SEND_CAP_REACHED,
  DESCRIPTION_MAX,
  POST_TEXT_MAX,
  SUBJECT_MAX,
  parsePastedNumbers,
  validateDescription,
  validatePostText,
  validateSubject,
  reasonMemberCap,
} from "@/lib/groups/rules";
import type { CandidateMember } from "@/lib/groups/types";
import { SITE_ROUTES, groupPath } from "@/lib/site/routes";

/** Pure form helpers for the groups actions. No Next imports (a "use server" file may only export async functions). */

/** Merges `contact` lines (`id|phone|name`) and the `pasted` textarea; a contact wins over a pasted number. */
export function parseCandidates(formData: FormData): CandidateMember[] {
  const byPhone = new Map<string, CandidateMember>();
  for (const raw of formData.getAll("contact")) {
    if (typeof raw !== "string") continue;
    const [id = "", rawPhone = "", ...nameParts] = raw.split("|");
    const phone = normalisePhoneE164(rawPhone, "GB");
    if (!phone) continue;
    const name = nameParts.join("|").trim();
    byPhone.set(phone, { phone, ghlContactId: id.trim() || null, displayName: name ? name.slice(0, 120) : null });
  }
  const pasted = formData.get("pasted");
  if (typeof pasted === "string") {
    for (const { phone } of parsePastedNumbers(pasted)) {
      if (!byPhone.has(phone)) byPhone.set(phone, { phone, ghlContactId: null, displayName: null });
    }
  }
  return [...byPhone.values()];
}

export const GROUP_RESULT_COPY = {
  created: "Group created. Share the invite link below.",
  added: "Those people are being added. This page updates as WhatsApp answers.",
  posted: "Message queued. It goes out at this number's normal sending pace.",
  refreshed: "Refreshed from WhatsApp.",
  link_rotated: "New invite link ready. The old one no longer works.",
  consent_required: REASON_CONSENT_REQUIRED,
  batch_too_large: REASON_BATCH_TOO_LARGE,
  no_numbers: REASON_NO_VALID_NUMBERS,
  not_connected: REASON_NOT_CONNECTED,
  groups_disabled: REASON_GROUPS_DISABLED,
  add_cap: REASON_ADD_CAP_REACHED,
  create_cap: REASON_CREATE_CAP_REACHED,
  send_cap: REASON_SEND_CAP_REACHED,
  not_admin: REASON_NOT_ADMIN,
  ghl_unavailable: REASON_GHL_UNAVAILABLE,
  expired_form: REASON_INVALID_TOKEN,
  bridge_unavailable: REASON_BRIDGE_UNAVAILABLE,
  member_cap: "That would put the group over its size limit",
  not_found: "We couldn't find that group or number.",
  invalid_input: "Check the group name, description or message. One of them is empty or too long.",
  refused: "That didn't go through. Check the notes on this page, then try again.",
} as const;

export type GroupResult = keyof typeof GROUP_RESULT_COPY;
const SUCCESS: readonly GroupResult[] = ["created", "added", "posted", "refreshed", "link_rotated"];

export function isSuccessResult(r: GroupResult): boolean {
  return SUCCESS.includes(r);
}

export function parseGroupResult(v: string | string[] | undefined): GroupResult | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && Object.hasOwn(GROUP_RESULT_COPY, s) ? (s as GroupResult) : null;
}

const reasonOf = (v: { ok: boolean; reason?: string }): string => v.reason ?? "";
const VALIDATION_REASONS = new Set([
  reasonOf(validateSubject("")),
  reasonOf(validateSubject("x".repeat(SUBJECT_MAX + 1))),
  reasonOf(validateDescription("x".repeat(DESCRIPTION_MAX + 1))),
  reasonOf(validatePostText("")),
  reasonOf(validatePostText("x".repeat(POST_TEXT_MAX + 1))),
]);

/** Turns a service refusal (a fixed constant) into a URL-safe code. Anything unrecognised is "refused". */
export function resultForReason(reason: string, brandName: string): GroupResult {
  if (reason === reasonMemberCap(brandName)) return "member_cap";
  if (VALIDATION_REASONS.has(reason)) return "invalid_input";
  const exact: [string, GroupResult][] = [
    [REASON_CONSENT_REQUIRED, "consent_required"],
    [REASON_BATCH_TOO_LARGE, "batch_too_large"],
    [REASON_NO_VALID_NUMBERS, "no_numbers"],
    [REASON_NOT_CONNECTED, "not_connected"],
    [REASON_GROUPS_DISABLED, "groups_disabled"],
    [REASON_ADD_CAP_REACHED, "add_cap"],
    [REASON_CREATE_CAP_REACHED, "create_cap"],
    [REASON_SEND_CAP_REACHED, "send_cap"],
    [REASON_NOT_ADMIN, "not_admin"],
    [REASON_GHL_UNAVAILABLE, "ghl_unavailable"],
    [REASON_INVALID_TOKEN, "expired_form"],
    [REASON_BRIDGE_UNAVAILABLE, "bridge_unavailable"],
    ["not_found", "not_found"],
  ];
  return exact.find(([r]) => r === reason)?.[1] ?? "refused";
}

export function groupHref(id: string, opts: { result?: GroupResult } = {}): string {
  return `${groupPath(id)}${opts.result ? `?result=${opts.result}` : ""}`;
}

export function newGroupHref(result?: GroupResult): string {
  return `${SITE_ROUTES.newGroup}${result ? `?error=${result}` : ""}`;
}
