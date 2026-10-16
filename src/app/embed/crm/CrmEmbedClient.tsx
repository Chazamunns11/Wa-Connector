"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { WhatsappConnectionPanel, type WhatsappPanelCopy } from "@/components/whatsapp/WhatsappConnectionPanel";
import type { GhlEmbedWhatsappSummary } from "@/lib/types";
import type { BridgeOkResult, BridgeSessionResult } from "@/lib/whatsapp-bridge";

/**
 * The GHL Custom Page embed's client half — the postMessage SSO handshake,
 * session-token lifecycle, and the wiring into the SAME shared
 * `WhatsappConnectionPanel` every other WhatsApp surface in this codebase
 * uses, UNMODIFIED. See `src/lib/ghl-embed.ts`'s file header for the SSO
 * protocol this implements and the full security rationale — restated only
 * where it changes what THIS file specifically must guarantee.
 *
 * THE HANDSHAKE, PER GHL'S OWN DOCS (confirmed 4 Aug 2026):
 *   1. `window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*")`.
 *   2. GHL replies with a `message` event carrying
 *      `{ message: "REQUEST_USER_DATA_RESPONSE", payload: <encrypted string> }`.
 *   3. That `payload` is POSTed to `/api/crm/embed/session`, which decrypts
 *      it server-side and — for a genuinely active FitClosers install on
 *      that location — mints a short-lived embed token.
 *
 * WHY NO `event.origin` CHECK: GHL is white-labelled, so an agency can serve
 * this Custom Page's PARENT frame from a domain of their own choosing —
 * there is no fixed origin to pin against ahead of time. The trust anchor is
 * NOT the origin; it is the server-side decryption with
 * `GHL_SSO_SHARED_SECRET` (`src/lib/ghl-embed.ts`) — only GHL itself can
 * produce a payload that decrypts to a well-formed user context. This
 * handler DOES still check the message's shape (the literal `message` field
 * and a non-empty string `payload`) so an unrelated `postMessage` from some
 * other script sharing the page can't be mistaken for GHL's reply — that is
 * a correctness filter, not a security boundary.
 *
 * A ~5s TIMEOUT with no reply — normal for a direct browser visit (nothing
 * is listening on `window.parent` outside a real GHL iframe) — shows
 * "This page only works inside HighLevel", the SAME message a direct visit
 * sees, deliberately: there is no way to distinguish "opened outside GHL"
 * from "opened inside GHL but GHL is slow to reply" from here, and treating
 * them identically means never showing a misleading error to someone
 * legitimately waiting on a slow parent frame.
 *
 * TOKEN LIFECYCLE — HELD IN COMPONENT STATE ONLY. The embed token this
 * component receives back from `/api/crm/embed/session` NEVER touches a
 * cookie, a URL, or `localStorage` — it lives in `tokenRef` for the lifetime
 * of this component instance and nowhere else, mirroring the QR string's own
 * "authenticated response straight into component state, never persisted"
 * rule (`WhatsappConnectionPanel`'s header). A reload of this iframe starts
 * the whole handshake over from nothing.
 *
 * TRANSPARENT RE-AUTH ON 401: `callEmbedWhatsappApi` below re-runs the WHOLE
 * handshake (a fresh `REQUEST_USER_DATA` round trip, then a fresh
 * `/api/crm/embed/session` mint) and retries the ONE call that got the 401,
 * exactly once. The person on the other end of this iframe never sees a
 * 15-minute token boundary — only a `WhatsappConnectionPanel` doing what it
 * always does (poll, connect, or log out).
 *
 * WRAPPER RESPONSIBILITIES THE PANEL ITSELF CANNOT DISCHARGE: the shared
 * panel calls `router.refresh()` on a successful connect/logout, which
 * re-fetches whatever Next.js page server component rendered it — that
 * mechanism has nothing to refresh here, since this page's `summary` prop
 * came from a client-side fetch, not a server component render. So `poll`
 * below independently re-runs the session mint (which returns a fresh
 * `summary` alongside the fresh token) whenever a poll resolves to a
 * TERMINAL bridge status (`connected`/`logged_out`/`banned`) — the exact
 * moments the DB-derived summary the panel's `SteadyView` reads is expected
 * to have just changed.
 *
 * THAT RE-MINT IS SUMMARY-ONLY, DELIBERATELY UNABLE TO TOUCH `phase`
 * (adversarial review lens 4, finding 9 — MINOR, fixed). `refreshSession`
 * (the full version, used by the initial handshake and the 401 retry) sets
 * `phase` to a terminal state — including `"handshake_error"` — on ANY
 * failure, even a bare transient network blip. Poll used to call THAT same
 * function fire-and-forget right after a successful connect; a re-mint
 * blip in that exact window replaced a just-shown "Connected" panel with
 * "This page only works inside HighLevel" — the worst possible moment for a
 * false negative. `runHandshake`/`refreshSummaryOnly` below split "do the
 * network round trip" from "what to do with the result" so the fire-and-forget
 * caller can update `summary`/`label`/the token on success and silently do
 * NOTHING on failure, never touching `phase` either way. The deliberate,
 * user-visible 401 re-handshake path (`callEmbedWhatsappApi` below) is
 * unaffected — it still goes through `refreshSession` and still can, and
 * should, show `handshake_error` when a session is genuinely unrecoverable.
 */

/** GHL's own reply must arrive within this window, or this is treated as "not inside HighLevel" — see this file's header. */
const HANDSHAKE_TIMEOUT_MS = 5000;

const NOT_IN_HIGHLEVEL_MESSAGE = "This page only works inside HighLevel.";

type Phase = "handshaking" | "handshake_error" | "not_installed" | "disabled" | "ready";

/**
 * The exact shape `POST /api/crm/embed/session` returns — see that route's
 * own JSDoc for each `state`. `summary` is `GhlEmbedWhatsappSummary`, NOT
 * `WhatsappSessionSummary` — the route never puts `coachId` on the wire at
 * all (adversarial review lens 4, finding 2; src/lib/types.ts). `bridgeReachable`
 * (adversarial review lens 4, finding 4) rides here now instead of arriving
 * as a page prop — see the route's own header, "THE BRIDGE-HEALTH PROBE
 * LIVES HERE".
 */
interface EmbedSessionResponse {
  ok: boolean;
  state?: "ok" | "not_installed" | "disabled";
  token?: string;
  label?: string;
  summary?: GhlEmbedWhatsappSummary | null;
  bridgeReachable?: boolean | null;
}

/**
 * Discriminated result of one full handshake + mint round trip, with NO
 * component state touched — see this file's header, "THAT RE-MINT IS
 * SUMMARY-ONLY". `refreshSession` and `refreshSummaryOnly` below are the two
 * callers that each decide, independently, what a given outcome should do to
 * `phase`.
 */
type HandshakeOutcome =
  | { kind: "ok"; token: string; summary: GhlEmbedWhatsappSummary | null; label: string | null; bridgeReachable: boolean | null }
  | { kind: "not_installed" }
  | { kind: "disabled" }
  | { kind: "error" };

/** The postMessage round trip + `/api/crm/embed/session` POST, pure — see `HandshakeOutcome`'s own header. */
async function runHandshake(): Promise<HandshakeOutcome> {
  let payload: string;
  try {
    payload = await requestGhlUserDataPayload();
  } catch {
    return { kind: "error" };
  }

  let json: EmbedSessionResponse | null;
  try {
    const res = await fetch("/api/crm/embed/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload }),
    });
    json = (await res.json().catch(() => null)) as EmbedSessionResponse | null;
    if (!res.ok || !json || !json.ok) {
      return { kind: "error" };
    }
  } catch {
    return { kind: "error" };
  }

  if (json.state === "not_installed") return { kind: "not_installed" };
  if (json.state === "disabled") return { kind: "disabled" };
  if (json.state !== "ok" || typeof json.token !== "string") return { kind: "error" };

  return {
    kind: "ok",
    token: json.token,
    summary: json.summary ?? null,
    label: json.label ?? null,
    bridgeReachable: typeof json.bridgeReachable === "boolean" ? json.bridgeReachable : null,
  };
}

/**
 * One `REQUEST_USER_DATA` round trip with GHL's parent frame. Resolves with
 * the RAW encrypted payload string; rejects (after `HANDSHAKE_TIMEOUT_MS`,
 * or immediately if `window.parent` doesn't exist — e.g. this were somehow
 * rendered top-level) if no valid reply arrives in time. Never touches
 * component state — pure browser messaging — so it can be called fresh on
 * every (re-)handshake without any stale-listener risk.
 */
function requestGhlUserDataPayload(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || window.parent === window) {
      reject(new Error("not_embedded"));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      reject(new Error("timeout"));
    }, HANDSHAKE_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      // Shape check only — deliberately no `event.origin` check. See this
      // file's header ("WHY NO event.origin CHECK") for why decryption is
      // the trust anchor, not the origin.
      const data = event.data as unknown;
      if (typeof data !== "object" || data === null) return;
      const message = (data as { message?: unknown }).message;
      if (message !== "REQUEST_USER_DATA_RESPONSE") return;
      const payload = (data as { payload?: unknown }).payload;
      if (typeof payload !== "string" || payload.length === 0) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(payload);
    }

    window.addEventListener("message", onMessage);
    window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
  });
}

export interface CrmEmbedClientProps {
  /** `isGhlEmbedConfigured()` — `GHL_SSO_SHARED_SECRET` OR `ONBOARD_STATE_SECRET` unset. */
  embedConfigured: boolean;
  bridgeConfigured: boolean;
  nowMs: number;
  /** `brandConfig().name` — read server-side (BRAND_NAME is not a NEXT_PUBLIC var) and passed down for the two "contact us" lines. */
  brandName: string;
}

export function CrmEmbedClient({ embedConfigured, bridgeConfigured, nowMs, brandName }: CrmEmbedClientProps) {
  const [phase, setPhase] = useState<Phase>("handshaking");
  const [summary, setSummary] = useState<GhlEmbedWhatsappSummary | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  // Adversarial review lens 4, finding 4 (MINOR) — this used to be a page
  // prop computed by an unauthenticated server-render `/health` probe; it
  // now arrives inside `POST /api/crm/embed/session`'s own response, so it
  // only ever reflects a probe that actually ran (see that route's header,
  // "THE BRIDGE-HEALTH PROBE LIVES HERE"). `null` until the first successful
  // handshake, same "nothing to show yet" meaning it always had.
  const [bridgeReachable, setBridgeReachable] = useState<boolean | null>(null);

  // The embed token itself — a ref, not state: every closure below reads
  // `tokenRef.current` synchronously at call time rather than closing over a
  // possibly-stale state value, and updating it must never by itself cause a
  // re-render (only `phase`/`summary`/`label`/`bridgeReachable` changes should).
  const tokenRef = useRef<string | null>(null);

  /**
   * Run the full handshake + mint, update every piece of state a fresh
   * result can change, and return the fresh token (or `null` on any
   * failure — every failure path sets `phase` to the right terminal state
   * before returning). Used for the initial load AND the transparent 401
   * retry — NOT for the poll-driven summary refresh any more; see
   * `refreshSummaryOnly` below and this file's header, "THAT RE-MINT IS
   * SUMMARY-ONLY" (adversarial review lens 4, finding 9).
   */
  const refreshSession = useCallback(async (): Promise<string | null> => {
    const outcome = await runHandshake();
    if (outcome.kind === "error") {
      setPhase("handshake_error");
      return null;
    }
    if (outcome.kind === "not_installed") {
      setPhase("not_installed");
      return null;
    }
    if (outcome.kind === "disabled") {
      setPhase("disabled");
      return null;
    }
    tokenRef.current = outcome.token;
    setSummary(outcome.summary);
    setLabel(outcome.label);
    setBridgeReachable(outcome.bridgeReachable);
    setPhase("ready");
    return outcome.token;
  }, []);

  /**
   * The fire-and-forget, phase-blind counterpart to `refreshSession` — see
   * this file's header, "THAT RE-MINT IS SUMMARY-ONLY" (adversarial review
   * lens 4, finding 9 — MINOR, fixed). On success, updates the token and
   * every display-only field a fresh mint can change; on ANY failure
   * (network blip, `not_installed`, `disabled`, a malformed response),
   * silently does nothing — in particular, never calls `setPhase`. The
   * panel is already rendering `phase === "ready"` when this runs (it is
   * only ever called from `poll`, which only exists once `phase` is
   * `"ready"`); if the session has genuinely gone bad, the next real
   * `connect`/`poll`/`logout` call's 401 still routes through
   * `refreshSession` and shows the honest error then.
   */
  const refreshSummaryOnly = useCallback(async (): Promise<void> => {
    const outcome = await runHandshake();
    if (outcome.kind !== "ok") return;
    tokenRef.current = outcome.token;
    setSummary(outcome.summary);
    setLabel(outcome.label);
    setBridgeReachable(outcome.bridgeReachable);
  }, []);

  // Kick off the handshake once, and only when this deployment could
  // possibly serve anything real — see this file's "never even start the
  // handshake" rule (the plan's own wording) for why an unconfigured or
  // demo deployment must not post ANYTHING to `window.parent`. The fetch
  // wrapped in its own locally-scoped async function (rather than calling
  // `refreshSession` directly at the effect's top level) mirrors this
  // codebase's established mount-time-fetch pattern (e.g.
  // `src/components/comments/CommentThread.tsx`'s `loadInitial`) and keeps
  // `react-hooks/set-state-in-effect` happy — this is a data fetch
  // synchronizing with an external system (GHL's parent frame + our own
  // API), exactly what that rule expects an effect to look like.
  useEffect(() => {
    if (!embedConfigured) return;
    async function run() {
      await refreshSession();
    }
    void run();
  }, [embedConfigured, refreshSession]);

  /**
   * One authenticated POST to an `/api/crm/embed/whatsapp/*` route, with the
   * transparent re-handshake-and-retry-once on a 401 described in this
   * file's header. Never throws on a bridge-side failure (those come back
   * as an ordinary `{ ok: false, code, message }` body the panel already
   * knows how to render) — only throws when the SESSION ITSELF could not be
   * re-established, which the panel's own error handling (its `catch` around
   * `connect`/`poll`/`logout`) already surfaces as plain text.
   */
  const callEmbedWhatsappApi = useCallback(
    async (path: string): Promise<Record<string, unknown>> => {
      let token = tokenRef.current;
      if (!token) {
        token = await refreshSession();
        if (!token) throw new Error(NOT_IN_HIGHLEVEL_MESSAGE);
      }

      const res = await fetch(path, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        const fresh = await refreshSession();
        if (!fresh) throw new Error("This session has expired — reload this page inside HighLevel to reconnect.");
        const retryRes = await fetch(path, { method: "POST", headers: { authorization: `Bearer ${fresh}` } });
        return (await retryRes.json()) as Record<string, unknown>;
      }
      return (await res.json()) as Record<string, unknown>;
    },
    [refreshSession]
  );

  const connect = useCallback(
    () => callEmbedWhatsappApi("/api/crm/embed/whatsapp/connect") as Promise<BridgeSessionResult>,
    [callEmbedWhatsappApi]
  );

  const logout = useCallback(
    () => callEmbedWhatsappApi("/api/crm/embed/whatsapp/logout") as Promise<BridgeOkResult>,
    [callEmbedWhatsappApi]
  );

  const poll = useCallback(async (): Promise<BridgeSessionResult> => {
    const result = (await callEmbedWhatsappApi("/api/crm/embed/whatsapp/status")) as BridgeSessionResult;
    if (result.ok && (result.session.status === "connected" || result.session.status === "logged_out" || result.session.status === "banned")) {
      // See this file's header, "WRAPPER RESPONSIBILITIES" — the panel's own
      // `router.refresh()` is a no-op here; this is what actually updates
      // `summary` for the SteadyView the panel renders next. Fire-and-forget:
      // this tick's `result` already carries everything the panel needs to
      // render immediately, so nothing here needs to be awaited before
      // returning. `refreshSummaryOnly`, NOT `refreshSession` — adversarial
      // review lens 4, finding 9: this call must never be able to flip
      // `phase` to `"handshake_error"` out from under a panel that just
      // showed "Connected".
      void refreshSummaryOnly();
    }
    return result;
  }, [callEmbedWhatsappApi, refreshSummaryOnly]);

  // ---- Render ----

  if (!embedConfigured) {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <EmptyState
          title="This page isn't switched on yet"
          description="WhatsApp linking from inside HighLevel isn't available on this deployment yet — check back soon."
        />
      </Card>
    );
  }

  if (phase === "handshaking") {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <p className="text-sm text-ink-faint">Connecting…</p>
      </Card>
    );
  }

  if (phase === "handshake_error") {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <p className="text-sm text-loss">{NOT_IN_HIGHLEVEL_MESSAGE}</p>
      </Card>
    );
  }

  if (phase === "not_installed") {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <EmptyState
          title="Not set up yet"
          description={`This location isn't set up with ${brandName}'s WhatsApp provider yet — contact us to get it installed.`}
        />
      </Card>
    );
  }

  if (phase === "disabled") {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <EmptyState
          title="WhatsApp is switched off for this location"
          description={`An operator has disabled WhatsApp sending for this location. Contact ${brandName} if you think this is a mistake.`}
        />
      </Card>
    );
  }

  return (
    <WhatsappConnectionPanel
      copy={buildEmbedCopy(label)}
      // `coachId: ""` is a STRUCTURAL PLACEHOLDER ONLY, never real data
      // (adversarial review lens 4, finding 2 — MAJOR). The shared panel's
      // prop type is `WhatsappSessionSummary | null`, which still declares
      // `coachId: string` — a field this embed's `summary` state
      // (`GhlEmbedWhatsappSummary`) structurally cannot carry, because
      // `POST /api/crm/embed/session` never puts it on the wire in the first
      // place (see that route's header, "NEVER THE TENANT ID EITHER"). The
      // panel itself never reads `summary.coachId` (grep-verified; it is
      // documented as holding no id at all — this file's header) — this
      // empty string exists purely to satisfy the shared prop's TypeScript
      // shape without touching `WhatsappConnectionPanel.tsx`, and is never
      // derived from, or capable of leaking, the real tenant id.
      summary={summary ? { ...summary, coachId: "" } : null}
      bridgeConfigured={bridgeConfigured}
      bridgeReachable={bridgeReachable}
      nowMs={nowMs}
      connect={connect}
      poll={poll}
      logout={logout}
    />
  );
}

/**
 * Client-audience copy — this reader IS the business owner (or whoever they
 * handed the GHL sub-account login to), so this speaks to them directly
 * ("your WhatsApp"), same voice as `CoachWhatsappCard`'s self-serve copy.
 * `qrWarning` is the load-bearing line (hard requirement, restated from this
 * feature's own brief): it must say, before anyone scans anything, that
 * whoever scans the code can send WhatsApp messages as this business.
 */
function buildEmbedCopy(label: string | null): WhatsappPanelCopy {
  const businessLabel = label && !label.startsWith("GHL location ") ? label : "your business";
  return {
    cardTitle: "WhatsApp",
    cardSubtitle: `Link ${businessLabel === "your business" ? "your business's" : `${businessLabel}'s`} WhatsApp so messages sent through this GHL location go out from your own number.`,
    emptyTitle: "No WhatsApp linked yet",
    emptyDescription: "Scan a QR code with the phone that runs your business WhatsApp — the same as WhatsApp Web.",
    connectLabel: "Connect WhatsApp",
    freshCodeLabel: "Get a new QR code",
    qrInstruction: "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.",
    qrWarning:
      "Only scan this yourself, on your own business phone. Whoever scans this code links their phone to your WhatsApp and can read and send messages as your business — treat it exactly like a password.",
    logoutConfirm: "This unlinks your number and wipes its stored credentials. Messages sent through this location will stop going out over WhatsApp until it's reconnected.",
    disconnectedFallback: "Your WhatsApp isn't connected at the moment.",
    unlinkedMessage: "Your WhatsApp was unlinked. Reconnecting is safe whenever you're ready.",
    unknownAccountMessage: "This location isn't recognised right now — reload this page and try again.",
    bannedHelp:
      "This number was blocked by WhatsApp — reconnecting the same number is likely to fail. Get in touch with your account manager before trying anything else.",
    unauthorizedMessage: "The WhatsApp service rejected the connection — this needs to be checked by your account manager.",
  };
}
