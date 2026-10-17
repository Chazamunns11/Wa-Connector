"use client";

import { useState, useTransition } from "react";
import { searchContactsAction } from "@/app/(app)/dashboard/groups/actions";
import { INPUT_CLASSES } from "@/components/auth/field";
import { Button } from "@/components/ui/Button";
import { GROUP_RESULT_COPY } from "@/lib/groups/forms";
import { ADD_BATCH_MAX } from "@/lib/groups/rules";

type Contact = { id: string; name: string; phone: string | null; tags: string[] };
type Found = { contacts: Contact[]; tags: string[]; truncated: boolean };

/**
 * Three ways to pick people: search GoHighLevel contacts, load a tag, or paste
 * numbers. Picked contacts post as repeated `contact` fields; the server
 * re-normalises every phone and re-checks everything, so this is convenience only.
 */
export function MemberPicker({ locationId, required = false }: { locationId: string; required?: boolean }) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, Contact>>(new Map());
  const [pending, start] = useTransition();

  function run(nextTag: string) {
    setError(null);
    start(async () => {
      const r = await searchContactsAction(locationId, query, nextTag);
      if ("error" in r) {
        setError(r.error === "not_found" ? GROUP_RESULT_COPY.not_found : r.error);
        setFound(null);
        return;
      }
      setFound(r);
      setTags(r.tags);
    });
  }

  function toggle(c: Contact) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Pick from GoHighLevel contacts</legend>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            aria-label="Search contacts by name or phone"
            placeholder="Name or phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                run("");
              }
            }}
            className={INPUT_CLASSES}
          />
          <Button type="button" variant="secondary" disabled={pending || !locationId} onClick={() => run("")} className="min-h-11 shrink-0">
            {pending ? "Searching…" : "Search"}
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label htmlFor="picker-tag" className="text-sm text-ink-dim">
            Or everyone with a tag
          </label>
          <select
            id="picker-tag"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              if (e.target.value) run(e.target.value);
            }}
            onFocus={() => {
              if (tags.length === 0 && locationId && !pending) run("");
            }}
            className={`${INPUT_CLASSES} sm:max-w-xs`}
          >
            <option value="">Choose a tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        ) : null}
        {found ? (
          <div aria-live="polite">
            {found.contacts.length === 0 ? (
              <p className="text-sm text-ink-faint">No contacts with a phone number matched.</p>
            ) : (
              <ul className="max-h-64 divide-y divide-divider overflow-y-auto rounded-lg border bg-well">
                {found.contacts.map((c) => (
                  <li key={c.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
                      <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c)} className="size-4 accent-[var(--accent)]" />
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.name || "No name"}</span>
                      <span className="text-sm tabular-nums text-ink-dim">{c.phone}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {found.truncated ? (
              <p className="mt-2 text-sm text-ink-faint">Only the first part of a large contact list was checked. Narrow the search if someone is missing.</p>
            ) : null}
          </div>
        ) : null}
        {[...picked.values()].map((c) => (
          <input key={c.id} type="hidden" name="contact" value={`${c.id}|${c.phone ?? ""}|${c.name}`} />
        ))}
        <p className="text-sm text-ink-faint">{picked.size} picked</p>
      </fieldset>

      <div>
        <label htmlFor="pasted" className="text-sm font-medium text-ink">
          Or paste phone numbers
        </label>
        <textarea
          id="pasted"
          name="pasted"
          rows={3}
          required={required && picked.size === 0}
          aria-describedby="pasted-help"
          className={`${INPUT_CLASSES} mt-1 py-2`}
        />
        <p id="pasted-help" className="mt-1 text-sm text-ink-faint">
          One per line or comma-separated. UK numbers can start with 07; others need the + and country code. Up to {ADD_BATCH_MAX} people at a time.
        </p>
      </div>

      <label className="flex items-start gap-3 rounded-lg border bg-well p-3">
        <input type="checkbox" name="consent" required className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
        <span className="text-sm text-ink">These people have agreed to be in this group</span>
      </label>
    </div>
  );
}
