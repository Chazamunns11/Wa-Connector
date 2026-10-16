/**
 * Copied verbatim from PortalHub `src/lib/signup-throttle.ts` — only
 * `clientIpFromHeaders` is used here (by the connect-link session route and
 * page); the signup throttle itself is Hub-only.
 */

/**
 * Client IP for throttling, from the platform's own proxy headers. Vercel
 * (this app's host — see vercel.json) OVERWRITES `x-forwarded-for` at the
 * edge, so its first entry is the real client rather than anything a caller
 * can spoof; `x-real-ip` is the fallback. A missing/garbage value degrades to
 * `null` (email-only limiting) rather than to a shared bucket every visitor
 * would fight over.
 *
 * Never logged, never persisted, never put in a URL (privacy) — it exists
 * only as a Map key in memory for at most one window.
 */
export function clientIpFromHeaders(headerList: { get(name: string): string | null }): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  const candidate = first || headerList.get("x-real-ip")?.trim() || null;
  if (!candidate) return null;
  // Cap the length so a hostile header can't be used to bloat a Map key.
  return candidate.slice(0, 64);
}
