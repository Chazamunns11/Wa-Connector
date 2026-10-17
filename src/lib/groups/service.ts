import type { GhlRepository } from "@/lib/data/repository";
import type { GhlContactLite, listGhlContacts } from "@/lib/ghl";
import { resolveGhlAccessToken, type GhlTokenRefreshDeps } from "@/lib/ghl-provider";
import { contactsByTag, searchContacts, tagsFrom } from "@/lib/groups/contacts";
import {
  CREATE_PARTICIPANTS_MAX,
  GROUP_POST_TOKEN_RE,
  REASON_GHL_UNAVAILABLE,
  REASON_INVALID_TOKEN,
  REASON_INVITE_SKIPPED_OPT_OUT,
  REASON_NOT_FOUND,
  REASON_NO_VALID_NUMBERS,
  REASON_OPTED_OUT,
  groupGate,
  inviteIdempotencyKey,
  inviteText,
  planAddMembers,
  reasonForBridgeFailure,
  reconcileJob,
  validateDescription,
  validatePostText,
  validateSubject,
} from "@/lib/groups/rules";
import type { CandidateMember } from "@/lib/groups/types";
import type {
  GroupJobOutcome,
  GroupMemberState,
  WhatsappGroup,
  WhatsappGroupJob,
  WhatsappGroupMember,
  WhatsappGroupMemberDraft,
  WhatsappGroupPost,
} from "@/lib/types";
import type {
  addWhatsappGroupParticipants,
  createWhatsappGroup,
  getWhatsappGroup,
  getWhatsappGroupJob,
  postToWhatsappGroup,
  revokeWhatsappGroupInvite,
  sendWhatsappMessage,
} from "@/lib/whatsapp-bridge";

export type GroupsRepo = Pick<
  GhlRepository,
  | "listGhlAccountsForAccount"
  | "getGhlAccountByLocationId"
  | "getAccountById"
  | "getWhatsappSessionSummary"
  | "isOptedOut"
  | "createWhatsappGroup"
  | "getWhatsappGroup"
  | "listWhatsappGroupsForAccount"
  | "updateWhatsappGroup"
  | "insertWhatsappGroupMembers"
  | "listWhatsappGroupMembers"
  | "updateWhatsappGroupMember"
  | "listPendingGroupJobIds"
  | "getWhatsappGroupJob"
  | "listWhatsappGroupPosts"
  | "claimGhlTokenRefresh"
  | "saveGhlTokens"
  | "markGhlNeedsReauth"
>;

export interface GroupsDeps {
  groupsEnabled: boolean;
  brandName: string;
  now: () => Date;
  bridge: {
    createGroup: typeof createWhatsappGroup;
    addParticipants: typeof addWhatsappGroupParticipants;
    getJob: typeof getWhatsappGroupJob;
    post: typeof postToWhatsappGroup;
    getGroup: typeof getWhatsappGroup;
    revokeInvite: typeof revokeWhatsappGroupInvite;
    sendText: typeof sendWhatsappMessage;
  };
  ghl: { listContacts: typeof listGhlContacts; token: GhlTokenRefreshDeps };
  /** Fixed-shape counts only: never a subject, phone or name. */
  notify: (text: string) => void;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; reason: string };
type Session = { accountId: string; profileId: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const NOT_FOUND = fail(REASON_NOT_FOUND);

/** Fixed reason for a gate that fails before any location is known. */
async function gateForLocation(repo: GroupsRepo, deps: GroupsDeps, accountId: string, locationId: string): Promise<string | null> {
  const owned = await repo.listGhlAccountsForAccount(accountId);
  const loc = owned.find((a) => a.locationId === locationId);
  const account = loc ? await repo.getAccountById(accountId) : null;
  const summary = loc ? await repo.getWhatsappSessionSummary(loc.tenantId) : null;
  return groupGate({
    groupsEnabled: deps.groupsEnabled,
    location: loc ? { accountId: loc.accountId, activatedAt: loc.activatedAt } : null,
    billingStatus: account?.billingStatus ?? null,
    sessionStatus: summary?.status ?? null,
    brandName: deps.brandName,
  });
}

/** Ownership first: the group row decides tenant and location, never the input. */
async function loadOwnedGroup(repo: GroupsRepo, session: Session, groupId: string): Promise<WhatsappGroup | null> {
  const group = await repo.getWhatsappGroup(groupId);
  return group && group.accountId === session.accountId ? group : null;
}

async function optedOutSet(repo: GroupsRepo, tenantId: string, phones: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of phones) if (await repo.isOptedOut(tenantId, p)) out.add(p);
  return out;
}

function draftFor(
  groupId: string,
  c: CandidateMember,
  state: GroupMemberState,
  jobId: string | null,
  reason: string | null,
  session: Session,
  consentAt: string,
): WhatsappGroupMemberDraft {
  return {
    groupId,
    phone: c.phone,
    ghlContactId: c.ghlContactId,
    displayName: c.displayName,
    state,
    jobId,
    consentConfirmedAt: consentAt,
    addedByProfileId: session.profileId,
    lastReason: reason,
  };
}

/**
 * One invite text per `invite_needed` member through the normal 1:1 pipeline.
 * STOP is re-checked here, the billing/connection gate is honoured, and the
 * idempotency key is stable per member so a replay never sends twice.
 */
async function sendInvites(repo: GroupsRepo, deps: GroupsDeps, group: WhatsappGroup, gate: string | null): Promise<number> {
  if (gate || !group.inviteCode) return 0;
  const members = await repo.listWhatsappGroupMembers(group.id);
  let sent = 0;
  for (const m of members) {
    if (m.state !== "invite_needed") continue;
    if (await repo.isOptedOut(group.tenantId, m.phone)) {
      await repo.updateWhatsappGroupMember(m.id, { state: "opted_out", lastReason: REASON_INVITE_SKIPPED_OPT_OUT });
      continue;
    }
    const key = inviteIdempotencyKey(m.id);
    const r = await deps.bridge.sendText({
      coachId: group.tenantId,
      to: m.phone,
      text: inviteText({ subject: group.subject, inviteCode: group.inviteCode }),
      idempotencyKey: key,
    });
    if (r.ok) {
      await repo.updateWhatsappGroupMember(m.id, { state: "invite_sent", lastReason: m.lastReason, inviteIdempotencyKey: key });
      sent += 1;
    } else if (r.code === "session_not_connected" || r.code === "daily_cap_reached" || r.code === "lease_unavailable") {
      break;
    }
  }
  return sent;
}

/** Queue an add job with the bridge and record the people as `pending` against it; failures are recorded honestly as `failed`. */
async function queueAdds(
  repo: GroupsRepo,
  deps: GroupsDeps,
  session: Session,
  group: WhatsappGroup,
  plan: { toAdd: CandidateMember[]; optedOut: CandidateMember[] },
): Promise<string | null> {
  const consentAt = deps.now().toISOString();
  const drafts: WhatsappGroupMemberDraft[] = plan.optedOut.map((c) =>
    draftFor(group.id, c, "opted_out", null, REASON_OPTED_OUT, session, consentAt),
  );
  let failure: string | null = null;
  if (plan.toAdd.length > 0) {
    const r = await deps.bridge.addParticipants(group.tenantId, group.waGroupJid, plan.toAdd.map((c) => c.phone));
    if (r.ok) {
      for (const c of plan.toAdd) drafts.push(draftFor(group.id, c, "pending", r.job.id, null, session, consentAt));
    } else {
      failure = reasonForBridgeFailure(r.code);
      for (const c of plan.toAdd) drafts.push(draftFor(group.id, c, "failed", null, failure, session, consentAt));
    }
  }
  if (drafts.length > 0) await repo.insertWhatsappGroupMembers(drafts);
  return failure;
}

export async function createGroup(
  repo: GroupsRepo,
  deps: GroupsDeps,
  session: Session,
  input: {
    locationId: string;
    subject: string;
    description: string;
    announceOnly: boolean;
    adminAddOnly: boolean;
    candidates: CandidateMember[];
    consent: boolean;
  },
): Promise<ServiceResult<{ groupId: string }>> {
  const owned = await repo.listGhlAccountsForAccount(session.accountId);
  const loc = owned.find((a) => a.locationId === input.locationId);
  if (!loc) return NOT_FOUND;
  const gate = await gateForLocation(repo, deps, session.accountId, loc.locationId);
  if (gate) return fail(gate);

  const subject = validateSubject(input.subject);
  if (!subject.ok) return fail(subject.reason);
  const description = validateDescription(input.description);
  if (!description.ok) return fail(description.reason);

  const optedOut = await optedOutSet(repo, loc.tenantId, input.candidates.map((c) => c.phone));
  const plan = planAddMembers({
    candidates: input.candidates,
    existingPhones: new Set(),
    optedOutPhones: optedOut,
    currentCount: 1,
    consent: input.consent,
    brandName: deps.brandName,
  });
  if (plan.refusal) return fail(plan.refusal);
  // WhatsApp needs at least one real participant to create a group.
  if (plan.toAdd.length === 0) return fail(REASON_NO_VALID_NUMBERS);

  const first = plan.toAdd.slice(0, CREATE_PARTICIPANTS_MAX);
  const rest = plan.toAdd.slice(CREATE_PARTICIPANTS_MAX);
  const created = await deps.bridge.createGroup(loc.tenantId, {
    subject: subject.value,
    ...(description.value ? { description: description.value } : {}),
    participants: first.map((c) => c.phone),
    announceOnly: input.announceOnly,
    adminAddOnly: input.adminAddOnly,
  });
  if (!created.ok) return fail(reasonForBridgeFailure(created.code));

  const consentAt = deps.now().toISOString();
  const group = await repo.createWhatsappGroup({
    tenantId: loc.tenantId,
    locationId: loc.locationId,
    accountId: session.accountId,
    waGroupJid: created.group.jid,
    subject: subject.value,
    description: description.value,
    inviteCode: created.group.inviteCode,
    announceOnly: input.announceOnly,
    adminAddOnly: input.adminAddOnly,
    participantCount: created.group.participantCount,
    weAreAdmin: created.group.weAreAdmin,
    createdByProfileId: session.profileId,
  });

  // The create response is applied exactly like a finished add job.
  const batchId = crypto.randomUUID();
  const inserted = await repo.insertWhatsappGroupMembers([
    ...first.map((c) => draftFor(group.id, c, "pending", batchId, null, session, consentAt)),
    ...plan.optedOut.map((c) => draftFor(group.id, c, "opted_out", null, REASON_OPTED_OUT, session, consentAt)),
  ]);
  const byPhone = new Map(created.results.map((r) => [r.phone, r.outcome]));
  const syntheticJob: WhatsappGroupJob = {
    id: batchId,
    coachId: loc.tenantId,
    groupJid: created.group.jid,
    status: "done",
    requestedCount: first.length,
    results: first.map((c) => {
      const outcome: GroupJobOutcome = byPhone.get(c.phone) ?? "failed";
      return { phone: c.phone, code: "", outcome };
    }),
    createdAt: consentAt,
    finishedAt: consentAt,
  };
  const reconciled = reconcileJob(syntheticJob, inserted, optedOut);
  for (const u of reconciled.updates) await repo.updateWhatsappGroupMember(u.memberId, { state: u.state, lastReason: u.reason });

  if (rest.length > 0) await queueAdds(repo, deps, session, group, { toAdd: rest, optedOut: [] });

  const invites = await sendInvites(repo, deps, group, null);
  deps.notify(`[groups] created: 1 group, ${plan.toAdd.length} members, ${invites} invites`);
  return ok({ groupId: group.id });
}

export async function addMembers(
  repo: GroupsRepo,
  deps: GroupsDeps,
  session: Session,
  input: { groupId: string; candidates: CandidateMember[]; consent: boolean },
): Promise<ServiceResult<{ queued: number; optedOut: number; skippedExisting: number }>> {
  const group = await loadOwnedGroup(repo, session, input.groupId);
  if (!group) return NOT_FOUND;
  const gate = await gateForLocation(repo, deps, session.accountId, group.locationId);
  if (gate) return fail(gate);

  const members = await repo.listWhatsappGroupMembers(group.id);
  const existing = new Set(members.map((m) => m.phone));
  const optedOut = await optedOutSet(
    repo,
    group.tenantId,
    input.candidates.map((c) => c.phone).filter((p) => !existing.has(p)),
  );
  const plan = planAddMembers({
    candidates: input.candidates,
    existingPhones: existing,
    optedOutPhones: optedOut,
    currentCount: Math.max(group.participantCount, members.length + 1),
    consent: input.consent,
    brandName: deps.brandName,
  });
  if (plan.refusal) return fail(plan.refusal);

  const failure = await queueAdds(repo, deps, session, group, plan);
  if (failure) return fail(failure);
  return ok({ queued: plan.toAdd.length, optedOut: plan.optedOut.length, skippedExisting: plan.skippedExisting });
}

export async function postToGroup(
  repo: GroupsRepo,
  deps: GroupsDeps,
  session: Session,
  input: { groupId: string; text: string; token: string },
): Promise<ServiceResult<{ replay: boolean }>> {
  const group = await loadOwnedGroup(repo, session, input.groupId);
  if (!group) return NOT_FOUND;
  const gate = await gateForLocation(repo, deps, session.accountId, group.locationId);
  if (gate) return fail(gate);
  if (!GROUP_POST_TOKEN_RE.test(input.token)) return fail(REASON_INVALID_TOKEN);
  const text = validatePostText(input.text);
  if (!text.ok) return fail(text.reason);

  const r = await deps.bridge.post(group.tenantId, group.waGroupJid, text.value, `grp-post-${input.token}`);
  if (!r.ok) return fail(reasonForBridgeFailure(r.code));
  return ok({ replay: r.replay });
}

export async function refreshGroup(repo: GroupsRepo, deps: GroupsDeps, session: Session, groupId: string): Promise<ServiceResult<void>> {
  const group = await loadOwnedGroup(repo, session, groupId);
  if (!group) return NOT_FOUND;
  if (!deps.groupsEnabled) return fail(reasonForBridgeFailure("groups_disabled"));
  const r = await deps.bridge.getGroup(group.tenantId, group.waGroupJid);
  if (!r.ok) return fail(reasonForBridgeFailure(r.code));
  await repo.updateWhatsappGroup(group.id, {
    participantCount: r.group.participantCount,
    weAreAdmin: r.group.weAreAdmin,
    inviteCode: r.group.inviteCode,
  });
  return ok(undefined);
}

export async function rotateInviteLink(
  repo: GroupsRepo,
  deps: GroupsDeps,
  session: Session,
  groupId: string,
): Promise<ServiceResult<{ inviteCode: string }>> {
  const group = await loadOwnedGroup(repo, session, groupId);
  if (!group) return NOT_FOUND;
  const gate = await gateForLocation(repo, deps, session.accountId, group.locationId);
  if (gate) return fail(gate);
  const r = await deps.bridge.revokeInvite(group.tenantId, group.waGroupJid);
  if (!r.ok) return fail(reasonForBridgeFailure(r.code));
  await repo.updateWhatsappGroup(group.id, { inviteCode: r.inviteCode });
  return ok({ inviteCode: r.inviteCode });
}

/**
 * Applies finished bridge add jobs to member rows (a database read, no bridge
 * call), then sends the invite texts. Safe to run repeatedly: members past
 * `pending` are never touched and each invite has a stable idempotency key.
 */
export async function reconcileGroupJobs(
  repo: GroupsRepo,
  deps: GroupsDeps,
  accountId: string,
): Promise<{ jobs: number; invitesSent: number }> {
  const result = { jobs: 0, invitesSent: 0 };
  if (!deps.groupsEnabled) return result;

  for (const { jobId, groupId } of await repo.listPendingGroupJobIds(accountId)) {
    const group = await repo.getWhatsappGroup(groupId);
    if (!group || group.accountId !== accountId) continue;
    const job = await repo.getWhatsappGroupJob(jobId);
    if (!job || (job.status !== "done" && job.status !== "interrupted")) continue;
    const members = await repo.listWhatsappGroupMembers(group.id);
    const pendingPhones = members.filter((m) => m.jobId === jobId && m.state === "pending").map((m) => m.phone);
    const plan = reconcileJob(job, members, await optedOutSet(repo, group.tenantId, pendingPhones));
    for (const u of plan.updates) await repo.updateWhatsappGroupMember(u.memberId, { state: u.state, lastReason: u.reason });
    result.jobs += 1;
  }

  // Includes members left `invite_needed` by an earlier pass that could not send.
  for (const group of await repo.listWhatsappGroupsForAccount(accountId)) {
    const gate = await gateForLocation(repo, deps, accountId, group.locationId);
    result.invitesSent += await sendInvites(repo, deps, group, gate);
  }
  return result;
}

export async function loadGroupView(
  repo: GroupsRepo,
  deps: GroupsDeps,
  session: Session,
  groupId: string,
): Promise<{
  group: WhatsappGroup;
  members: WhatsappGroupMember[];
  posts: WhatsappGroupPost[];
  locationName: string;
  gateReason: string | null;
} | null> {
  const group = await loadOwnedGroup(repo, session, groupId);
  if (!group) return null;
  const owned = await repo.listGhlAccountsForAccount(session.accountId);
  return {
    group,
    members: await repo.listWhatsappGroupMembers(group.id),
    posts: await repo.listWhatsappGroupPosts(group.tenantId, group.waGroupJid, 20),
    locationName: owned.find((a) => a.locationId === group.locationId)?.label ?? "",
    gateReason: await gateForLocation(repo, deps, session.accountId, group.locationId),
  };
}

export async function contactPickerData(
  repo: GroupsRepo,
  deps: GroupsDeps,
  session: Session,
  locationId: string,
  q: { query?: string; tag?: string },
): Promise<{ contacts: GhlContactLite[]; tags: string[]; truncated: boolean } | { error: string }> {
  if (!deps.groupsEnabled) return { error: reasonForBridgeFailure("groups_disabled") };
  const owned = await repo.listGhlAccountsForAccount(session.accountId);
  if (!owned.some((a) => a.locationId === locationId)) return { error: REASON_NOT_FOUND };
  const account = await repo.getGhlAccountByLocationId(locationId);
  const token = account ? await resolveGhlAccessToken(repo, deps.ghl.token, account) : null;
  if (!token) return { error: REASON_GHL_UNAVAILABLE };

  const firstPage = await deps.ghl.listContacts(token, locationId, {});
  if (!firstPage.ok) return { error: REASON_GHL_UNAVAILABLE };
  const tags = new Set(tagsFrom(firstPage.contacts));

  let contacts: GhlContactLite[] = [];
  let truncated = false;
  if (q.tag?.trim()) {
    const r = await contactsByTag(deps.ghl.listContacts, token, locationId, q.tag);
    contacts = r.contacts;
    truncated = r.truncated;
    for (const t of tagsFrom(contacts)) tags.add(t);
  } else if (q.query?.trim()) {
    contacts = await searchContacts(deps.ghl.listContacts, token, locationId, q.query);
  }
  return {
    contacts: contacts.filter((c) => c.phone),
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
    truncated,
  };
}
