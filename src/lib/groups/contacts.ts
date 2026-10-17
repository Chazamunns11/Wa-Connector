import type { GhlContactLite, listGhlContacts } from "@/lib/ghl";

/** Max pages (100 contacts each) scanned when filtering by tag. */
export const TAG_SCAN_MAX_PAGES = 5;

const QUERY_MIN = 2;
const QUERY_MAX = 64;

type ListFn = typeof listGhlContacts;

/** Name/phone/email search. Query is trimmed and must be 2..64 chars, else []. Failures read as no results. */
export async function searchContacts(list: ListFn, token: string, locationId: string, query: string): Promise<GhlContactLite[]> {
  const q = query.trim();
  if (q.length < QUERY_MIN || q.length > QUERY_MAX) return [];
  const r = await list(token, locationId, { query: q });
  return r.ok ? r.contacts : [];
}

/** Case-insensitive tag filter over at most TAG_SCAN_MAX_PAGES pages; `truncated` when more may exist or a page failed. */
export async function contactsByTag(
  list: ListFn,
  token: string,
  locationId: string,
  tag: string
): Promise<{ contacts: GhlContactLite[]; truncated: boolean }> {
  const want = tag.trim().toLowerCase();
  const contacts: GhlContactLite[] = [];
  if (!want) return { contacts, truncated: false };
  let startAfterId: string | undefined;
  for (let page = 0; page < TAG_SCAN_MAX_PAGES; page++) {
    const r = await list(token, locationId, startAfterId ? { startAfterId } : {});
    if (!r.ok) return { contacts, truncated: true };
    for (const c of r.contacts) if (c.tags.some((t) => t.toLowerCase() === want)) contacts.push(c);
    if (!r.nextStartAfterId) return { contacts, truncated: false };
    startAfterId = r.nextStartAfterId;
  }
  return { contacts, truncated: true };
}

/** Unique, sorted tags for the dropdown. */
export function tagsFrom(contacts: GhlContactLite[]): string[] {
  return [...new Set(contacts.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b));
}
