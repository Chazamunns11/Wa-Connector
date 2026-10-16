/**
 * PARTIAL COPY (Task 3) of PortalHub `src/lib/ghl.ts` — only `ghlTenantKeyQueryFilters`,
 * which the repository layer (`data/supabase.ts`) imports. Task 4 REPLACES this
 * file with the full verbatim copy (which contains this function unchanged).
 */

/**
 * Pure query-filter builder for `Repository.getWhatsappMessagesByTenantKeys`
 * (`src/lib/data/supabase.ts`) — adversarial-review finding 2. That query
 * must bound itself to the WANTED idempotency keys, not just the tenant ids
 * involved: `whatsapp_messages` is never purged, and a query filtered on
 * tenant id alone can, at scale, return more rows than PostgREST's default
 * 1000-row cap allows, silently truncating the exact rows a drain pass wants
 * out of the response before the caller's own pair-matching filter ever
 * runs. Exported and unit-tested HERE (rather than only inline in
 * supabase.ts, which imports `next/headers` and cannot run under plain
 * `node --test`) so the dedupe this fix depends on is pinned independently
 * of a live Supabase call — `getWhatsappMessagesByTenantKeys` is required to
 * apply BOTH arrays this returns as `.in()` filters, never `tenantIds` alone.
 */
export function ghlTenantKeyQueryFilters(pairs: { tenantId: string; idempotencyKey: string }[]): {
  tenantIds: string[];
  idempotencyKeys: string[];
} {
  return {
    tenantIds: [...new Set(pairs.map((p) => p.tenantId))],
    idempotencyKeys: [...new Set(pairs.map((p) => p.idempotencyKey))],
  };
}
