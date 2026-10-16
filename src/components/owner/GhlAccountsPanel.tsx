"use client";

import { useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Chip, type ChipTone } from "@/components/ui/Chip";
import { CopyButton } from "@/components/owner/CopyButton";
import { relativeTime, formatDate } from "@/lib/format";
import { WhatsappConnectionPanel, type WhatsappPanelCopy } from "@/components/whatsapp/WhatsappConnectionPanel";
import { ConnectBrandHeader } from "@/components/whatsapp/ConnectBrandHeader";
import { MAX_LOGO_BYTES, SAFE_LOGO_TYPES, isNearlyInvisibleOn, normaliseHex } from "@/lib/brand";
import {
  connectGhlWhatsappAction,
  createGhlConnectLinkAction,
  logoutGhlWhatsappAction,
  pollGhlWhatsappSessionAction,
  revokeGhlConnectLinksAction,
  saveGhlAccountBrandingAction,
  type CreateConnectLinkResult,
  type SaveGhlAccountBrandingResult,
} from "@/app/admin/actions";
import type { GhlAccountStatus, GhlAccountSummary, WhatsappSessionSummary } from "@/lib/types";

/**
 * Reason codes the two GHL OAuth routes redirect back with (`?ghl=`), as
 * sentences a human can act on — same shape and purpose as
 * `CalendarConnectionCard.tsx`'s own `RESULT_MESSAGES`, which this mirrors
 * deliberately (down to the tone vocabulary) rather than inventing a second
 * convention for what is structurally the same "OAuth round trip result"
 * problem.
 *
 * `bulk_*` (4 Aug 2026, bulk-install fix — see
 * `.../api/crm/oauth/callback/route.ts`'s own header for the full diagnosis)
 * are the only entries whose text depends on the counts passed alongside
 * `result` — every other entry is a fixed sentence, matching the calendar
 * card's map exactly.
 *
 * `no_location` is kept even though the current callback route no longer
 * PRODUCES it (a Company-scoped token is now routed into the bulk-install
 * path instead of this failure) — a browser tab left open from before this
 * fix shipped can still land here with that old code, and it must render
 * something sensible rather than nothing.
 */
function ghlResultMessage(
  result: string | undefined,
  counts: { installed?: number; failed?: number; capped?: number }
): { tone: "win" | "loss" | "warn" | "muted"; text: string } | null {
  if (!result) return null;
  const cappedSuffix =
    counts.capped && counts.capped > 0
      ? ` ${counts.capped} more location${counts.capped === 1 ? "" : "s"} were found but not run this time — install again to pick up the rest.`
      : "";
  switch (result) {
    case "connected":
      return { tone: "win", text: "GHL location connected — install its WhatsApp number below to start sending." };
    case "cancelled":
      return { tone: "muted", text: "No problem — nothing was installed." };
    case "forbidden":
      return { tone: "loss", text: "That account can't install a GHL location here." };
    case "unavailable":
      return { tone: "loss", text: "GHL connections aren't switched on for this site yet." };
    case "expired":
      return { tone: "loss", text: "That link timed out. Please try installing again." };
    case "invalid":
      return { tone: "loss", text: "Something went wrong with that link. Please try again." };
    case "exchange_failed":
      return { tone: "loss", text: "GHL didn't complete the connection. Please try again." };
    case "no_location":
      return { tone: "loss", text: "GHL didn't tell us which location that was. Please try again." };
    case "no_refresh_token":
      return {
        tone: "loss",
        text: "GHL didn't grant long-term access, so this connection would have stopped working within a day. Please try again.",
      };
    case "save_failed":
      return { tone: "loss", text: "We couldn't save that connection. Please try again." };
    case "bulk_locations_failed":
      return {
        tone: "loss",
        text: "GHL accepted the agency install but wouldn't tell us which locations it covers. Please try again.",
      };
    case "bulk_no_locations":
      return { tone: "loss", text: "GHL reported zero locations for this agency install — nothing to connect yet." };
    case "bulk_installed": {
      const n = counts.installed ?? 0;
      return { tone: "win", text: `Installed ${n} location${n === 1 ? "" : "s"} from this agency install.${cappedSuffix}` };
    }
    case "bulk_partial": {
      const n = counts.installed ?? 0;
      const f = counts.failed ?? 0;
      return {
        tone: "warn",
        text: `Installed ${n} location${n === 1 ? "" : "s"}, ${f} failed — the failed ones can be retried by installing again.${cappedSuffix}`,
      };
    }
    case "bulk_failed": {
      const f = counts.failed ?? 0;
      return { tone: "loss", text: `${f} location${f === 1 ? "" : "s"} failed to install from this agency install. Please try again.` };
    }
    default:
      return null;
  }
}

/**
 * Owner "GHL WhatsApp numbers" panel (WAGHL replacement, Phase 1 —
 * docs/GHL-PROVIDER-PLAN.md, file list #9). Lives on `/owner/setup-links`
 * below the existing WhatsApp connections overview — same doctrine as that
 * panel and `IntegrationHealthPanel`: per-integration status lives where
 * Charlie already goes to wire clients up.
 *
 * PARTITIONED FROM THE COACH PANEL, DELIBERATELY: `WhatsappConnectionsPanel`
 * lists Hub coaches only (`repo.getCoaches()`-derived) — a GHL tenant id was
 * never a coach id (0069's kind-pinned FK makes that structurally true, not
 * just conventionally so), so it can never appear there. This panel is the
 * entire GHL surface, and reuses the SAME QR/connect/logout machinery
 * (`WhatsappConnectionPanel`) the coach panel's own detail-page card does,
 * parameterised by tenant id instead of coach id — the bridge client
 * (`src/lib/whatsapp-bridge.ts`) is already opaque-UUID-keyed, so nothing
 * there needed to change.
 *
 * INLINE, NOT LINKED OUT: unlike the coach panel (which links to a full
 * `/owner/clients/[id]` detail page for the actual QR flow), there is no
 * per-location detail page in this phase — so each row's "Manage" toggles
 * the shared connect panel open INLINE, directly under that row, rather than
 * navigating anywhere.
 */
export function GhlAccountsPanel({
  accounts,
  summaries,
  bridgeConfigured,
  bridgeReachable,
  nowMs,
  result,
  installedCount,
  failedCount,
  cappedCount,
}: {
  accounts: GhlAccountSummary[];
  /**
   * `repo.getWhatsappSessionSummaries({ role: "owner" })` — keyed on
   * `coachId`, but for a row backing a GHL location that field holds the
   * tenant id (0069's historical column name; see that migration's file
   * header on why `whatsapp_*.coach_id` was kept rather than renamed).
   */
  summaries: WhatsappSessionSummary[];
  /** `isWhatsappBridgeConfigured()` — env vars unset means every status below is "last known from the database", never live. */
  bridgeConfigured: boolean;
  /** ONE shared `/health` probe result for the whole page render — see `WhatsappConnectionsPanel`'s identical prop for why this is never fetched per row. */
  bridgeReachable: boolean | null;
  nowMs: number;
  /**
   * The `?ghl=` reason code from the OAuth install round trip, if any — see
   * `.../api/crm/oauth/callback/route.ts` and `.../api/crm/oauth/start/route.ts`'s
   * own `back()` helpers. `ghlResultMessage` above is the full list of codes
   * this can be, mirroring `CalendarConnectionCard`'s identical `?calendar=`
   * result prop.
   */
  result?: string;
  /** Bulk-install outcomes only (`bulk_installed`/`bulk_partial`/`bulk_failed`) — how many locations THIS run wrote/failed/left untried. `undefined` on every single-location outcome. */
  installedCount?: number;
  failedCount?: number;
  /** `> 0` means `GHL_BULK_INSTALL_CAP` (src/app/api/crm/oauth/callback/logic.ts) was hit this run — surfaced rather than silently dropped, per this repo's "no silent caps" convention. */
  cappedCount?: number;
}) {
  // Which row (by tenantId) currently has its connect panel expanded — at
  // most one at a time, mirroring the coach card's single-QR-surface rule
  // (hard rule 1: two live QR surfaces open at once would double the audit
  // area for a device-link grant, for zero benefit).
  const [managingTenantId, setManagingTenantId] = useState<string | null>(null);
  const summaryByTenant = new Map(summaries.map((s) => [s.coachId, s]));

  const headerLine = !bridgeConfigured
    ? "The WhatsApp service isn't set up on this deployment yet — statuses below are the last known from the database and nothing can connect or send."
    : bridgeReachable === false
      ? "The WhatsApp service isn't responding right now — statuses below may be stale."
      : null;
  const resultMessage = ghlResultMessage(result, { installed: installedCount, failed: failedCount, capped: cappedCount });

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-5 pb-0">
        <CardHeader
          title="GHL WhatsApp numbers"
          subtitle="Locations sending WhatsApp through our GHL conversation provider — install a new one, then connect its dedicated business number below."
        />
        <a href="/api/crm/oauth/start" className={buttonClasses("secondary", "sm")}>
          Install to a GHL location
        </a>
      </div>
      {resultMessage ? (
        <p
          className={`px-5 pt-2 text-sm ${
            resultMessage.tone === "win"
              ? "text-win"
              : resultMessage.tone === "loss"
                ? "text-loss"
                : resultMessage.tone === "warn"
                  ? "text-warn"
                  : "text-ink-dim"
          }`}
        >
          {resultMessage.text}
        </p>
      ) : null}
      {headerLine ? (
        <p className={`px-5 pt-2 text-xs ${bridgeConfigured ? "text-warn" : "text-ink-faint"}`}>{headerLine}</p>
      ) : null}

      {accounts.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title="No GHL locations installed yet"
            description="Use “Install to a GHL location” above to authorise a sub-account — GHL itself will ask which one."
          />
        </div>
      ) : (
        <div className="mt-3 divide-y divide-divider">
          {accounts.map((account) => {
            const summary = summaryByTenant.get(account.tenantId) ?? null;
            const isManaging = managingTenantId === account.tenantId;
            return (
              <div key={account.locationId} className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink">{account.label}</p>
                    <p className="text-xs text-ink-faint">
                      {account.locationId} · installed {relativeTime(account.createdAt, nowMs)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <GhlStatusChip status={account.status} />
                    <WhatsappStatusHint summary={summary} />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setManagingTenantId(isManaging ? null : account.tenantId)}
                    >
                      {isManaging ? "Close" : "Manage"}
                    </Button>
                  </div>
                </div>
                {account.status === "needs_reauth" ? (
                  <p className="mt-2 text-xs text-warn">
                    This install needs re-authorising{account.lastError ? ` — ${account.lastError}` : ""}. Reinstall via
                    &ldquo;Install to a GHL location&rdquo; above (pick the same sub-account) to restore it.
                  </p>
                ) : null}
                {isManaging ? (
                  <div className="mt-3 flex flex-col gap-4">
                    <GhlWhatsappConnectPanel
                      tenantId={account.tenantId}
                      label={account.label}
                      summary={summary}
                      bridgeConfigured={bridgeConfigured}
                      bridgeReachable={bridgeReachable}
                      nowMs={nowMs}
                    />
                    <GhlConnectLinkManager locationId={account.locationId} label={account.label} />
                    <GhlAccountBrandingManager
                      locationId={account.locationId}
                      label={account.label}
                      initialLogoPath={account.brandLogoPath}
                      initialAccentColor={account.brandAccentColor}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function GhlStatusChip({ status }: { status: GhlAccountStatus }) {
  const config: Record<GhlAccountStatus, { tone: ChipTone; label: string }> = {
    active: { tone: "win", label: "Active" },
    needs_reauth: { tone: "warn", label: "Needs reauth" },
    disabled: { tone: "muted", label: "Disabled" },
  };
  const { tone, label } = config[status];
  return <Chip tone={tone}>{label}</Chip>;
}

function WhatsappStatusHint({ summary }: { summary: WhatsappSessionSummary | null }) {
  if (!summary) return <span className="text-xs text-ink-faint">WhatsApp: never set up</span>;
  return (
    <span className="text-xs text-ink-faint">
      WhatsApp: {summary.status}
      {summary.phoneNumber ? ` — ${summary.phoneNumber}` : ""}
    </span>
  );
}

/**
 * Per-row wrapper around the shared `WhatsappConnectionPanel` — owner-voice
 * copy naming this GHL location (mirrors `WhatsappConnectionCard`'s
 * identical role for a coach), and binds the three tenant-scoped actions
 * (`src/app/owner/setup-links/actions.ts`) zero-argument, same pattern as
 * every other wrapper around this shared panel.
 */
function GhlWhatsappConnectPanel({
  tenantId,
  label,
  summary,
  bridgeConfigured,
  bridgeReachable,
  nowMs,
}: {
  tenantId: string;
  label: string;
  summary: WhatsappSessionSummary | null;
  bridgeConfigured: boolean;
  bridgeReachable: boolean | null;
  nowMs: number;
}) {
  const copy: WhatsappPanelCopy = {
    cardTitle: "WhatsApp",
    cardSubtitle: `Native WhatsApp sending for ${label}'s GHL location, via our conversation provider.`,
    emptyTitle: "No WhatsApp linked for this location yet",
    emptyDescription: `Connect ${label}'s dedicated WhatsApp business number.`,
    connectLabel: "Connect WhatsApp",
    freshCodeLabel: "Get a new QR code",
    qrInstruction:
      "On the location's WhatsApp business phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.",
    qrWarning: `Anyone who scans this code links their phone to ${label}'s WhatsApp and can read and send as them. Treat it like a password — use the location's own dedicated business number only, never a personal one.`,
    logoutConfirm: `This unlinks ${label}'s number and wipes its stored credentials.`,
    disconnectedFallback: `${label}'s WhatsApp is currently disconnected.`,
    unlinkedMessage: `${label}'s number was unlinked from the portal. Reconnecting is safe whenever it's ready.`,
    unknownAccountMessage: "That GHL location isn't recognised by the WhatsApp service — refresh the page and try again.",
    bannedHelp:
      "This number was blocked by WhatsApp — reconnecting the same number is likely to fail. See the WhatsApp runbook before trying anything else.",
    unauthorizedMessage:
      "The WhatsApp service rejected this deployment's credentials — this needs an operator to check the bridge configuration.",
  };

  return (
    <WhatsappConnectionPanel
      copy={copy}
      summary={summary}
      bridgeConfigured={bridgeConfigured}
      bridgeReachable={bridgeReachable}
      nowMs={nowMs}
      connect={() => connectGhlWhatsappAction(tenantId)}
      poll={() => pollGhlWhatsappSessionAction(tenantId)}
      logout={() => logoutGhlWhatsappAction(tenantId)}
    />
  );
}

/**
 * Per-client connect links (docs/GHL-PROVIDER-CLIENT-MIGRATION.md,
 * src/lib/ghl-connect-link.ts) — the "Create connect link" / "Revoke all
 * links" controls inside a GHL location's "Manage" expansion. Sits ALONGSIDE
 * `GhlWhatsappConnectPanel` (Charlie's own direct connect/QR flow), not in
 * place of it — this is the OTHER way to get a location connected: mint a
 * link, send it to the client, they scan from their own device instead of
 * Charlie doing it live.
 *
 * THE MINTED URL IS SHOWN EXACTLY ONCE, same "shown to the owner exactly
 * once, never persisted for a second read" convention as every other
 * one-time secret reveal in this codebase (the onboarding invite token's own
 * rule, src/lib/onboarding.ts) — this component holds it in local state only
 * and it is gone the moment the row collapses or a fresh link is minted.
 */
function GhlConnectLinkManager({ locationId, label }: { locationId: string; label: string }) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateConnectLinkResult | null>(null);

  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  /**
   * TWO BUTTONS, TWO LIFETIMES (Charlie, 4 Aug 2026: "I click the menu link
   * and connect"). A link MESSAGED to a client should go stale — 7 days,
   * so it stops being a live credential in an old chat thread on its own. A
   * link installed as a CUSTOM MENU LINK in that client's GHL sidebar must
   * do the opposite: its entire job is still working months later, on the day
   * their number drops. Shipping only the 7-day variant would have meant every
   * menu link silently dying a week after it was installed, and greeting the
   * client with "this link has expired" at exactly the wrong moment.
   * See `CONNECT_LINK_MENU_TTL_MS` (src/lib/ghl-connect-link.ts).
   */
  async function handleCreate(lifetime: "send" | "menu") {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createGhlConnectLinkAction(locationId, lifetime);
      setCreated(result);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create a connect link.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeGhlConnectLinksAction(locationId);
      setConfirmingRevoke(false);
      // Every link this button just killed (including, deliberately, one
      // shown above from an EARLIER click in this same session) is now dead
      // — clearing it here means the panel can never keep displaying a
      // "Copy" button for a URL that no longer works.
      setCreated(null);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Could not revoke links.");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-raised px-3 py-3">
      <p className="text-xs font-medium text-ink">Connect link</p>
      <p className="mt-1 text-xs text-ink-faint">
        Send {label} a link they open themselves to scan the QR from their own device — no portal login needed.
      </p>

      {created ? (
        <div className="mt-2 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-ink-faint" title={created.url}>
              {created.url}
            </code>
            <CopyButton value={created.url} />
          </div>
          <p className="mt-2 text-ink-faint">
            {created.lifetime === "menu"
              ? `For ${label}'s GHL sidebar — expires ${formatDate(new Date(created.expiresAtMs).toISOString())}.`
              : `To send to ${label} — expires ${formatDate(new Date(created.expiresAtMs).toISOString())}.`}
          </p>
          <p className="mt-1 font-medium text-loss">
            Treat this like a password reset link for {label}&rsquo;s WhatsApp — send it only to the client, and
            revoke it if it goes astray.
          </p>
          {/*
            adversarial review lens 5, finding 2 — MAJOR, fixed. Installing
            this URL as a custom menu link in the client's own GHL sidebar
            (rather than sending it as a message) renders it inside GHL's
            iframe by default — fine on GHL's own hosts, but a client on a
            whitelabel GHL domain not in `GHL_EMBED_FRAME_ANCESTORS` gets a
            blank pane and no on-screen explanation (see next.config.ts's
            `/connect/:path*` header comment and
            docs/GHL-PROVIDER-CLIENT-MIGRATION.md's install step). Surfaced
            here, next to the URL that gets copied straight into a menu-link
            field, because that is the moment this actually matters — nobody
            reads this warning after the blank page already happened.
          */}
          <p className="mt-2 text-ink-faint">
            Installing this as a custom menu link in {label}&rsquo;s GHL sidebar? If their agency serves GHL from a
            whitelabel domain, tick &ldquo;open in new tab&rdquo; when you add it — otherwise it may render blank.
          </p>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => handleCreate("send")} disabled={creating}>
          {creating ? "Creating…" : "Link to send (7 days)"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => handleCreate("menu")} disabled={creating}>
          {creating ? "Creating…" : "Link for their GHL menu (1 year)"}
        </Button>

        {confirmingRevoke ? (
          <>
            <span className="text-xs text-ink-faint">
              Kills every link ever issued for {label} — nothing else. Their WhatsApp session, other clients, and
              this account are all untouched.
            </span>
            <Button size="sm" variant="danger" onClick={handleRevoke} disabled={revoking}>
              {revoking ? "Revoking…" : "Confirm revoke"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingRevoke(false)} disabled={revoking}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmingRevoke(true)}>
            Revoke all links
          </Button>
        )}
      </div>

      {createError ? <p className="mt-2 text-xs text-loss">{createError}</p> : null}
      {revokeError ? <p className="mt-2 text-xs text-loss">{revokeError}</p> : null}
    </div>
  );
}

/** The `/connect/[token]` page's own ground colour (`--color-bg`, src/app/globals.css) — what the live preview below has to sit against for the contrast warning to mean anything. Same value `BrandingCard`'s own `PAGE_BG` uses for the booking pages, which share the same dark-ground design system. */
const CONNECT_PAGE_BG = "#0B0E14";

/**
 * W-CONNECT-BRAND (migration 0076) — the logo-upload + accent-colour editor
 * for one GHL location's `/connect/[token]` page, inside the same "Manage"
 * expansion as `GhlConnectLinkManager` above.
 *
 * REUSES `src/lib/brand.ts`'s pure machinery (`MAX_LOGO_BYTES`,
 * `SAFE_LOGO_TYPES`, `normaliseHex`, `isNearlyInvisibleOn`) and
 * `ConnectBrandHeader` for the live preview — the SAME component the real
 * connect page renders (see that component's own header, "ONE COMPONENT, TWO
 * SURFACES"), not a hand-drawn approximation of it. Deliberately does NOT
 * reuse `BrandingCard` (src/components/branding/BrandingCard.tsx) wholesale:
 * that component's preview is hard-coded booking-page copy ("Book a call
 * with…", "Book this slot"), which would show Charlie a preview of a page
 * this feature doesn't render — the theming PRIMITIVES are shared (per this
 * task's brief, "do not invent a second theming path"), the presentation
 * is this feature's own, same as `BrandingCard` itself is one presentation
 * over those same primitives for a different page.
 *
 * LOCAL PREVIEW BEFORE SAVE, same convention as `BrandingCard`'s own
 * `previewUrl`: a freshly-picked file is shown via `URL.createObjectURL`
 * immediately, before the upload round trip completes — `resolveLogoPath`
 * (src/lib/brand.ts) passes a `blob:` URL through unchanged for exactly this
 * case.
 */
function GhlAccountBrandingManager({
  locationId,
  label,
  initialLogoPath,
  initialAccentColor,
}: {
  locationId: string;
  label: string;
  initialLogoPath: string | null;
  initialAccentColor: string | null;
}) {
  const [savedLogoPath, setSavedLogoPath] = useState(initialLogoPath);
  const [savedColor, setSavedColor] = useState(normaliseHex(initialAccentColor));

  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [colour, setColour] = useState(normaliseHex(initialAccentColor) ?? "");

  const [pending, setPending] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const normalisedColour = normaliseHex(colour);
  /** `colour` is non-empty but not a colour we can parse — say so rather than silently dropping it on save. */
  const colourInvalid = colour.trim() !== "" && normalisedColour === null;
  const dirty = pickedFile !== null || removeLogo || (normalisedColour ?? null) !== savedColor;

  const effectiveLogoPath = removeLogo ? null : (previewUrl ?? savedLogoPath);
  const tooDark = normalisedColour !== null && isNearlyInvisibleOn(normalisedColour, CONNECT_PAGE_BG);

  function handlePick(file: File | null) {
    setError(null);
    setJustSaved(false);
    if (!file) return;

    // Mirror the server's own limit so the obvious mistake is caught
    // instantly. CONVENIENCE ONLY — `saveGhlAccountBrandingAction` (via
    // `storeGhlAccountLogo`) re-checks size and sniffs the real bytes
    // server-side; never remove that check in favour of this one.
    if (file.size > MAX_LOGO_BYTES) {
      setError(`That logo is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_LOGO_BYTES / 1024 / 1024} MB.`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    setPickedFile(file);
    setRemoveLogo(false);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
  }

  function handleRemoveLogo() {
    setPickedFile(null);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setRemoveLogo(true);
    setJustSaved(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleColourChange(next: string) {
    setColour(next);
    setJustSaved(false);
    setError(null);
  }

  async function handleSave() {
    setError(null);
    setPending(true);
    const fd = new FormData();
    if (pickedFile) fd.set("logo", pickedFile);
    if (removeLogo) fd.set("removeLogo", "1");
    fd.set("accentColor", normalisedColour ?? "");

    try {
      const result: SaveGhlAccountBrandingResult = await saveGhlAccountBrandingAction(locationId, fd);
      if (result.error) {
        setError(result.error);
        return;
      }
      // Adopt the server's answer as the new baseline and drop the pending
      // state, same "render the server's echo, not the optimistic guess"
      // convention as `BrandingCard`/`TimeZoneCard`.
      setSavedLogoPath(result.brandLogoPath);
      setSavedColor(result.brandAccentColor);
      setColour(result.brandAccentColor ?? "");
      setPickedFile(null);
      setRemoveLogo(false);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      setJustSaved(true);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save — please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-raised px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink">Branding</p>
          <p className="mt-1 text-xs text-ink-faint">Logo and accent colour {label} sees on their own connect page.</p>
        </div>
        {pending ? (
          <span className="text-xs text-ink-faint">Saving…</span>
        ) : justSaved && !dirty ? (
          <span className="text-xs text-win">Saved ✓</span>
        ) : null}
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        {/* ---------------- Controls ---------------- */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Logo (optional)</span>
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept={SAFE_LOGO_TYPES.join(",")}
                onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
                className="block w-full max-w-xs text-xs text-ink-dim file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-card file:px-3 file:py-2 file:text-xs file:font-medium file:text-ink hover:file:brightness-110"
              />
              {effectiveLogoPath ? (
                <button
                  type="button"
                  onClick={handleRemoveLogo}
                  className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
                >
                  Remove
                </button>
              ) : null}
            </div>
            <p className="text-[11px] text-ink-faint">
              PNG, JPG or WebP, up to {MAX_LOGO_BYTES / 1024 / 1024} MB. With no logo, {label} still gets a monogram
              in their own accent colour — go live on the colour now and add the logo whenever it arrives.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Accent colour</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="color"
                aria-label="Accent colour"
                value={normalisedColour ?? "#17BEB4"}
                onChange={(e) => handleColourChange(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-lg border bg-card p-1"
              />
              <input
                type="text"
                aria-label="Accent colour hex"
                value={colour}
                onChange={(e) => handleColourChange(e.target.value)}
                placeholder="#17BEB4"
                spellCheck={false}
                className="w-32 rounded-lg border bg-card px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint outline-none transition focus:border-accent"
              />
              {colour.trim() !== "" ? (
                <button
                  type="button"
                  onClick={() => handleColourChange("")}
                  className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
                >
                  Use default
                </button>
              ) : null}
            </div>
            {colourInvalid ? (
              <p className="text-[11px] text-loss">
                That isn&apos;t a colour we recognise — use a hex value like <span className="font-mono">#17BEB4</span>.
              </p>
            ) : tooDark ? (
              <p className="text-[11px] text-warn">
                That colour is very close to the page background, so it will barely show up.
              </p>
            ) : (
              <p className="text-[11px] text-ink-faint">
                Leave blank for the default teal. Text switches between black and white automatically so it stays
                readable.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void handleSave()} disabled={pending || !dirty || colourInvalid}>
              {pending ? "Saving…" : "Save branding"}
            </Button>
            {error ? <p className="text-xs text-loss">{error}</p> : null}
          </div>
        </div>

        {/* ---------------- Live preview ----------------
            Real connect-page ground, the SAME `ConnectBrandHeader` the live
            page renders — see this component's own header for why this is
            load-bearing rather than decorative. `aria-hidden`: a picture of
            another page, not a control. */}
        <div
          aria-hidden
          style={{ backgroundColor: CONNECT_PAGE_BG }}
          className="flex flex-col justify-center gap-2 rounded-lg border border-border px-4 py-6"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            {label}&rsquo;s connect page
          </span>
          <ConnectBrandHeader label={label} logoPath={effectiveLogoPath} accentColor={normalisedColour} />
        </div>
      </div>
    </div>
  );
}
