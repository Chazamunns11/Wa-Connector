"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAccountSession } from "@/lib/account-session";
import { repo } from "@/lib/data";
import { groupHref, newGroupHref, parseCandidates, resultForReason, type GroupResult } from "@/lib/groups/forms";
import {
  addMembers,
  contactPickerData,
  createGroup,
  postToGroup,
  refreshGroup,
  rotateInviteLink,
} from "@/lib/groups/service";
import { SITE_ROUTES } from "@/lib/site/routes";
import { groupsDeps } from "./deps";

/**
 * Server Actions are public POST endpoints: each one re-reads the session and
 * hands the service only ids; the service re-checks the account owns the
 * number or group. Nothing here trusts a hidden field for authority.
 */

const text = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};
const on = (f: FormData, k: string): boolean => f.get(k) === "on";

export async function createGroupAction(formData: FormData): Promise<void> {
  const session = await requireAccountSession();
  const deps = groupsDeps();
  const r = await createGroup(repo, deps, session, {
    locationId: text(formData, "location"),
    subject: text(formData, "subject"),
    description: text(formData, "description"),
    announceOnly: on(formData, "announceOnly"),
    adminAddOnly: on(formData, "adminAddOnly"),
    candidates: parseCandidates(formData),
    consent: on(formData, "consent"),
  });
  if (!r.ok) redirect(newGroupHref(resultForReason(r.reason, deps.brandName)));
  revalidatePath(SITE_ROUTES.groups);
  redirect(groupHref(r.value.groupId, { result: "created" }));
}

async function finish(groupId: string, outcome: { ok: true } | { ok: false; reason: string }, done: GroupResult, brand: string): Promise<never> {
  if (!outcome.ok) redirect(groupHref(groupId, { result: resultForReason(outcome.reason, brand) }));
  revalidatePath(groupHref(groupId));
  redirect(groupHref(groupId, { result: done }));
}

export async function addMembersAction(formData: FormData): Promise<void> {
  const session = await requireAccountSession();
  const deps = groupsDeps();
  const groupId = text(formData, "group");
  const r = await addMembers(repo, deps, session, {
    groupId,
    candidates: parseCandidates(formData),
    consent: on(formData, "consent"),
  });
  return finish(groupId, r.ok ? { ok: true } : r, "added", deps.brandName);
}

export async function postToGroupAction(formData: FormData): Promise<void> {
  const session = await requireAccountSession();
  const deps = groupsDeps();
  const groupId = text(formData, "group");
  const r = await postToGroup(repo, deps, session, { groupId, text: text(formData, "text"), token: text(formData, "token") });
  return finish(groupId, r.ok ? { ok: true } : r, "posted", deps.brandName);
}

export async function refreshGroupAction(formData: FormData): Promise<void> {
  const session = await requireAccountSession();
  const deps = groupsDeps();
  const groupId = text(formData, "group");
  const r = await refreshGroup(repo, deps, session, groupId);
  return finish(groupId, r.ok ? { ok: true } : r, "refreshed", deps.brandName);
}

export async function rotateInviteAction(formData: FormData): Promise<void> {
  const session = await requireAccountSession();
  const deps = groupsDeps();
  const groupId = text(formData, "group");
  const r = await rotateInviteLink(repo, deps, session, groupId);
  return finish(groupId, r.ok ? { ok: true } : r, "link_rotated", deps.brandName);
}

/** Called from the client MemberPicker. Ownership of `locationId` is re-checked in the service. */
export async function searchContactsAction(
  locationId: string,
  query: string,
  tag: string,
): Promise<Awaited<ReturnType<typeof contactPickerData>>> {
  const session = await requireAccountSession();
  if (typeof locationId !== "string" || typeof query !== "string" || typeof tag !== "string") return { error: "not_found" };
  return contactPickerData(repo, groupsDeps(), session, locationId, { query, tag });
}
