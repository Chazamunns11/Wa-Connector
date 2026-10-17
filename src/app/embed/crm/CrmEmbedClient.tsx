"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { WhatsappConnectionPanel, type WhatsappPanelCopy } from "@/components/whatsapp/WhatsappConnectionPanel";
import { embedPausedMessage } from "@/app/api/crm/embed/session/logic";
import type { GhlEmbedWhatsappSummary } from "@/lib/types";
import { MAX_NUMBER_LABEL_LENGTH, parseLabelInput, type LocationSlot } from "@/lib/location-numbers";
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

/** The most numbers one sub-account can have — mirrors the server's limit (`nextFreeSlot` in src/lib/location-numbers.ts). */
const MAX_NUMBERS = 3;

/** One WhatsApp number as `POST /api/crm/embed/session` and `/api/crm/embed/numbers` return it — a slot, never a tenant id. */
interface EmbedNumber {
  slot: LocationSlot;
  /** Opaque per-number id (not the tenant id): the React key, so a removed-then-re-added slot starts fresh. */
  key: string;
  label: string | null;
  isDefault: boolean;
  summary: GhlEmbedWhatsappSummary | null;
}

type Phase = "handshaking" | "handshake_error" | "not_installed" | "disabled" | "unclaimed" | "billing_paused" | "not_activated" | "ready";

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
  state?: "ok" | "not_installed" | "disabled" | "unclaimed" | "billing_paused" | "not_activated";
  claimUrl?: string | null;
  /** With `billing_paused`: set when the free trial ended with no card. */
  reason?: "trial_ended";
  token?: string;
  label?: string;
  numbers?: EmbedNumber[];
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
  | { kind: "ok"; token: string; numbers: EmbedNumber[]; label: string | null; bridgeReachable: boolean | null }
  | { kind: "not_installed" }
  | { kind: "disabled" }
  | { kind: "unclaimed"; claimUrl: string | null }
  | { kind: "billing_paused"; trialEnded: boolean }
  | { kind: "not_activated" }
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
  if (json.state === "unclaimed") return { kind: "unclaimed", claimUrl: typeof json.claimUrl === "string" ? json.claimUrl : null };
  if (json.state === "billing_paused") return { kind: "billing_paused", trialEnded: json.reason === "trial_ended" };
  if (json.state === "not_activated") return { kind: "not_activated" };
  if (json.state !== "ok" || typeof json.token !== "string") return { kind: "error" };

  return {
    kind: "ok",
    token: json.token,
    numbers: sortedNumbers(json.numbers),
    label: json.label ?? null,
    bridgeReachable: typeof json.bridgeReachable === "boolean" ? json.bridgeReachable : null,
  };
}

/** Numbers ordered by slot; anything that is not an array (an old server) is no numbers. */
function sortedNumbers(raw: unknown): EmbedNumber[] {
  return Array.isArray(raw) ? [...(raw as EmbedNumber[])].sort((a, b) => a.slot - b.slot) : [];
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
  const [numbers, setNumbers] = useState<EmbedNumber[]>([]);
  const [label, setLabel] = useState<string | null>(null);
  // Adversarial review lens 4, finding 4 (MINOR) — this used to be a page
  // prop computed by an unauthenticated server-render `/health` probe; it
  // now arrives inside `POST /api/crm/embed/session`'s own response, so it
  // only ever reflects a probe that actually ran (see that route's header,
  // "THE BRIDGE-HEALTH PROBE LIVES HERE"). `null` until the first successful
  // handshake, same "nothing to show yet" meaning it always had.
  const [bridgeReachable, setBridgeReachable] = useState<boolean | null>(null);
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [trialEnded, setTrialEnded] = useState(false);

  // The embed token itself — a ref, not state: every closure below reads
  // `tokenRef.current` synchronously at call time rather than closing over a
  // possibly-stale state value, and updating it must never by itself cause a
  // re-render (only `phase`/`numbers`/`label`/`bridgeReachable` changes should).
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
    if (outcome.kind === "unclaimed") {
      setClaimUrl(outcome.claimUrl);
      setPhase("unclaimed");
      return null;
    }
    if (outcome.kind === "billing_paused") {
      setTrialEnded(outcome.trialEnded);
      setPhase("billing_paused");
      return null;
    }
    if (outcome.kind === "not_activated") {
      setPhase(outcome.kind);
      return null;
    }
    tokenRef.current = outcome.token;
    setNumbers(outcome.numbers);
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
    setNumbers(outcome.numbers);
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
   * One authenticated call to an `/api/crm/embed/*` route, with the
   * transparent re-handshake-and-retry-once on a 401 described in this
   * file's header. The body (always `{ slot }` for the `whatsapp/*` routes)
   * goes as JSON. Never throws on a bridge-side failure (those come back
   * as an ordinary `{ ok: false, code, message }` body the panel already
   * knows how to render) — only throws when the SESSION ITSELF could not be
   * re-established, which the panel's own error handling (its `catch` around
   * `connect`/`poll`/`logout`) already surfaces as plain text.
   */
  const callEmbedApi = useCallback(
    async (path: string, method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const send = (token: string) =>
        fetch(path, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      let token = tokenRef.current;
      if (!token) {
        token = await refreshSession();
        if (!token) throw new Error(NOT_IN_HIGHLEVEL_MESSAGE);
      }

      const res = await send(token);
      if (res.status === 401) {
        const fresh = await refreshSession();
        if (!fresh) throw new Error("This session has expired — reload this page inside HighLevel to reconnect.");
        const retryRes = await send(fresh);
        return (await retryRes.json()) as Record<string, unknown>;
      }
      return (await res.json()) as Record<string, unknown>;
    },
    [refreshSession]
  );

  /**
   * One numbers change (add, remove, make default, rename). Resolves with
   * `null` on success — after replacing `numbers` with the list the server
   * just returned — or with the server's own `message`, verbatim, on any
   * refusal.
   */
  const changeNumbers = useCallback(
    async (method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>): Promise<string | null> => {
      try {
        const json = await callEmbedApi("/api/crm/embed/numbers", method, body);
        if (json.ok === true && Array.isArray(json.numbers)) {
          setNumbers(sortedNumbers(json.numbers));
          return null;
        }
        return typeof json.message === "string" ? json.message : "Something went wrong. Please try again.";
      } catch (err) {
        return err instanceof Error ? err.message : "Something went wrong. Please try again.";
      }
    },
    [callEmbedApi]
  );

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

  if (phase === "unclaimed") {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <EmptyState
          title="Start your 7-day free trial"
          description={
            claimUrl
              ? `Connect this sub-account's WhatsApp by creating a ${brandName} account.`
              : `Visit ${brandName} to start your free trial.`
          }
          action={
            claimUrl ? (
              <a
                href={claimUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-105"
              >
                Start free trial
              </a>
            ) : undefined
          }
        />
      </Card>
    );
  }

  if (phase === "billing_paused") {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <EmptyState
          title="Sending is paused"
          description={embedPausedMessage(trialEnded)}
        />
      </Card>
    );
  }

  if (phase === "not_activated") {
    return (
      <Card>
        <CardHeader title="WhatsApp" />
        <EmptyState
          title="WhatsApp isn't active for this sub-account"
          description="Ask your account owner to activate it."
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
    <div className="flex flex-col gap-4">
      {numbers.map((number) => (
        <EmbedNumberCard
          key={number.key}
          number={number}
          copy={buildEmbedCopy(label)}
          bridgeConfigured={bridgeConfigured}
          bridgeReachable={bridgeReachable}
          nowMs={nowMs}
          callEmbedApi={callEmbedApi}
          refreshSummaryOnly={refreshSummaryOnly}
          changeNumbers={changeNumbers}
          onlyNumber={numbers.length === 1}
        />
      ))}
      {numbers.length < MAX_NUMBERS ? <AddNumber changeNumbers={changeNumbers} /> : null}
    </div>
  );
}

/**
 * One number: its heading row (label or "Number <slot>", a "Default" chip,
 * Make default / Rename / Remove) above the shared `WhatsappConnectionPanel`,
 * rendered UNMODIFIED. The panel's zero-arg `connect`/`poll`/`logout` closures
 * post `{ slot }`, the only way the server is told which number is meant —
 * never a tenant id. A poll that reaches a terminal status re-mints the
 * session (summary-only, see this file's header) so every number's summary
 * catches up.
 */
function EmbedNumberCard({
  number,
  copy,
  bridgeConfigured,
  bridgeReachable,
  nowMs,
  callEmbedApi,
  refreshSummaryOnly,
  changeNumbers,
  onlyNumber,
}: {
  number: EmbedNumber;
  copy: WhatsappPanelCopy;
  bridgeConfigured: boolean;
  bridgeReachable: boolean | null;
  nowMs: number;
  callEmbedApi: (path: string, method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  refreshSummaryOnly: () => Promise<void>;
  changeNumbers: (method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>) => Promise<string | null>;
  onlyNumber: boolean;
}) {
  const { slot } = number;
  const [mode, setMode] = useState<"idle" | "renaming" | "confirming_remove">("idle");
  const [draft, setDraft] = useState(number.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(
    () => callEmbedApi("/api/crm/embed/whatsapp/connect", "POST", { slot }) as Promise<BridgeSessionResult>,
    [callEmbedApi, slot]
  );
  const logout = useCallback(
    () => callEmbedApi("/api/crm/embed/whatsapp/logout", "POST", { slot }) as Promise<BridgeOkResult>,
    [callEmbedApi, slot]
  );
  const poll = useCallback(async (): Promise<BridgeSessionResult> => {
    const result = (await callEmbedApi("/api/crm/embed/whatsapp/status", "POST", { slot })) as BridgeSessionResult;
    if (result.ok && (result.session.status === "connected" || result.session.status === "logged_out" || result.session.status === "banned")) {
      // See this file's header, "WRAPPER RESPONSIBILITIES" — the panel's own
      // `router.refresh()` is a no-op here; this is what actually updates
      // the summary the panel renders next. Fire-and-forget and phase-blind
      // (`refreshSummaryOnly`, NOT `refreshSession`): it must never be able
      // to flip `phase` to `"handshake_error"` out from under a panel that
      // just showed "Connected".
      void refreshSummaryOnly();
    }
    return result;
  }, [callEmbedApi, refreshSummaryOnly, slot]);

  async function run(method: "DELETE" | "PATCH", body: Record<string, unknown>, onDone?: () => void) {
    setBusy(true);
    setError(null);
    const message = await changeNumbers(method, body);
    setBusy(false);
    if (message) setError(message);
    else onDone?.();
  }

  function saveRename() {
    // Same trim / empty-means-no-label / 40-character rule the server applies.
    const parsed = parseLabelInput(draft);
    if (!parsed.ok) {
      setError(`Names can be up to ${MAX_NUMBER_LABEL_LENGTH} characters.`);
      return;
    }
    void run("PATCH", { slot, label: parsed.label }, () => setMode("idle"));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">{number.label ?? `Number ${slot}`}</h2>
          {number.isDefault ? <Chip tone="accent">Default</Chip> : null}
        </div>
        {mode === "idle" ? (
          <div className="flex flex-wrap items-center gap-1">
            {!number.isDefault ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("PATCH", { slot, makeDefault: true })}>
                Make default
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(number.label ?? "");
                setError(null);
                setMode("renaming");
              }}
            >
              Rename
            </Button>
            {!onlyNumber ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setMode("confirming_remove");
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === "renaming" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draft}
            maxLength={MAX_NUMBER_LABEL_LENGTH}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Number name"
            placeholder={`Number ${slot}`}
            className="h-[34px] min-w-0 flex-1 rounded border border-border bg-transparent px-3 text-sm text-ink"
          />
          <Button size="sm" disabled={busy} onClick={saveRename}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {mode === "confirming_remove" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2.5">
          <span className="text-xs text-ink">Remove this number? Its WhatsApp will be logged out.</span>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void run("DELETE", { slot })}>
            {busy ? "Removing…" : "Remove"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-xs text-loss">{error}</p> : null}

      <WhatsappConnectionPanel
        copy={copy}
        // `coachId: ""` is a STRUCTURAL PLACEHOLDER ONLY, never real data
        // (adversarial review lens 4, finding 2 — MAJOR). The shared panel's
        // prop type is `WhatsappSessionSummary | null`, which still declares
        // `coachId: string` — a field this embed's summary
        // (`GhlEmbedWhatsappSummary`) structurally cannot carry, because
        // `POST /api/crm/embed/session` never puts it on the wire in the first
        // place (see that route's header, "NEVER THE TENANT ID EITHER"). The
        // panel itself never reads `summary.coachId` — this empty string
        // exists purely to satisfy the shared prop's TypeScript shape without
        // touching `WhatsappConnectionPanel.tsx`, and is never derived from,
        // or capable of leaking, the real tenant id.
        summary={number.summary ? { ...number.summary, coachId: "" } : null}
        bridgeConfigured={bridgeConfigured}
        bridgeReachable={bridgeReachable}
        nowMs={nowMs}
        connect={connect}
        poll={poll}
        logout={logout}
      />

      <GroupsSection slot={slot} callEmbedApi={callEmbedApi} />
    </div>
  );
}

/** One group as `POST /api/crm/embed/groups` returns it — WhatsApp's own group id, never a tenant id. */
interface EmbedGroup {
  jid: string;
  name: string;
  size: number;
  enabled: boolean;
  /** The number is no longer in this group. */
  left: boolean;
  /** In WhatsApp's own list for this number right now. */
  live: boolean;
}

/** Shown once, after the first group is switched on for this number. */
const GROUP_TAG_HINT = "Group contacts are tagged whatsapp-group. Exclude that tag from bulk SMS workflows.";

/** The groups list from a route response, or `null` when the response isn't a success. */
function groupsFrom(json: Record<string, unknown>): EmbedGroup[] | null {
  return json.ok === true && Array.isArray(json.groups) ? (json.groups as EmbedGroup[]) : null;
}

/**
 * Opt-in groups (Task 9) — one number's WhatsApp groups, collapsed until the
 * owner asks ("Show groups"). Every call posts `{ slot }` (plus the group's
 * JID and the new switch value to change one); the server answers with the
 * whole list (switching off answers with just that group, which is patched
 * in place). Server `message`s are shown verbatim. A group missing from
 * WhatsApp's list right now ("Left", or "Not found right now") has no
 * switch, but one still syncing gets "Stop syncing".
 */
function GroupsSection({
  slot,
  callEmbedApi,
}: {
  slot: LocationSlot;
  callEmbedApi: (path: string, method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<EmbedGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyJid, setBusyJid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);

  /** The server's list; `"switched_off"` for a switch-off (which answers without a list, so the row is patched in place); `null` on a refusal. */
  async function request(body: Record<string, unknown>): Promise<EmbedGroup[] | "switched_off" | null> {
    try {
      const json = await callEmbedApi("/api/crm/embed/groups", "POST", body);
      const list = groupsFrom(json);
      if (list) {
        setError(null);
        return list;
      }
      if (json.ok === true && json.enabled === false) {
        setError(null);
        return "switched_off";
      }
      setError(typeof json.message === "string" ? json.message : "Something went wrong. Please try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
    return null;
  }

  async function load() {
    setLoading(true);
    const list = await request({ slot });
    setLoading(false);
    if (Array.isArray(list)) setGroups(list);
  }

  async function toggle(group: EmbedGroup) {
    const enabling = !group.enabled;
    const firstEnable = enabling && !(groups ?? []).some((g) => g.enabled);
    setBusyJid(group.jid);
    const list = await request({ slot, groupJid: group.jid, enabled: enabling });
    setBusyJid(null);
    if (list === null) return;
    if (list === "switched_off") {
      setGroups((current) => (current ?? []).map((g) => (g.jid === group.jid ? { ...g, enabled: false } : g)));
      return;
    }
    setGroups(list);
    if (firstEnable) setShowHint(true);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && groups === null && !loading) void load();
          }}
        >
          {open ? "Hide groups" : "Show groups"}
        </Button>
      </div>

      {open ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-ink">Groups</h3>
            {groups !== null ? (
              <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
                {loading ? "Loading…" : "Reload"}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-ink-faint">Switch a group on to see its messages in HighLevel and reply to the whole group.</p>

          {loading && groups === null ? <p className="text-xs text-ink-faint">Loading groups…</p> : null}
          {error ? <p className="text-xs text-loss">{error}</p> : null}
          {showHint ? <p className="rounded border border-info/30 bg-info/10 px-2.5 py-2 text-xs text-info">{GROUP_TAG_HINT}</p> : null}

          {groups !== null && groups.length === 0 ? <p className="text-xs text-ink-faint">This number isn&apos;t in any WhatsApp groups.</p> : null}
          {groups !== null && groups.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border">
              {groups.map((group) => (
                <li key={group.jid} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{group.name || "Unnamed group"}</p>
                    {group.live ? (
                      <p className="text-xs text-ink-faint">
                        {group.size} {group.size === 1 ? "member" : "members"}
                      </p>
                    ) : null}
                  </div>
                  {!group.live ? (
                    <div className="flex shrink-0 items-center gap-2">
                      {group.left ? (
                        <Chip tone="muted" title="This number is no longer in this group">
                          Left
                        </Chip>
                      ) : (
                        <Chip tone="warn" title="WhatsApp didn't list this group for this number just now">
                          Not found right now
                        </Chip>
                      )}
                      {group.enabled ? (
                        <Button size="sm" variant="ghost" disabled={busyJid !== null} onClick={() => void toggle(group)}>
                          {busyJid === group.jid ? "Saving…" : "Stop syncing"}
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <label className="flex shrink-0 items-center gap-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={group.enabled}
                        disabled={busyJid !== null}
                        onChange={() => void toggle(group)}
                        aria-label={`Sync ${group.name || "this group"} to HighLevel`}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      {busyJid === group.jid ? "Saving…" : group.enabled ? "On" : "Off"}
                    </label>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Add a number" — a button that opens an optional name field. The server picks the slot. */
function AddNumber({ changeNumbers }: { changeNumbers: (method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const parsed = parseLabelInput(draft);
    if (!parsed.ok) {
      setError(`Names can be up to ${MAX_NUMBER_LABEL_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    const message = await changeNumbers("POST", parsed.label ? { label: parsed.label } : {});
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setOpen(false);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draft}
            maxLength={MAX_NUMBER_LABEL_LENGTH}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Name for the new number (optional)"
            placeholder="Name (optional), e.g. Sales line"
            className="h-[34px] min-w-0 flex-1 rounded border border-border bg-transparent px-3 text-sm text-ink"
          />
          <Button size="sm" disabled={busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Add a number
          </Button>
        </div>
      )}
      {error ? <p className="text-xs text-loss">{error}</p> : null}
    </div>
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
