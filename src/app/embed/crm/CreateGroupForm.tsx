"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";

/** The embed's authenticated call helper, as `CrmEmbedClient` passes it down. */
export type CallEmbedApi = (path: string, method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const MANAGE_PATH = "/api/crm/embed/groups/manage";
const TEMPLATE_PATH = "/api/crm/embed/groups/invite-template";

const MAX_NAME = 100;
const MAX_DESCRIPTION = 512;
const MAX_TEMPLATE = 500;
const MAX_INVITEES = 100;

const FALLBACK_ERROR = "Something went wrong. Please try again.";
const INPUT_CLASS = "w-full rounded border border-border bg-transparent px-3 py-2 text-sm text-ink";

/** Characters as WhatsApp and Postgres count them (code points), matching the server's limits. */
function charCount(s: string): number {
  return [...s].length;
}

/** A fresh idempotency key for one deliberate create attempt (8-64 chars of [A-Za-z0-9_-]). */
function newRequestId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : FALLBACK_ERROR;
}

function messageOf(json: Record<string, unknown>): string {
  return typeof json.message === "string" ? json.message : FALLBACK_ERROR;
}

// ---------------------------------------------------------------------------
// Invitees: pick contacts, or everyone with a tag.
// ---------------------------------------------------------------------------

interface ContactResult {
  id: string;
  name: string | null;
  hasPhone: boolean;
  canAddDirectly: boolean;
}

export interface Invitees {
  mode: "pick" | "tag";
  picked: { id: string; name: string }[];
  tag: string;
}

export const EMPTY_INVITEES: Invitees = { mode: "pick", picked: [], tag: "" };

/** The request fields for these invitees, or `null` when nobody is chosen yet. */
export function inviteesBody(v: Invitees): { contactIds: string[] } | { tag: string } | null {
  if (v.mode === "tag") return v.tag.trim() ? { tag: v.tag.trim() } : null;
  return v.picked.length > 0 ? { contactIds: v.picked.map((c) => c.id) } : null;
}

export function InviteePicker({
  slot,
  callEmbedApi,
  value,
  onChange,
  disabled,
}: {
  slot: number;
  callEmbedApi: CallEmbedApi;
  value: Invitees;
  onChange: (next: Invitees) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<ContactResult[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const json = await callEmbedApi(MANAGE_PATH, "POST", { slot, action: "search_contacts", text: text.trim() });
      if (json.ok === true && Array.isArray(json.contacts)) {
        setResults(json.contacts as ContactResult[]);
        setTruncated(json.truncated === true);
      } else {
        setError(messageOf(json));
      }
    } catch (err) {
      setError(errorText(err));
    }
    setSearching(false);
  }

  function pick(c: ContactResult) {
    if (value.picked.some((p) => p.id === c.id) || value.picked.length >= MAX_INVITEES) return;
    onChange({ ...value, picked: [...value.picked, { id: c.id, name: c.name?.trim() || "Unnamed contact" }] });
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Who to invite" className="flex flex-wrap gap-3 text-xs text-ink">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={`invitee-mode-${slot}`}
            checked={value.mode === "pick"}
            disabled={disabled}
            onChange={() => onChange({ ...value, mode: "pick" })}
            className="accent-[var(--color-accent)]"
          />
          Pick contacts
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={`invitee-mode-${slot}`}
            checked={value.mode === "tag"}
            disabled={disabled}
            onChange={() => onChange({ ...value, mode: "tag" })}
            className="accent-[var(--color-accent)]"
          />
          Everyone with tag
        </label>
      </div>

      {value.mode === "tag" ? (
        <input
          type="text"
          value={value.tag}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, tag: e.target.value })}
          aria-label="Tag"
          placeholder="Tag, e.g. spring-cohort"
          className={INPUT_CLASS}
        />
      ) : (
        <>
          <div className="flex gap-2">
            <input
              type="text"
              value={text}
              maxLength={100}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!searching) void search();
                }
              }}
              aria-label="Search contacts"
              placeholder="Search contacts by name"
              className={`${INPUT_CLASS} min-w-0 flex-1`}
            />
            <Button size="sm" variant="secondary" disabled={disabled || searching} onClick={() => void search()}>
              {searching ? "Searching…" : "Search"}
            </Button>
          </div>
          {error ? <p className="text-xs text-loss">{error}</p> : null}
          {results !== null && results.length === 0 ? <p className="text-xs text-ink-faint">No contacts found.</p> : null}
          {results !== null && results.length > 0 ? (
            <ul className="flex max-h-48 flex-col divide-y divide-border overflow-y-auto rounded border border-border">
              {results.map((c) => {
                const chosen = value.picked.some((p) => p.id === c.id);
                return (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">{c.name?.trim() || "Unnamed contact"}</p>
                      {!c.hasPhone ? <p className="text-xs text-ink-faint">No phone number</p> : null}
                    </div>
                    <Button size="sm" variant="ghost" disabled={disabled || chosen || !c.hasPhone} onClick={() => pick(c)}>
                      {chosen ? "Added" : "Add"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {truncated ? <p className="text-xs text-ink-faint">Showing the first matches. Type more of the name to narrow it down.</p> : null}
          {value.picked.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Chosen contacts">
              {value.picked.map((p) => (
                <li key={p.id} className="inline-flex items-center gap-1 rounded border border-border bg-raised px-2 py-1 text-xs text-ink">
                  {p.name}
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove ${p.name}`}
                    onClick={() => onChange({ ...value, picked: value.picked.filter((x) => x.id !== p.id) })}
                    className="text-ink-faint hover:text-ink"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-ink-faint">
            {value.picked.length} of {MAX_INVITEES} chosen
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite results.
// ---------------------------------------------------------------------------

export interface InviteResult {
  added: string[];
  alreadyMember: string[];
  sent: string[];
  held: string[];
  refused: { contactId: string; reason: string }[];
  skipped: { contactId: string; name: string | null; reason: string }[];
  truncated: boolean;
}

const SKIP_REASONS: Record<string, string> = {
  no_phone: "has no phone number in HighLevel.",
  group_contact: "is a WhatsApp group contact, not a person.",
  duplicate_phone: "shares a phone number with someone already in this list.",
  opted_out: "has opted out of messages.",
  not_found: "wasn't found in HighLevel.",
};

const EMPTY_RESULT: InviteResult = { added: [], alreadyMember: [], sent: [], held: [], refused: [], skipped: [], truncated: false };

function isInviteResult(x: unknown): x is InviteResult {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return ["added", "alreadyMember", "sent", "held", "refused", "skipped"].every((k) => Array.isArray(r[k]));
}

export function inviteResultFrom(json: Record<string, unknown>): InviteResult | null {
  return isInviteResult(json.invites) ? json.invites : null;
}

export function InviteSummary({ result, names }: { result: InviteResult; names: Record<string, string> }) {
  const who = (id: string, name?: string | null) => name?.trim() || names[id] || "A contact";
  const lines: string[] = [];
  if (result.added.length > 0) lines.push(`${result.added.length} added to the group.`);
  if (result.alreadyMember.length > 0) lines.push(`${result.alreadyMember.length} already in the group.`);
  if (result.sent.length > 0) lines.push(`${result.sent.length} sent an invite link.`);
  if (result.held.length > 0) lines.push(`${result.held.length} will send when the number reconnects.`);
  return (
    <div className="flex flex-col gap-1 rounded border border-border px-2.5 py-2 text-xs text-ink" role="status">
      {lines.length === 0 && result.refused.length === 0 && result.skipped.length === 0 ? <p>Nobody was invited.</p> : null}
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {result.refused.map((r) => (
        <p key={`r-${r.contactId}`} className="text-loss">
          {who(r.contactId)} wasn&apos;t invited: {r.reason}
        </p>
      ))}
      {result.skipped.map((s) => (
        <p key={`s-${s.contactId}`} className="text-ink-faint">
          {who(s.contactId, s.name)} was skipped because they {SKIP_REASONS[s.reason] ?? "couldn't be invited."}
        </p>
      ))}
      {result.truncated ? <p className="text-ink-faint">Some contacts weren&apos;t included because the list was too long.</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite message template (per sub-account).
// ---------------------------------------------------------------------------

function InviteTemplateEditor({ callEmbedApi }: { callEmbedApi: CallEmbedApi }) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const json = await callEmbedApi(TEMPLATE_PATH, "POST", body);
      if (json.ok === true && typeof json.template === "string") {
        setTemplate(json.template);
        setIsDefault(json.isDefault === true);
        setSaved("template" in body);
      } else {
        setError(messageOf(json));
      }
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && template === null && !busy) void call({});
          }}
        >
          {open ? "Hide invite message" : "Edit invite message"}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-2">
          {template === null ? (
            error ? null : <p className="text-xs text-ink-faint">Loading…</p>
          ) : (
            <>
              <textarea
                value={template}
                rows={3}
                disabled={busy}
                onChange={(e) => {
                  setTemplate(e.target.value);
                  setSaved(false);
                }}
                aria-label="Invite message"
                className={INPUT_CLASS}
              />
              <p className="text-xs text-ink-faint">
                Use {"{link}"} (required), {"{first_name}"}, {"{group_name}"} and {"{coach_name}"}. Applies to this sub-account.
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs ${charCount(template) > MAX_TEMPLATE ? "text-loss" : "text-ink-faint"}`}>
                  {charCount(template)}/{MAX_TEMPLATE}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || charCount(template) > MAX_TEMPLATE} onClick={() => void call({ template })}>
                    {busy ? "Saving…" : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy || isDefault} onClick={() => void call({ template: null })}>
                    Reset
                  </Button>
                </div>
              </div>
              {saved ? <p className="text-xs text-win">Saved.</p> : null}
            </>
          )}
          {error ? <p className="text-xs text-loss">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The create form.
// ---------------------------------------------------------------------------

const REPLAYED_MESSAGE = "This group was already created. Use Invite more to add anyone who was missed.";
const MAY_EXIST_SUFFIX = "Check the group list before trying again.";

/**
 * Create a WhatsApp group on one number. One `requestId` per open form: a
 * network-level failure keeps it (so a second press can't make a second
 * group); a 502 `mayExist` mints a fresh one for the next deliberate attempt.
 */
export function CreateGroupForm({
  slot,
  callEmbedApi,
  onCreated,
  onClose,
}: {
  slot: number;
  callEmbedApi: CallEmbedApi;
  /** Called after a create attempt that may have changed the list, so the caller refreshes it. */
  onCreated: () => void;
  onClose: () => void;
}) {
  const requestId = useRef<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [invitees, setInvitees] = useState<Invitees>(EMPTY_INVITEES);
  const [directAdd, setDirectAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; invites: InviteResult } | null>(null);

  const nameLen = charCount(name.trim());
  const descLen = charCount(description);
  const canSubmit = nameLen >= 1 && nameLen <= MAX_NAME && descLen <= MAX_DESCRIPTION && !busy;

  async function create() {
    if (!canSubmit) return;
    if (requestId.current === null) requestId.current = newRequestId();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body: Record<string, unknown> = {
      slot,
      action: "create",
      requestId: requestId.current,
      name: name.trim(),
      directAdd,
      ...(description.trim() ? { description } : {}),
      ...(inviteesBody(invitees) ?? {}),
    };
    try {
      const json = await callEmbedApi(MANAGE_PATH, "POST", body);
      if (json.ok === true) {
        const group = json.group as { name?: unknown } | undefined;
        setCreated({
          name: typeof group?.name === "string" ? group.name : name.trim(),
          invites: inviteResultFrom(json) ?? EMPTY_RESULT,
        });
        if (json.replayed === true) setNotice(REPLAYED_MESSAGE);
        requestId.current = null;
        onCreated();
      } else if (json.mayExist === true) {
        setError(`${messageOf(json)} ${MAY_EXIST_SUFFIX}`);
        requestId.current = null;
        onCreated();
      } else {
        setError(messageOf(json));
      }
    } catch (err) {
      // The request may or may not have arrived: keep the same requestId so a second press is safe.
      setError(errorText(err));
    }
    setBusy(false);
  }

  const names = Object.fromEntries(invitees.picked.map((p) => [p.id, p.name]));

  if (created) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
        <h3 className="text-xs font-semibold text-ink">Group created</h3>
        <p className="text-sm text-ink">{created.name}</p>
        {notice ? <p className="text-xs text-info">{notice}</p> : null}
        {!notice ? <InviteSummary result={created.invites} names={names} /> : null}
        <div>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-3 py-2.5">
      <h3 className="text-xs font-semibold text-ink">Create a WhatsApp group</h3>

      <label className="flex flex-col gap-1 text-xs text-ink">
        Group name
        <input type="text" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} className={INPUT_CLASS} />
        <span className={nameLen > MAX_NAME ? "text-loss" : "text-ink-faint"}>
          {nameLen}/{MAX_NAME}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-xs text-ink">
        Description (optional)
        <textarea value={description} rows={2} disabled={busy} onChange={(e) => setDescription(e.target.value)} className={INPUT_CLASS} />
        <span className={descLen > MAX_DESCRIPTION ? "text-loss" : "text-ink-faint"}>
          {descLen}/{MAX_DESCRIPTION}
        </span>
      </label>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold text-ink">Invite people</p>
        <InviteePicker slot={slot} callEmbedApi={callEmbedApi} value={invitees} onChange={setInvitees} disabled={busy} />
      </div>

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

      <InviteTemplateEditor callEmbedApi={callEmbedApi} />

      {error ? <p className="text-xs text-loss">{error}</p> : null}

      <div className="flex gap-2">
        <Button size="sm" disabled={!canSubmit} onClick={() => void create()}>
          {busy ? "Creating…" : "Create group"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
