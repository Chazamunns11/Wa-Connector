"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Chip, type ChipTone } from "@/components/ui/Chip";
import { WhatsappConnectionPanel, type WhatsappPanelCopy } from "@/components/whatsapp/WhatsappConnectionPanel";
import { ConnectBrandHeader } from "@/components/whatsapp/ConnectBrandHeader";
import { brandStyle, inkFor, normaliseHex } from "@/lib/brand";
import { relativeTime } from "@/lib/format";
import type { GhlEmbedWhatsappSummary, WhatsappSessionStatus } from "@/lib/types";
import type { BridgeOkResult, BridgeSessionResult } from "@/lib/whatsapp-bridge";

/**
 * The connect-link feature's client half (docs/GHL-PROVIDER-CLIENT-MIGRATION.md,
 * src/lib/ghl-connect-link.ts) — structurally `CrmEmbedClient.tsx`
 * (src/app/embed/crm/CrmEmbedClient.tsx) MINUS THE POSTMESSAGE HANDSHAKE:
 * there is no GHL parent frame here, so the "prove who this session is for"
 * step is a plain `POST /api/connect/session` with the link `token` this
 * component received as a prop from `/connect/[token]/page.tsx`'s own
 * server-side verification, instead of a `REQUEST_USER_DATA` round trip. Read
 * that file's header first — every rationale that ISN'T about the postMessage
 * mechanics applies here unchanged (token-lifecycle-in-a-ref, transparent
 * 401 re-auth, the summary-only refresh split), and is restated only where
 * it differs.
 *
 * TOKEN LIFECYCLE — TWO TOKENS, HELD DIFFERENTLY, SAME "NEVER PERSISTED"
 * RULE. The LINK token (`token` prop) is already public — it is the URL
 * itself, and this component never needs to protect it beyond not logging
 * it. The SESSION token this component gets back from `/api/connect/session`
 * is the one that actually matters: it lives in `sessionTokenRef` ONLY, for
 * the lifetime of this component instance — never a cookie, never
 * `localStorage`, never appended to a URL — mirroring
 * `CrmEmbedClient.tsx`'s identical rule for its own embed token, and the QR
 * string's own "authenticated response straight into component state, never
 * persisted" rule (`WhatsappConnectionPanel.tsx`'s header). A page reload
 * re-runs the exchange from nothing (the link token in the URL is stable and
 * re-usable within its 7-day life; only the session token is single-tab,
 * ephemeral).
 *
 * TRANSPARENT RE-AUTH ON 401: `callConnectApi` below re-runs the session
 * exchange and retries the ONE call that got the 401, exactly once — same
 * shape as `CrmEmbedClient.tsx`'s `callEmbedWhatsappApi`, same reasoning (a
 * client mid-linking attempt should never see a raw 15-minute session-token
 * boundary).
 *
 * `WhatsappConnectionPanel` IS RENDERED UNMODIFIED — every requirement this
 * feature has beyond what that shared component already does (the
 * link-privacy banner, the "use a different device to scan" instruction) is
 * rendered by THIS component, around the panel, never inside it.
 *
 * W-CONNECT-BRAND (migration 0076) layers per-client branding on TOP of that
 * same rule — the header row, the "Connect your business WhatsApp" heading,
 * the connected-state hero, and the footer are all THIS component's own
 * markup, driven by `brandLogoPath`/`brandAccentColor`. The accent is applied
 * as CSS custom properties (`brandStyle()`, src/lib/brand.ts) on this
 * component's own OUTERMOST wrapper — which is what lets it theme the
 * panel's own buttons (`Button`'s primary variant is `bg-accent
 * text-accent-ink`, src/components/ui/Button.tsx) via ordinary CSS cascade,
 * with NO prop threaded into `WhatsappConnectionPanel` and no edit to it. The
 * one thing this wrapper deliberately does NOT attempt: reproducing the
 * panel's own connected-state text/Log-out button in a bigger font. That
 * would require touching `WhatsappConnectionPanel.tsx`'s `SteadyView`, which
 * this feature's brief rules out — see `ConnectedHero` below for the
 * resulting, deliberate trade-off.
 *
 * THE CONNECTED STATE RENDERS TWICE (adversarial review lens 5, finding 12
 * — fixed). The trade-off just above USED TO mean exactly that: once
 * connected, `ConnectedHero`'s phone number/messages-today/last-connected
 * tiles rendered directly ABOVE the panel's own `SteadyView`, which repeats
 * status/phone number/messages-today/last-connected within ~200px — the
 * SAME facts, twice, worded slightly differently each time (the hero's
 * second tile just said "Connected", ambiguous against a relative-time value
 * until read carefully — see `ConnectedHero`'s own comment). Fixed by
 * keeping `ConnectedHero` as the one thing shown by default once connected,
 * and tucking the (still entirely unmodified) panel behind a native
 * `<details>` disclosure — "Manage this connection" — one click away for
 * whoever actually needs the "Log out" control the panel still exclusively
 * owns. Pre-connect, nothing about the panel's own rendering changes at all.
 * `buildConnectCopy`'s `cardSubtitle` also used to read as an instruction to
 * do the thing the reader had just finished doing once connected — see that
 * function's own comment for the fix.
 *
 * THAT RE-MINT IS SUMMARY-ONLY, DELIBERATELY UNABLE TO TOUCH `phase` — same
 * bug class `CrmEmbedClient.tsx`'s own header documents (adversarial review
 * lens 4, finding 9 on that file): a re-exchange fired fire-and-forget right
 * after a successful connect must never be able to replace a just-shown
 * "Connected" panel with an error card over a transient network blip.
 * `runExchange`/`refreshSummaryOnly` below split "do the network round trip"
 * from "what to do with the result", identical structure to
 * `CrmEmbedClient.tsx`'s `runHandshake`/`refreshSummaryOnly`.
 */

const GENERIC_ERROR_MESSAGE = "This link isn't available right now — try reloading the page.";

type Phase = "loading" | "error" | "disabled" | "ready";

/**
 * The header row's status pill (`ConnectBrandHeader`'s `action` slot) — a
 * SEPARATE small map from `WhatsappConnectionPanel.tsx`'s own private
 * `STATUS_CHIP`, deliberately duplicated rather than imported: that constant
 * is module-private inside a file this feature must not modify (see this
 * file's header, "`WhatsappConnectionPanel` IS RENDERED UNMODIFIED"), and a
 * third small per-wrapper status-pill map is this codebase's own established
 * convention for exactly this situation — `WhatsappConnectionsPanel.tsx`'s
 * `WhatsappStatusPill` keeps an identical second copy for the same reason.
 * Same labels as the panel's own chip, so the two pills a reader could see at
 * once (this header's, and — once connected — the panel's internal state
 * text) never disagree.
 */
const CONNECT_STATUS_CHIP: Record<WhatsappSessionStatus, { tone: ChipTone; label: string }> = {
  connected: { tone: "win", label: "Connected" },
  waiting_qr: { tone: "warn", label: "Waiting for QR scan" },
  disconnected: { tone: "warn", label: "Disconnected" },
  logged_out: { tone: "warn", label: "Logged out" },
  banned: { tone: "loss", label: "Banned" },
};

function connectStatusChip(status: WhatsappSessionStatus | null): { tone: ChipTone; label: string } {
  return status ? CONNECT_STATUS_CHIP[status] : { tone: "muted", label: "Not connected" };
}

/** The exact shape `POST /api/connect/session` returns — see that route's own JSDoc for each `state`/failure `code`. `summary` is `GhlEmbedWhatsappSummary`, never carries a tenant id (src/lib/types.ts). */
interface ConnectSessionResponse {
  ok: boolean;
  state?: "ok" | "disabled";
  token?: string;
  label?: string;
  summary?: GhlEmbedWhatsappSummary | null;
  bridgeReachable?: boolean | null;
  message?: string;
  code?: string;
  /** Present only on a `code: "rate_limited"` response — see `runExchange`'s own comment, adversarial review lens 5, finding 7c. */
  retryAfterSeconds?: number;
}

/** Discriminated result of one full exchange round trip, with NO component state touched — see this file's header, "THAT RE-MINT IS SUMMARY-ONLY". `refreshSession` and `refreshSummaryOnly` below are the two callers that each decide, independently, what a given outcome should do to `phase`. */
type ExchangeOutcome =
  | { kind: "ok"; token: string; summary: GhlEmbedWhatsappSummary | null; label: string | null; bridgeReachable: boolean | null }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

/** The `POST /api/connect/session` round trip, pure — see `ExchangeOutcome`'s own header. Takes the LINK token (the stable, 7-day-lived one) every time — this is what makes a re-exchange after a session-token 401 possible without holding two separate "which token do I re-send" branches. */
async function runExchange(linkToken: string): Promise<ExchangeOutcome> {
  let json: ConnectSessionResponse | null;
  try {
    const res = await fetch("/api/connect/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: linkToken }),
    });
    json = (await res.json().catch(() => null)) as ConnectSessionResponse | null;
    if (!res.ok) {
      // adversarial review lens 5, finding 7c — MINOR, fixed. `res.json()`
      // already carries `retryAfterSeconds` on a `rate_limited` response
      // (`checkConnectSessionThrottle`'s own shape, src/lib/connect-throttle.ts),
      // but this used to render only the server's fixed "Too many attempts —
      // try again shortly." with no number in it — a client with no idea
      // whether "shortly" means ten seconds or ten minutes. Fold the real
      // number into the message whenever the server sent one.
      const baseMessage = typeof json?.message === "string" ? json.message : GENERIC_ERROR_MESSAGE;
      const message =
        json?.code === "rate_limited" && typeof json.retryAfterSeconds === "number"
          ? `${baseMessage} (try again in ${json.retryAfterSeconds}s)`
          : baseMessage;
      return { kind: "error", message };
    }
  } catch {
    return { kind: "error", message: "Couldn't reach the server — check your connection and try again." };
  }

  if (!json || !json.ok) return { kind: "error", message: GENERIC_ERROR_MESSAGE };
  if (json.state === "disabled") return { kind: "disabled" };
  if (json.state !== "ok" || typeof json.token !== "string") return { kind: "error", message: GENERIC_ERROR_MESSAGE };

  return {
    kind: "ok",
    token: json.token,
    summary: json.summary ?? null,
    label: json.label ?? null,
    bridgeReachable: typeof json.bridgeReachable === "boolean" ? json.bridgeReachable : null,
  };
}

export interface ConnectLinkClientProps {
  /** The LINK token from the URL — already public (it IS the URL); this component's own job is exchanging it for a session token, never protecting it further. */
  token: string;
  /** Server-verified display label (`/connect/[token]/page.tsx`'s own fresh account read) — shown immediately, before the client-side exchange even completes, so the page never opens on a blank "Connecting…" with no indication of whose WhatsApp this is. */
  label: string;
  /**
   * `nowMs()` from `src/lib/data`, computed ONCE by the server page at
   * render time — a plain prop, never `Date.now()` called inline during this
   * component's own render (React's purity rule: components must be
   * idempotent). Matches `CrmEmbedClient.tsx`'s identical `nowMs` prop; this
   * page never calls `router.refresh()`, so — like the embed's own page — a
   * relative-time string here is anchored to page load, not a live clock.
   */
  nowMs: number;
  /** `GhlAccount.brandLogoPath` (migration 0076) — a bucket path, or `null` for the monogram fallback. See `ConnectBrandHeader`'s own JSDoc for how this resolves. */
  brandLogoPath: string | null;
  /** `GhlAccount.brandAccentColor` (migration 0076) — `#RRGGBB`, or `null` for the default FitClosers teal. */
  brandAccentColor: string | null;
}

export function ConnectLinkClient({
  token,
  label: initialLabel,
  nowMs,
  brandLogoPath,
  brandAccentColor,
}: ConnectLinkClientProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string>(GENERIC_ERROR_MESSAGE);
  const [summary, setSummary] = useState<GhlEmbedWhatsappSummary | null>(null);
  const [label, setLabel] = useState<string>(initialLabel);
  const [bridgeReachable, setBridgeReachable] = useState<boolean | null>(null);

  // The session token — a ref, not state, same rationale as
  // `CrmEmbedClient.tsx`'s `tokenRef`: every closure below reads
  // `sessionTokenRef.current` synchronously at call time, and updating it
  // must never itself trigger a re-render.
  const sessionTokenRef = useRef<string | null>(null);

  /**
   * Run the full exchange, update every piece of state a fresh result can
   * change, and return the fresh SESSION token (or `null` on any failure —
   * every failure path sets `phase` to the right terminal state before
   * returning). Used for the initial load AND the transparent 401 retry —
   * NOT for the poll-driven summary refresh; see `refreshSummaryOnly` below.
   */
  const refreshSession = useCallback(async (): Promise<string | null> => {
    const outcome = await runExchange(token);
    if (outcome.kind === "error") {
      setErrorMessage(outcome.message);
      setPhase("error");
      return null;
    }
    if (outcome.kind === "disabled") {
      setPhase("disabled");
      return null;
    }
    sessionTokenRef.current = outcome.token;
    setSummary(outcome.summary);
    if (outcome.label) setLabel(outcome.label);
    setBridgeReachable(outcome.bridgeReachable);
    setPhase("ready");
    return outcome.token;
  }, [token]);

  /**
   * The fire-and-forget, phase-blind counterpart to `refreshSession` — see
   * this file's header, "THAT RE-MINT IS SUMMARY-ONLY". On success, updates
   * the session token and every display-only field a fresh exchange can
   * change; on ANY failure, silently does nothing — in particular, never
   * calls `setPhase`, exactly mirroring `CrmEmbedClient.tsx`'s identical
   * function.
   */
  const refreshSummaryOnly = useCallback(async (): Promise<void> => {
    const outcome = await runExchange(token);
    if (outcome.kind !== "ok") return;
    sessionTokenRef.current = outcome.token;
    setSummary(outcome.summary);
    if (outcome.label) setLabel(outcome.label);
    setBridgeReachable(outcome.bridgeReachable);
  }, [token]);

  // Kick off the exchange once on mount — this page only ever renders this
  // component after its own server-side verification already passed (see
  // page.tsx's header), but that verification is re-done here from scratch
  // via the real `/api/connect/session` call, never trusted from the server
  // render (same "never trust a prior check" posture `CrmEmbedClient.tsx`
  // holds toward the embed handshake).
  useEffect(() => {
    async function run() {
      await refreshSession();
    }
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; `refreshSession` is stable across the token prop's lifetime (a `/connect/[token]` page never changes its own token without a full navigation).
  }, []);

  /**
   * One authenticated POST to an `/api/connect/whatsapp/*` route, with the
   * transparent re-exchange-and-retry-once on a 401 — identical shape to
   * `CrmEmbedClient.tsx`'s `callEmbedWhatsappApi`.
   */
  const callConnectApi = useCallback(
    async (path: string): Promise<Record<string, unknown>> => {
      let sessionToken = sessionTokenRef.current;
      if (!sessionToken) {
        sessionToken = await refreshSession();
        if (!sessionToken) throw new Error(GENERIC_ERROR_MESSAGE);
      }

      const res = await fetch(path, { method: "POST", headers: { authorization: `Bearer ${sessionToken}` } });
      if (res.status === 401) {
        const fresh = await refreshSession();
        if (!fresh) throw new Error("This session has expired — reload this page to reconnect.");
        const retryRes = await fetch(path, { method: "POST", headers: { authorization: `Bearer ${fresh}` } });
        return (await retryRes.json()) as Record<string, unknown>;
      }
      return (await res.json()) as Record<string, unknown>;
    },
    [refreshSession]
  );

  const connect = useCallback(
    () => callConnectApi("/api/connect/whatsapp/connect") as Promise<BridgeSessionResult>,
    [callConnectApi]
  );

  const logout = useCallback(
    () => callConnectApi("/api/connect/whatsapp/logout") as Promise<BridgeOkResult>,
    [callConnectApi]
  );

  const poll = useCallback(async (): Promise<BridgeSessionResult> => {
    const result = (await callConnectApi("/api/connect/whatsapp/status")) as BridgeSessionResult;
    if (result.ok && (result.session.status === "connected" || result.session.status === "logged_out" || result.session.status === "banned")) {
      // See this file's header, "WRAPPER RESPONSIBILITIES" (restated from
      // `CrmEmbedClient.tsx`) — the panel's own `router.refresh()` is a no-op
      // here (this page's `summary` came from a client-side fetch, not a
      // server component render), so this is what actually updates `summary`
      // for the SteadyView the panel renders next. `refreshSummaryOnly`, NOT
      // `refreshSession` — must never flip `phase` to `"error"` out from
      // under a panel that just showed "Connected".
      void refreshSummaryOnly();
    }
    return result;
  }, [callConnectApi, refreshSummaryOnly]);

  // ---- Render ----

  // W-CONNECT-BRAND — resolved ONCE per render, shared by every phase below
  // so a client sees their own logo/colour even on the "Connecting…"/error/
  // disabled cards, not just the fully-loaded panel. `normaliseHex` is what
  // makes this safe against a stray unparseable value ever reaching a style
  // attribute (defence in depth — `saveGhlAccountBrandingAction` and
  // `updateGhlAccountBrandingService` already refuse to persist one, but this
  // component re-normalises anyway rather than trusting the prop).
  // `accentInk` is COMPUTED, never assumed — see src/lib/brand.ts's header
  // for why a stored ink would be a live contrast bug waiting to happen.
  const accentColor = normaliseHex(brandAccentColor);
  const accentInk = accentColor ? inkFor(accentColor) : null;
  // `businessName: null` — this GHL connect page is explicitly OUT OF SCOPE
  // for the 5 Aug 2026 de-white-label change (see src/app/book/branding.tsx's
  // file header, "what must NOT change": `connect/[token]` keeps FitClosers
  // branding). It has its own separate name-fallback system entirely
  // (`monogramFor`/`ConnectBrandHeader`, above) that doesn't read this field
  // — `brandStyle()` below only ever looks at `accentColor`/`accentInk` — so
  // this is a type-shape fix for `ResolvedBranding` gaining a required field,
  // not a behaviour change on this page.
  // W32 adds `logoBackdrop` to the same required-field shape. Identically
  // inert here: this page renders no `logoUrl` at all, and `brandStyle()`
  // reads only the accent pair — same type-shape fix, same non-change.
  const wrapperStyle = brandStyle({
    logoUrl: null,
    accentColor,
    accentInk,
    businessName: null,
    logoBackdrop: "none",
  });
  const header = (action?: React.ReactNode) => (
    <ConnectBrandHeader label={label} logoPath={brandLogoPath} accentColor={accentColor} action={action} />
  );

  if (phase === "loading") {
    return (
      <div style={wrapperStyle} className="flex flex-col gap-4">
        {header()}
        <Card>
          <CardHeader title="WhatsApp" />
          <p className="text-sm text-ink-faint">Connecting…</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div style={wrapperStyle} className="flex flex-col gap-4">
        {header()}
        <Card>
          <CardHeader title="WhatsApp" />
          <p className="text-sm text-loss">{errorMessage}</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => void refreshSession()}>
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  if (phase === "disabled") {
    return (
      <div style={wrapperStyle} className="flex flex-col gap-4">
        {header()}
        <Card>
          <CardHeader title="WhatsApp" />
          <p className="text-sm text-ink-faint">
            An operator has disabled WhatsApp connecting for this business right now. Get in touch with whoever sent
            you this link if you think that&rsquo;s a mistake.
          </p>
        </Card>
      </div>
    );
  }

  // phase === "ready"
  const isConnected = summary !== null && summary.status === "connected";
  const statusChip = connectStatusChip(summary?.status ?? null);

  return (
    <div style={wrapperStyle} className="flex flex-col gap-4">
      {header(<Chip tone={statusChip.tone}>{statusChip.label}</Chip>)}

      {/*
        MANDATORY LINE 1 (page-level banner) — this feature's own brief: the
        LINK ITSELF is private, same severity as a password reset link. This
        renders regardless of connection state, because the thing it warns
        about (forwarding the URL this page is already open at) is true the
        entire time this tab is open, not just while a QR is on screen.
      */}
      <div className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2.5 text-xs text-ink">
        <p className="font-medium">This link is private to you — don&rsquo;t forward or share it.</p>
        <p className="mt-1 text-ink-faint">
          Anyone who opens it can connect a phone to {label}&rsquo;s WhatsApp and send messages as your business,
          exactly like a password reset link. If you think it&rsquo;s gone somewhere it shouldn&rsquo;t, tell whoever
          sent it to you so they can revoke it.
        </p>
      </div>

      {isConnected && summary ? (
        // W-CONNECT-BRAND — the mockup's "phone number large, plus two small
        // stat tiles" connected-state hero. See this file's header for why
        // this sits ALONGSIDE the panel's own (smaller, plainer) connected
        // view rather than replacing it: reproducing this inside
        // `WhatsappConnectionPanel.tsx`'s `SteadyView` would mean editing
        // that file, which this feature's brief rules out. The panel below
        // still owns the actual "Log out" control — this block is decoration
        // built from the SAME `summary` state, never a second source of
        // truth for it.
        <ConnectedHero summary={summary} nowMs={nowMs} />
      ) : (
        <>
          <h2 className="font-display text-lg font-bold text-ink">Connect your business WhatsApp</h2>

          {/*
            MANDATORY LINE 2 (above the connect button) — the single most
            likely real-world failure of this feature: the link usually
            arrives ON the business phone, and that phone cannot scan its own
            screen. Shown only pre-connect (the mockup's own ordering) — once
            the business is actually connected, "open this on a second
            device" no longer applies to anything on screen.
          */}
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs text-ink">
            <p className="font-medium">Open this link on a computer, tablet, or a second phone.</p>
            <p className="mt-1 text-ink-faint">
              You&rsquo;ll then scan the code with your business phone — the phone that runs {label}&rsquo;s
              WhatsApp. A phone can&rsquo;t scan its own screen, so if you&rsquo;re reading this on that same phone,
              open the link somewhere else first.
            </p>
          </div>
        </>
      )}

      {/*
        adversarial review lens 5, finding 12 — fixed. Once connected, this
        panel and `ConnectedHero` above it used to BOTH render the full
        status/phone-number/messages-today/last-connected picture within
        ~200px of each other — a client saw everything twice. `WhatsappConnectionPanel`
        itself is a hard constraint not to modify (its `SteadyView` is the
        product of two prior adversarial review passes — see this file's own
        header), so the fix collapses it behind a native `<details>`
        disclosure instead: `ConnectedHero` stays the one thing shown by
        default once connected, and the panel (which still owns the only
        "Log out" control that exists) is one click away for anyone who needs
        it. PRE-CONNECT, NOTHING CHANGES — same component, same props, always
        rendered directly, because the panel IS the primary content until
        there's something to summarise above it.
      */}
      {isConnected ? (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-faint">
            Manage this connection
          </summary>
          <div className="px-3 pb-3">
            <WhatsappConnectionPanel
              copy={buildConnectCopy(label, isConnected)}
              summary={summary ? { ...summary, coachId: "" } : null}
              bridgeConfigured={true}
              bridgeReachable={bridgeReachable}
              nowMs={nowMs}
              connect={connect}
              poll={poll}
              logout={logout}
            />
          </div>
        </details>
      ) : (
        <WhatsappConnectionPanel
          copy={buildConnectCopy(label, isConnected)}
          summary={summary ? { ...summary, coachId: "" } : null}
          // Always true — `/connect/[token]/page.tsx` already gates on
          // `isWhatsappBridgeConfigured()` before this component is ever
          // rendered at all (unlike the embed, which renders its own
          // "not switched on" card client-side for a still-configurable-mid-
          // session reason — see that component's props).
          bridgeConfigured={true}
          bridgeReachable={bridgeReachable}
          nowMs={nowMs}
          connect={connect}
          poll={poll}
          logout={logout}
        />
      )}

      {/* Quiet reseller attribution — the mockup's footer line. */}
      <p className="text-center text-[11px] text-ink-faint">Powered by WA4GHL</p>
    </div>
  );
}

/**
 * W-CONNECT-BRAND — the connected-state hero: the linked phone number in a
 * large display size, plus two compact stat tiles (messages sent today, how
 * long the number has been connected). See `ConnectLinkClient`'s own header
 * for why this exists ALONGSIDE the panel's built-in connected view rather
 * than in place of it.
 */
function ConnectedHero({ summary, nowMs }: { summary: GhlEmbedWhatsappSummary; nowMs: number }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-raised px-4 py-6 text-center">
      <p className="font-mono-nums text-2xl font-semibold text-ink">{summary.phoneNumber ?? "—"}</p>
      <div className="grid w-full max-w-xs grid-cols-2 gap-2">
        <StatTile label="Messages today" value={String(summary.sentToday)} />
        {/*
          adversarial review lens 5, finding 12 — fixed. This tile's label
          used to just read "Connected", pairing with a relative-time value
          ("2 days ago") to produce "Connected / 2 days ago" — ambiguous
          until a reader worked out it meant "connected 2 days ago", not "has
          been connected for 2 days" or some other reading. "Last connected"
          removes the ambiguity outright and matches the wording
          `WhatsappConnectionPanel.tsx`'s own `SteadyView` already uses for
          the identical fact ("Last connected {relativeTime}"), so the two
          panels a reader can see on this page never describe the same value
          two different ways.
        */}
        <StatTile label="Last connected" value={summary.lastConnectedAt ? relativeTime(summary.lastConnectedAt, nowMs) : "—"} />
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

/**
 * Client-audience copy — this reader IS the business owner (or whoever they
 * handed the link to), so this speaks to them directly, same voice as
 * `CrmEmbedClient.tsx`'s `buildEmbedCopy`. `qrWarning` is the load-bearing
 * line every QR surface in this codebase must carry (restated once more,
 * this feature's own terms): it must say, before anyone scans anything, that
 * whoever scans the code can send WhatsApp messages as this business.
 */
function buildConnectCopy(label: string, isConnected: boolean): WhatsappPanelCopy {
  const businessLabel = label && !label.startsWith("GHL location ") ? label : "your business";
  const possessive = businessLabel === "your business" ? "your business's" : `${businessLabel}'s`;
  return {
    cardTitle: "WhatsApp",
    // adversarial review lens 5, finding 12 — fixed. This used to be a fixed
    // "Link your business's WhatsApp so..." string regardless of state — read
    // under `ConnectedHero` (which only renders once already connected), it
    // sat there telling a client to do the thing they had just finished
    // doing, like an instruction they'd somehow missed. Now this panel is
    // also tucked behind the "Manage this connection" disclosure once
    // connected (this file's own header, "THE CONNECTED STATE RENDERS
    // TWICE"), so the subtitle a reader sees after expanding it should
    // describe what THIS panel is for at that point — managing an existing
    // connection — not repeat the pre-connect pitch.
    cardSubtitle: isConnected
      ? `Manage ${possessive} WhatsApp connection — reconnect or log out below.`
      : `Link ${possessive} WhatsApp so messages sent through this connection go out from your own number.`,
    emptyTitle: "No WhatsApp linked yet",
    emptyDescription: "Scan a QR code with the phone that runs your business WhatsApp — the same as WhatsApp Web.",
    connectLabel: "Connect WhatsApp",
    freshCodeLabel: "Get a new QR code",
    qrInstruction: "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.",
    qrWarning:
      "Only scan this yourself, on your own business phone. Whoever scans this code links their phone to your WhatsApp and can read and send messages as your business — treat it exactly like a password.",
    logoutConfirm: "This unlinks your number and wipes its stored credentials. Messages will stop going out over WhatsApp until it's reconnected.",
    disconnectedFallback: "Your WhatsApp isn't connected at the moment.",
    unlinkedMessage: "Your WhatsApp was unlinked. Reconnecting is safe whenever you're ready.",
    unknownAccountMessage: "This link isn't recognised right now — reload this page and try again.",
    bannedHelp:
      "This number was blocked by WhatsApp — reconnecting the same number is likely to fail. Get in touch with whoever sent you this link before trying anything else.",
    unauthorizedMessage: "The WhatsApp service rejected the connection — this needs to be checked by whoever sent you this link.",
  };
}
