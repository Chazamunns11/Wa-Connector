"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import {
  EMPTY_INVITEES,
  InviteePicker,
  InviteSummary,
  MANAGE_PATH,
  inviteResultFrom,
  inviteesBody,
  type CallEmbedApi,
  type InviteResult,
  type Invitees,
} from "./CreateGroupForm";

const FALLBACK_ERROR = "Something went wrong. Please try again.";
const NOT_ADMIN_MESSAGE = "This number isn't an admin of that group.";
const INPUT_CLASS = "w-full rounded border border-border bg-transparent px-3 py-2 text-sm text-ink";
const MAX_NAME = 100;
const MAX_DESCRIPTION = 512;

interface Member {
  memberId: string;
  phone: string | null;
  admin: "admin" | "superadmin" | null;
  isUs: boolean;
}

interface GroupDetail {
  jid: string;
  name: string;
  description: string | null;
  announcement: boolean;
  approval: boolean;
  weAreAdmin: boolean;
  members: Member[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : FALLBACK_ERROR;
}

function messageOf(json: Record<string, unknown>): string {
  return typeof json.message === "string" ? json.message : FALLBACK_ERROR;
}

function memberLabel(m: Member): string {
  return m.phone ? m.phone : "WhatsApp member";
}

/**
 * Manage one group this number is in: details, members, invite link, invite
 * more, leave. Everything goes through the one manage route; route messages
 * are shown verbatim. Confirmations are in-page, never `confirm()`.
 */
export function GroupManagePanel({
  slot,
  groupJid,
  groupName,
  callEmbedApi,
  onChanged,
  onLeft,
  onClose,
}: {
  slot: number;
  groupJid: string;
  groupName: string;
  callEmbedApi: CallEmbedApi;
  /** The group's name or membership may have changed: refresh the list. */
  onChanged: () => void;
  onLeft: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [nameDraft, setNameDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");

  const [link, setLink] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [invitees, setInvitees] = useState<Invitees>(EMPTY_INVITEES);
  const [directAdd, setDirectAdd] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [inviteNames, setInviteNames] = useState<Record<string, string>>({});

  /** One manage call. Resolves with the JSON on ok, else sets `error` and resolves null. */
  const run = useCallback(
    async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      try {
        const json = await callEmbedApi(MANAGE_PATH, "POST", { slot, groupJid, ...body });
        if (json.ok === true) return json;
        setError(messageOf(json));
      } catch (err) {
        setError(errorText(err));
      }
      return null;
    },
    [callEmbedApi, slot, groupJid]
  );

  /** Fetch the group's details. Pure: resolves with the detail or the error text. */
  const fetchDetail = useCallback(async (): Promise<{ detail: GroupDetail } | { error: string }> => {
    try {
      const json = await callEmbedApi(MANAGE_PATH, "POST", { slot, action: "detail", groupJid });
      const g = json.group as GroupDetail | undefined;
      if (json.ok === true && g && Array.isArray(g.members)) return { detail: g };
      return { error: messageOf(json) };
    } catch (err) {
      return { error: errorText(err) };
    }
  }, [callEmbedApi, slot, groupJid]);

  const applyDetail = useCallback((r: { detail: GroupDetail } | { error: string }) => {
    if ("detail" in r) {
      setDetail(r.detail);
      setNameDraft(r.detail.name);
      setDescDraft(r.detail.description ?? "");
      setLoadError(null);
    } else {
      setLoadError(r.error);
    }
  }, []);

  const loadDetail = useCallback(async () => applyDetail(await fetchDetail()), [applyDetail, fetchDetail]);

  useEffect(() => {
    let cancelled = false;
    void fetchDetail().then((r) => {
      if (!cancelled) applyDetail(r);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchDetail, applyDetail]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setInfo(null);
    await fn();
    setBusy(false);
  }

  const saveDetails = () =>
    act(async () => {
      if (!detail) return;
      const body: Record<string, unknown> = { action: "update" };
      if (nameDraft.trim() !== detail.name) body.name = nameDraft.trim();
      if (descDraft !== (detail.description ?? "")) body.description = descDraft;
      if (Object.keys(body).length === 1) return;
      if (await run(body)) {
        setInfo("Saved.");
        await loadDetail();
        onChanged();
      }
    });

  const setSwitch = (field: "announcement" | "approval", value: boolean) =>
    act(async () => {
      if (await run({ action: "update", [field]: value })) await loadDetail();
    });

  const changeMember = (m: Member, change: "remove" | "promote" | "demote") =>
    act(async () => {
      const json = await run({ action: "participants", change, memberIds: [m.memberId] });
      if (!json) return;
      const results = Array.isArray(json.results) ? (json.results as { result?: string; message?: string | null }[]) : [];
      const problem = results.find((r) => typeof r.message === "string");
      if (problem?.message) setError(problem.message);
      await loadDetail();
      onChanged();
    });

  const getLink = (reset: boolean) =>
    act(async () => {
      setConfirmReset(false);
      const json = await run({ action: reset ? "invite_reset" : "invite_link" });
      if (json && typeof json.link === "string") {
        setLink(json.link);
        if (reset) setInfo("The old invite link no longer works.");
      }
    });

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setError(null);
      setInfo("Link copied.");
    } catch {
      setInfo(null);
      setError("Couldn't copy automatically. Select the link and copy it.");
    }
  }

  const sendInvites = () =>
    act(async () => {
      const who = inviteesBody(invitees);
      if (!who) return;
      setInviteResult(null);
      const json = await run({ action: "invite", directAdd, ...who });
      if (!json) return;
      setInviteResult(inviteResultFrom(json));
      setInviteNames(Object.fromEntries(invitees.picked.map((p) => [p.id, p.name])));
      setInvitees(EMPTY_INVITEES);
      await loadDetail();
      onChanged();
    });

  const leave = () =>
    act(async () => {
      setConfirmLeave(false);
      if (await run({ action: "leave" })) onLeft();
    });

  const leaveBlock = (
    <div className="flex flex-col gap-2">
      {confirmLeave ? (
        <div className="flex flex-col gap-2 rounded border border-loss/30 bg-loss-soft px-2.5 py-2">
          <p className="text-xs text-ink">Leave this group? This number will stop receiving its messages.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void leave()}>
              {busy ? "Leaving…" : "Yes, leave"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmLeave(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmLeave(true)}>
            Leave group
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-xs font-semibold text-ink">Manage: {detail?.name ?? (groupName || "Unnamed group")}</h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>

      {!detail && !loadError ? <p className="text-xs text-ink-faint">Loading…</p> : null}
      {loadError ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-loss">{loadError}</p>
          <div>
            <Button size="sm" variant="secondary" onClick={() => void loadDetail()}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {detail && !detail.weAreAdmin ? (
        <>
          <p className="text-xs text-ink">{NOT_ADMIN_MESSAGE}</p>
          {leaveBlock}
        </>
      ) : null}

      {detail && detail.weAreAdmin ? (
        <>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-ink">
              Name
              <input type="text" value={nameDraft} disabled={busy} onChange={(e) => setNameDraft(e.target.value)} className={INPUT_CLASS} />
              <span className={[...nameDraft.trim()].length > MAX_NAME ? "text-loss" : "text-ink-faint"}>
                {[...nameDraft.trim()].length}/{MAX_NAME}
              </span>
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink">
              Description
              <textarea value={descDraft} rows={2} disabled={busy} onChange={(e) => setDescDraft(e.target.value)} className={INPUT_CLASS} />
              <span className={[...descDraft].length > MAX_DESCRIPTION ? "text-loss" : "text-ink-faint"}>
                {[...descDraft].length}/{MAX_DESCRIPTION}
              </span>
            </label>
            <div>
              <Button
                size="sm"
                disabled={
                  busy ||
                  [...nameDraft.trim()].length < 1 ||
                  [...nameDraft.trim()].length > MAX_NAME ||
                  [...descDraft].length > MAX_DESCRIPTION ||
                  (nameDraft.trim() === detail.name && descDraft === (detail.description ?? ""))
                }
                onClick={() => void saveDetails()}
              >
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                role="switch"
                checked={detail.announcement}
                disabled={busy}
                onChange={(e) => void setSwitch("announcement", e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Only admins can send
            </label>
            <label className="flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                role="switch"
                checked={detail.approval}
                disabled={busy}
                onChange={(e) => void setSwitch("approval", e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Approve new members
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-xs font-semibold text-ink">Members ({detail.members.length})</p>
            <ul className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto rounded border border-border">
              {detail.members.map((m) => (
                <li key={m.memberId} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-ink">{memberLabel(m)}</span>
                    {m.isUs ? <Chip tone="muted">This number</Chip> : null}
                    {m.admin ? <Chip tone="info">Admin</Chip> : null}
                  </div>
                  {!m.isUs ? (
                    <div className="flex shrink-0 gap-1">
                      {m.admin ? (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeMember(m, "demote")}>
                          Remove admin
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeMember(m, "promote")}>
                          Make admin
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeMember(m, "remove")}>
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-ink">Invite link</p>
            {link ? (
              <>
                <input type="text" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} className={INPUT_CLASS} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
                    Copy
                  </Button>
                  {!confirmReset ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
                      Reset link
                    </Button>
                  ) : null}
                </div>
                {confirmReset ? (
                  <div className="flex flex-col gap-2 rounded border border-loss/30 bg-loss-soft px-2.5 py-2">
                    <p className="text-xs text-ink">Reset the link? The current one will stop working.</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void getLink(true)}>
                        Yes, reset
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void getLink(false)}>
                  Show invite link
                </Button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-ink">Invite more</p>
            <InviteePicker slot={slot} callEmbedApi={callEmbedApi} value={invitees} onChange={setInvitees} disabled={busy} />
            <label className="flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={directAdd}
                disabled={busy}
                onChange={(e) => setDirectAdd(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Add people who&apos;ve messaged this number directly
            </label>
            <div>
              <Button size="sm" disabled={busy || inviteesBody(invitees) === null} onClick={() => void sendInvites()}>
                {busy ? "Working…" : "Invite"}
              </Button>
            </div>
            {inviteResult ? <InviteSummary result={inviteResult} names={inviteNames} /> : null}
          </div>

          {leaveBlock}
        </>
      ) : null}

      {info ? <p className="text-xs text-win">{info}</p> : null}
      {error ? <p className="text-xs text-loss">{error}</p> : null}
    </div>
  );
}
