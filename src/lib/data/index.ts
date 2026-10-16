import { MAX_LOGO_BYTES, sniffImageType } from "@/lib/brand";
import { deleteGhlAccountLogoObjectsService, SupabaseGhlRepository, uploadGhlAccountLogoService } from "./supabase";
import type { GhlRepository } from "./repository";

export type { GhlRepository } from "./repository";

/**
 * The one data-access instance: service-role Supabase. PortalHub's `repo` and
 * `webhookRepo` both map to this export — there are no user-session repos in
 * this codebase, and no demo mode.
 */
export const repo: GhlRepository = new SupabaseGhlRepository();

/**
 * "Now", for relative-time display (`src/lib/format.ts`'s `relativeTime`)
 * computed in a server component. Copied from PortalHub's data barrel minus
 * its demo-mode fixture anchor: always the real wall clock here.
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * W-CONNECT-BRAND — the GHL-location twin of `storeCoachLogo` immediately
 * above. SAME VALIDATION, FIELD FOR FIELD (empty-file check, `MAX_LOGO_BYTES`
 * against the real byte length, `sniffImageType`'s magic-byte check rather
 * than trusting `File.type`) — deliberately duplicated rather than shared,
 * because the two callers write to different tables under different
 * authorization stories (a coach's own/owner-on-their-behalf session vs a GHL
 * location under `saveGhlAccountBrandingAction`'s three-gate owner guard),
 * and a shared helper would need to take a bucket-prefix strategy as a
 * parameter for a total savings of a handful of lines. See `storeCoachLogo`'s
 * own JSDoc for why each check exists — that reasoning applies verbatim here.
 *
 * RETURNS A PATH, NOT A URL — unlike `storeCoachLogo` (which returns
 * `coaches.logo_url`, a full URL, because that's the shape 0066 chose for
 * coaches), this returns what `ghl_accounts.brand_logo_path` actually stores.
 * See migration 0076's header, "WHY A PATH, NOT A URL", for the reasoning.
 *
 * DEMO MODE: unreachable, not merely inert. `saveGhlAccountBrandingAction`'s
 * own `repo.getGhlAccountByLocationId` gate refuses before ever calling this
 * (demo mode has no `ghl_accounts` row, ever — this section's own header in
 * `demo.ts`), so reaching this branch in demo mode can only mean that gate
 * was skipped somewhere — a bug worth a loud failure, same posture as
 * `bumpGhlConnectLinkVersion`'s demo stub, not the quiet no-op most inert GHL
 * stubs use for genuinely reachable-but-pointless calls.
 */
export async function storeGhlAccountLogo(
  locationId: string,
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (file.size === 0) return { ok: false, error: "That file is empty. Try exporting your logo again." };
  if (file.size > MAX_LOGO_BYTES) {
    return {
      ok: false,
      error: `That logo is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_LOGO_BYTES / 1024 / 1024} MB. A PNG around 500×200 is plenty.`,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return {
      ok: false,
      error: "That doesn't look like a PNG, JPG or WebP image. If you have an SVG, export it as a PNG first.",
    };
  }

  const path = await uploadGhlAccountLogoService(locationId, bytes, sniffed);
  return { ok: true, path };
}

/**
 * W-CONNECT-BRAND — drop a GHL location's stored logo objects, the
 * `ghl/<locationId>/` twin of `deleteCoachLogoObjects` above. Same
 * "unreachable, not inert" demo posture as `storeGhlAccountLogo` — see that
 * function's own JSDoc.
 */
export async function deleteGhlAccountLogoObjects(locationId: string): Promise<void> {
  await deleteGhlAccountLogoObjectsService(locationId);
}
