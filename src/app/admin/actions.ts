"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { repo, storeGhlAccountLogo, deleteGhlAccountLogoObjects } from "@/lib/data";
import { normaliseHex } from "@/lib/brand";
import { assertOwner } from "@/lib/auth";
import {
  connectWhatsappSession,
  getWhatsappBridgeSession,
  logoutWhatsappSession,
  type BridgeOkResult,
  type BridgeSessionResult,
} from "@/lib/whatsapp-bridge";
import {
  CONNECT_LINK_MENU_TTL_MS,
  CONNECT_LINK_TTL_MS,
  isConnectLinkConfigured,
  mintConnectLinkToken,
} from "@/lib/ghl-connect-link";
import { parseSlotParam } from "@/lib/location-numbers";

/**
 * GHL custom conversation provider, Phase 1 (WAGHL replacement —
 * docs/GHL-PROVIDER-PLAN.md) — the owner setup-links page's
 * `GhlAccountsPanel` connect/poll/logout actions, parameterised by TENANT id
 * rather than coach id (0069's `whatsapp_tenants`). These mirror
 * `src/app/owner/clients/[id]/actions.ts`'s WhatsApp section almost
 * verbatim — same three gates, in the same order, for the same reason: a QR
 * code is a device-link grant, whoever scans it links their phone to that
 * WhatsApp and can read/send as it, so nothing here may reach the bridge
 * without ALL of:
 *   1. `assertOwner()` — the owner layout redirect's own re-check.
 *   2. `assertLiveMode()` — demo mode's `fc-demo-role` cookie is not a real
 *      authenticated session (see its own JSDoc below, copied rather than
 *      imported from the coach-side file — this codebase's existing
 *      convention keeps each action file's guards local to it); the bridge
 *      on the other end is real regardless of which data layer this
 *      deployment's UI happens to read from.
 *   3. `assertGhlAccountExists()` — never forward a client-supplied tenant
 *      id to the bridge without first checking it actually names an
 *      installed GHL location, mirroring `assertCoachExists`'s rationale
 *      exactly.
 */

/**
 * Throws unless `tenantId` names a real, currently-installed GHL account —
 * mirrors `src/app/owner/clients/[id]/actions.ts`'s `assertCoachExists`
 * exactly: every sibling owner action that reaches a real device-link grant
 * checks its id belongs to something real first.
 */
async function assertGhlAccountExists(tenantId: string): Promise<void> {
  const accounts = await repo.getGhlAccounts();
  if (!accounts.some((a) => a.tenantId === tenantId)) {
    throw new Error("That GHL location doesn't exist — refresh the page and try again.");
  }
}

/**
 * "Connect WhatsApp" button (per-GHL-location row) — first-ever connect (or
 * a reconnect after logout/disconnect) flips the bridge to `waiting_qr`; the
 * panel then polls `pollGhlWhatsappSessionAction` for the live QR. Returns
 * the bridge's discriminated result as plain JSON — never throws on a
 * bridge-side failure — so the client component can render every outcome
 * without a try/catch of its own.
 */
export async function connectGhlWhatsappAction(tenantId: string): Promise<BridgeSessionResult> {
  await assertOwner();
  await assertGhlAccountExists(tenantId);
  return connectWhatsappSession(tenantId);
}

/**
 * Poll target during the linking flow — THE ONLY PATH a QR string ever
 * travels for a GHL location, same contract as the coach-side action of the
 * same shape. Also doubles as the "resume linking" check when the panel
 * mounts mid-`waiting_qr`.
 */
export async function pollGhlWhatsappSessionAction(tenantId: string): Promise<BridgeSessionResult> {
  await assertOwner();
  await assertGhlAccountExists(tenantId);
  return getWhatsappBridgeSession(tenantId);
}

/**
 * "Log out" — unlinks this GHL location's WhatsApp number and wipes the
 * bridge's stored credentials for it. The panel gates this behind its own
 * confirm dialog; this action just re-asserts the three guards and
 * revalidates the setup-links page so the DB-derived summary catches up to
 * the bridge's new `logged_out` status on the next render.
 */
export async function logoutGhlWhatsappAction(tenantId: string): Promise<BridgeOkResult> {
  await assertOwner();
  await assertGhlAccountExists(tenantId);
  const result = await logoutWhatsappSession(tenantId);
  revalidatePath("/admin");
  return result;
}

// ---------------------------------------------------------------------------
// Per-client connect links (docs/GHL-PROVIDER-CLIENT-MIGRATION.md,
// src/lib/ghl-connect-link.ts) — mint/revoke a `/connect/[token]` link for
// ONE GHL location. Same three-gate pattern as the three actions above
// (`assertOwner()` -> `assertLiveMode()` -> account-exists), PLUS a fourth
// gate neither of those needs: `isConnectLinkConfigured()`. Both actions
// re-read the account by LOCATION id (`repo.getGhlAccountByLocationId`),
// not tenant id — this feature is keyed on `locationId` throughout
// (`mintConnectLinkToken`'s own signature, the `/connect/[token]` URL
// itself), unlike the connect/poll/logout actions above which are
// tenant-id-keyed because that is what the WhatsApp bridge itself expects.
// ---------------------------------------------------------------------------

export interface CreateConnectLinkResult {
  url: string;
  expiresAtMs: number;
  /** Which lifetime was actually minted — the panel's copy differs per variant. */
  lifetime: "send" | "menu";
}

/**
 * "Create connect link" — mints a fresh `/connect/[token]` URL for one GHL
 * location and returns it to the owner panel to show ONCE (mirrors every
 * other one-time-reveal secret in this codebase — the onboarding invite
 * token's own "shown to the owner exactly once" rule, src/lib/onboarding.ts).
 *
 * DELIBERATELY DOES NOT BUMP `connect_link_version` — Charlie may want to
 * send the SAME link twice (a WhatsApp message AND a follow-up email, say) —
 * minting must be side-effect-free with respect to any link minted earlier.
 * ONLY `revokeGhlConnectLinksAction` below ever changes the version.
 *
 * HONEST REFUSALS, NOT A GENERIC FAILURE — this feature ships DARK
 * (`ONBOARD_STATE_SECRET` is not set in production as of this writing) and
 * every gate here says PRECISELY what is missing rather than a vague
 * "something went wrong", so Charlie (reading this in his own owner panel,
 * not a Vercel log) can act on it immediately:
 *   - `isConnectLinkConfigured()` false -> names `ONBOARD_STATE_SECRET`
 *     specifically.
 *   - `account.connectLinkVersion === null` -> names migration 0075
 *     specifically (a pre-migration database — `GhlAccount.connectLinkVersion`'s
 *     own JSDoc, src/lib/types.ts, is what this refusal is protecting: never
 *     mint a token against a column that doesn't exist to check it against).
 */
export async function createGhlConnectLinkAction(
  locationId: string,
  /**
   * Which lifetime to mint — see `CONNECT_LINK_MENU_TTL_MS`
   * (src/lib/ghl-connect-link.ts) for why there are two.
   *
   * `"send"` (default): 7 days, for a link messaged to a client once.
   * `"menu"`: 1 year, for a link installed as a custom menu link in that
   * client's own GHL sidebar — where its whole job is still working months
   * later, on the day their number drops. A 7-day token in that slot would
   * say "this link has expired" at exactly the moment it was needed.
   *
   * Defaults to the shorter one so a caller that says nothing gets the safer
   * of the two.
   */
  lifetime: "send" | "menu" = "send",
  /** Which of the location's numbers the link connects — a slot (1 to 3), never a tenant id. Defaults to slot 1. */
  slot: number = 1
): Promise<CreateConnectLinkResult> {
  await assertOwner();

  if (!isConnectLinkConfigured()) {
    throw new Error(
      "Connect links aren't switched on for this deployment yet — ONBOARD_STATE_SECRET isn't set. Set it in " +
        "Vercel's environment variables (see docs/GO-LIVE-FOUNDATION.md, Part 3 — Vercel), then redeploy."
    );
  }

  const account = await repo.getGhlAccountByLocationId(locationId);
  if (!account) {
    throw new Error("That GHL location doesn't exist — refresh the page and try again.");
  }
  if (account.connectLinkVersion === null) {
    throw new Error(
      "Connect links aren't available yet — the database schema (supabase/migrations/0001_init.sql) hasn't been " +
        "applied to this database, so the ghl_accounts.connect_link_version column is missing. Apply it, then try again."
    );
  }

  // The slot comes from the browser: strict parse, then it must be a number
  // this location actually has (a link for a missing number would only open
  // on "unknown number").
  const parsedSlot = parseSlotParam(slot);
  if (!parsedSlot.ok) {
    throw new Error("That isn't a valid WhatsApp number slot — refresh the page and try again.");
  }
  const numbers = await repo.listLocationNumbers(locationId);
  if (!numbers.some((n) => n.slot === parsedSlot.slot)) {
    throw new Error("That WhatsApp number no longer exists on this sub-account — refresh the page and try again.");
  }

  const token = mintConnectLinkToken(locationId, account.connectLinkVersion, lifetime, parsedSlot.slot);

  // Same origin derivation as SetupLinksPage's booking/cancel links — see
  // that page's own comment (src/app/owner/setup-links/page.tsx) for why
  // `x-forwarded-proto` rather than assuming https.
  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const url = `${proto}://${host}/connect/${token}`;

  // Derived from the SAME `lifetime` the token was actually signed with, not
  // a second hardcoded constant — otherwise the panel could confidently show
  // an expiry date the token itself doesn't agree with.
  return {
    url,
    expiresAtMs: Date.now() + (lifetime === "menu" ? CONNECT_LINK_MENU_TTL_MS : CONNECT_LINK_TTL_MS),
    lifetime,
  };
}

/**
 * "Revoke all links" — bumps `ghl_accounts.connect_link_version` for ONE
 * location, instantly invalidating every `/connect/[token]` link (AND any
 * already-exchanged session token — `authorizeConnectRequest`'s own version
 * check, src/app/api/connect/guard.ts) ever minted for it. Touches NOTHING
 * else: not this location's live WhatsApp session (a client mid-linking
 * attempt whose link gets revoked loses the ABILITY to reach that attempt
 * through this link, not the attempt itself — see `GhlAccount.connectLinkVersion`'s
 * own JSDoc for why a version counter rather than a kill switch), not any
 * OTHER GHL location's links, not the account row's `status`.
 */
export async function revokeGhlConnectLinksAction(locationId: string): Promise<void> {
  await assertOwner();

  const account = await repo.getGhlAccountByLocationId(locationId);
  if (!account) {
    throw new Error("That GHL location doesn't exist — refresh the page and try again.");
  }

  await repo.bumpGhlConnectLinkVersion(locationId);
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// W-CONNECT-BRAND — per-client branding (logo + accent colour) on the
// `/connect/[token]` page (migration 0076). Same three-gate pattern as every
// action above (`assertOwner()` -> `assertLiveMode()` -> account-exists,
// keyed on LOCATION id like the connect-link actions just above, not tenant
// id), PLUS server-side validation of exactly the two fields this feature
// writes: the logo file (size + real magic-byte type — see
// `storeGhlAccountLogo`, src/lib/data/index.ts, which never trusts the
// browser's claimed content-type, matching `storeCoachLogo`'s identical
// posture) and the accent colour (`normaliseHex`, so an unparseable or
// hostile string — e.g. `"red;background:url(javascript:alert(1))"` — is
// refused here, BEFORE it ever reaches `updateGhlAccountBranding`'s own
// re-normalisation, rather than only being caught by that second, deeper
// check).
// ---------------------------------------------------------------------------

export interface SaveGhlAccountBrandingResult {
  brandLogoPath: string | null;
  brandAccentColor: string | null;
  /** Set when the upload/colour was REFUSED — user-correctable, shown next to the field rather than thrown, same convention as `BrandingSaveOutcome` (src/lib/branding-save.ts). */
  error?: string;
}

/**
 * "Save branding" — the owner panel's logo-upload + accent-colour editor for
 * one GHL location. ORDER OF OPERATIONS mirrors `applyBrandingFormData`'s own
 * (src/lib/branding-save.ts) for the identical reason: upload/validate FIRST
 * and bail without writing anything on a rejection (so a failed upload can
 * never half-apply a colour change), write the row ONCE with both fields
 * together, and delete any old logo objects LAST, only when explicitly
 * clearing.
 *
 * `formData` carries `logo` (a File, only when a new one was picked),
 * `removeLogo` ("1" to clear), and `accentColor` (`#RRGGBB`, or empty to
 * clear) — same shape as `BrandingCard`'s own `onSave` contract
 * (src/components/branding/BrandingCard.tsx), so the owner panel's editor can
 * follow that established convention rather than inventing a second form
 * shape.
 */
export async function saveGhlAccountBrandingAction(
  locationId: string,
  formData: FormData
): Promise<SaveGhlAccountBrandingResult> {
  await assertOwner();

  const account = await repo.getGhlAccountByLocationId(locationId);
  if (!account) {
    throw new Error("That GHL location doesn't exist — refresh the page and try again.");
  }

  // `rawColour` absent/missing from `formData` entirely (rather than present
  // but empty) means the caller didn't touch this field at all — see the
  // `brandAccentColor` patch note below for why that case must leave the
  // stored colour untouched rather than clearing it.
  const colourFieldPresent = formData.has("accentColor");
  const rawColour = formData.get("accentColor");
  const wantsColour = typeof rawColour === "string" && rawColour.trim() !== "";
  const normalisedColour = wantsColour ? normaliseHex(rawColour as string) : null;
  if (wantsColour && normalisedColour === null) {
    return {
      brandLogoPath: account.brandLogoPath,
      brandAccentColor: account.brandAccentColor,
      error: "That isn't a colour we recognise — use a hex value like #17BEB4.",
    };
  }

  const file = formData.get("logo");
  const wantsRemove = formData.get("removeLogo") === "1";
  // `instanceof File` plus a size check, same reasoning as
  // `applyBrandingFormData`: an untouched file input still submits a
  // zero-byte File in some browsers.
  const hasNewLogo = file instanceof File && file.size > 0;

  let brandLogoPath: string | null | undefined;
  if (hasNewLogo) {
    const stored = await storeGhlAccountLogo(locationId, file);
    if (!stored.ok) {
      // Nothing written — the stored branding is exactly as it was.
      return { brandLogoPath: account.brandLogoPath, brandAccentColor: account.brandAccentColor, error: stored.error };
    }
    brandLogoPath = stored.path;
  } else if (wantsRemove) {
    brandLogoPath = null;
  }
  // else: `undefined` — leave the existing logo untouched.

  // adversarial review lens 5, finding 9 — MINOR, fixed. This used to set
  // `brandAccentColor: normalisedColour` UNCONDITIONALLY here, unlike
  // `brandLogoPath` just above (correctly `undefined`-gated on whether the
  // caller actually touched the logo). `updateGhlAccountBranding`
  // (src/lib/data/supabase.ts) already treats `undefined` as "leave this
  // column alone" — `if (patch.brandAccentColor !== undefined) update...` —
  // so the DB layer was always ready for this; the caller just wasn't asking
  // for it. Without the gate, a logo-only save (accentColor field absent, or
  // any caller of this action that doesn't resubmit the current colour every
  // time) silently WIPED the stored colour to null, because `wantsColour`
  // false unconditionally produced `normalisedColour = null`. Gated the same
  // way as `brandLogoPath` now: the patch only carries `brandAccentColor` at
  // all when the caller's form actually included the field.
  await repo.updateGhlAccountBranding(locationId, {
    ...(brandLogoPath !== undefined ? { brandLogoPath } : {}),
    ...(colourFieldPresent ? { brandAccentColor: normalisedColour } : {}),
  });

  // Only now that the row no longer points at them.
  if (wantsRemove && !hasNewLogo) await deleteGhlAccountLogoObjects(locationId);

  revalidatePath("/admin");
  return {
    brandLogoPath: brandLogoPath !== undefined ? brandLogoPath : account.brandLogoPath,
    brandAccentColor: colourFieldPresent ? normalisedColour : account.brandAccentColor,
  };
}
