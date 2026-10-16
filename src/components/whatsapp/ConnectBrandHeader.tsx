"use client";

import { useState } from "react";
import { inkFor, monogramFor, normaliseHex, resolveLogoPath, BRAND_TEAL } from "@/lib/brand";

/**
 * W-CONNECT-BRAND — the branded header row for the GHL connect-link page
 * (`/connect/[token]`, docs/GHL-PROVIDER-CLIENT-MIGRATION.md) and its
 * owner-panel live preview (`GhlAccountsPanel.tsx`'s branding editor).
 *
 * ONE COMPONENT, TWO SURFACES, same reasoning as `BrandingCard`'s own header
 * comment (src/components/branding/BrandingCard.tsx): the thing being
 * previewed while Charlie edits a location's branding is the SAME header
 * this file renders on the real, live connect page — not a hand-drawn
 * approximation of it — so what he sees while picking a colour is exactly
 * what the client opens.
 *
 * LOGO-OR-MONOGRAM, NEVER A BROKEN IMAGE. `logoPath` is a raw
 * `ghl_accounts.brand_logo_path` (a bucket path, or `null` — see
 * `resolveLogoPath`'s own JSDoc, src/lib/brand.ts, for the two shapes it
 * accepts). A missing/404 logo (a deleted object, a bad path typed by hand
 * against a pre-migration database) degrades to the monogram via `onError`
 * rather than the browser's own broken-image icon — a client's first
 * impression of "their own tool" must never be a broken `<img>`.
 *
 * DIMENSIONS ARE FIXED (`h-11 w-11`, `object-contain`, `overflow-hidden`) so
 * an arbitrarily-sized uploaded logo can never stretch this header or push
 * the status pill off the row — the ONE thing every branding surface in this
 * codebase has to guarantee about a client-supplied image (see
 * `BrandHeader`/`BrandingCard`'s identical `max-w`/`object-contain`
 * constraints, src/app/book/branding.tsx and
 * src/components/branding/BrandingCard.tsx).
 *
 * CONTRAST IS COMPUTED, NEVER ASSUMED (hard rule this whole feature inherits
 * from `src/lib/brand.ts`'s header): the monogram badge's text colour is
 * `inkFor(accent)`, not a fixed dark/light guess, so a client who picks a
 * near-black accent still gets a readable letter on it.
 */
export interface ConnectBrandHeaderProps {
  /** The client's own label — GHL location name, or the fallback `"GHL location …"` string `/connect/[token]/page.tsx` already produces when GHL never sent one. */
  label: string;
  /** Raw `ghl_accounts.brand_logo_path` — a bucket path, an already-resolved URL (demo mode), or `null`. Never a pre-resolved URL from the caller; this component owns the resolution so both surfaces can never disagree on it. */
  logoPath: string | null;
  /**
   * `#RRGGBB`, or `null` for the default FitClosers teal (`BRAND_TEAL`).
   * Re-normalised at the top of this component regardless — see the
   * component body's own comment (adversarial review lens 5, finding 6).
   */
  accentColor: string | null;
  /** Right-aligned slot — a status `Chip` on the live page, nothing in the owner-panel preview. Mirrors `CardHeader`'s own `action` prop shape. */
  action?: React.ReactNode;
  /** Sub-label under the business name. Defaults to what the live connect page actually shows. */
  subLabel?: string;
}

export function ConnectBrandHeader({
  label,
  logoPath,
  accentColor,
  action,
  subLabel = "WhatsApp connection",
}: ConnectBrandHeaderProps) {
  // The URL that most recently FAILED to load, paired so a fresh `logoPath`
  // (a new upload replacing a broken one, or the owner panel's live preview
  // swapping between pending picks) always gets a fresh chance to load —
  // comparing against the CURRENT `logoUrl` rather than a bare boolean means
  // this can never stay pinned to a previous, unrelated URL's failure. Same
  // "paired value, not a bare flag" shape as `WhatsappConnectionPanel.tsx`'s
  // own `qrEncoded` state, for the identical reason.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  // adversarial review lens 5, finding 6 — MINOR, fixed. The JSDoc on
  // `accentColor` said "normalised" but nothing enforced it — an
  // un-normalised value (a future third caller that skips `normaliseHex`, a
  // hand-edited prop in a test) would flow straight into `inkFor`, whose
  // `parseInt` on a non-hex string quietly returns `NaN`, so `inkFor` would
  // silently pick white and the monogram badge would degrade with no error
  // anywhere. Both CURRENT callers (`ConnectLinkClient.tsx`,
  // `GhlAccountsPanel.tsx`'s live preview) already normalise before passing
  // this prop — this call is for the THIRD caller that inevitably won't
  // remember to, so the guarantee lives here once rather than in every call
  // site.
  const resolvedAccent = normaliseHex(accentColor) ?? BRAND_TEAL;
  const ink = inkFor(resolvedAccent);
  const logoUrl = resolveLogoPath(logoPath);
  const showLogo = Boolean(logoUrl) && logoUrl !== brokenUrl;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-raised"
          style={showLogo ? undefined : { backgroundColor: resolvedAccent, color: ink }}
        >
          {showLogo ? (
            // A client-supplied logo URL is arbitrary/external (a Supabase
            // Storage public URL, or a demo-mode data URL) — next/image would
            // need every possible host allowlisted in next.config.ts for no
            // benefit here. Same reasoning as `BrandHeader`
            // (src/app/book/branding.tsx) and `BrandingCard`'s own preview.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl ?? undefined}
              alt=""
              className="h-full w-full object-contain"
              onError={() => setBrokenUrl(logoUrl)}
            />
          ) : (
            <span className="font-display text-lg font-semibold">{monogramFor(label)}</span>
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-ink">{label}</p>
          <p className="text-xs text-ink-faint">{subLabel}</p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
