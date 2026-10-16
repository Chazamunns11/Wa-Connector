/**
 * Shared formatting helpers. Money is always integer pence; dates are always
 * ISO strings displayed en-GB. Never format inline in components — import
 * from here so the whole app stays consistent.
 */

// Copied from PortalHub src/lib/format.ts — only the helpers the copied
// GHL panels use (formatDate, relativeTime).

// timeZone pinned to Europe/London: server components render on Vercel (UTC),
// so an unpinned formatter showed every time an hour early during BST — a
// 14:00 UK call displayed as "13:00". FitClosers is a UK business; all
// user-facing dates/times are UK wall-clock regardless of server timezone.
const DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Europe/London",
});

/** Format an ISO date/timestamp string as "15 Jul 2026" (en-GB). */
export function formatDate(iso: string): string {
  return DATE_FORMATTER.format(new Date(iso));
}

/**
 * Coarse "time ago" string for onboarding/status displays (docs/SPEC-V2.md
 * — e.g. the booking-webhook onboarding step's "last event 2h ago" detail).
 * Caller supplies `nowMs` explicitly rather than this function calling
 * `Date.now()` itself, so demo mode can pass the fixed fixture anchor
 * instead of the real wall-clock and stay deterministic (mirrors the
 * anchor-based date helpers in src/lib/data/demo.ts).
 */
export function relativeTime(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;
  // Future timestamp (negative delta) — a caller that points this at an
  // upcoming instant (a future-scheduled call, a not-yet-due token) should read
  // "in 3h", never a misleading "just now".
  if (ms < 0) {
    const ahead = -ms;
    if (ahead < MIN) return "in a moment";
    if (ahead < HOUR) return `in ${Math.floor(ahead / MIN)}m`;
    if (ahead < DAY) return `in ${Math.floor(ahead / HOUR)}h`;
    if (ahead < WEEK) return `in ${Math.floor(ahead / DAY)}d`;
    if (ahead < MONTH) return `in ${Math.floor(ahead / WEEK)}w`;
    if (ahead < YEAR) return `in ${Math.floor(ahead / MONTH)}mo`;
    return `in ${Math.floor(ahead / YEAR)}y`;
  }
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  // Roll days up into weeks/months/years so a long-dormant timestamp reads
  // "14mo ago", not "425d ago".
  if (ms < WEEK) return `${Math.floor(ms / DAY)}d ago`;
  if (ms < MONTH) return `${Math.floor(ms / WEEK)}w ago`;
  if (ms < YEAR) return `${Math.floor(ms / MONTH)}mo ago`;
  return `${Math.floor(ms / YEAR)}y ago`;
}
