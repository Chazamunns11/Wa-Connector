"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Chip } from "@/components/ui/Chip";
import { relativeTime } from "@/lib/format";
import type { WhatsappSessionStatus, WhatsappSessionSummary } from "@/lib/types";
import type { BridgeOkResult, BridgeSessionResult, BridgeSessionSnapshot } from "@/lib/whatsapp-bridge";

/**
 * SHARED WhatsApp connection panel — the QR/connect/logout machinery, with no
 * opinion about WHOSE WhatsApp it is.
 *
 * EXTRACTED (Charlie 30 Jul 2026, self-serve coach mode, build batch 3) from
 * `src/components/owner/WhatsappConnectionCard.tsx`, which is now a thin
 * wrapper around it, alongside a second wrapper for a self-serve coach's own
 * setup page. Extraction rather than duplication is the security decision: the
 * QR lifecycle below (the attempt token, the tick sequencing, the
 * stale-resume detection, `stopLinkingWithMessage` being the only thing that
 * clears a QR string) is the product of two adversarial review passes, and a
 * copy-paste second implementation would inevitably drift out of that.
 *
 * TWO THINGS THIS COMPONENT DELIBERATELY DOES NOT HAVE:
 *   1. A `coachId`. The three actions arrive as ZERO-ARGUMENT props. Each
 *      wrapper binds whose session/coach they act on, and the coach-side
 *      wrapper's actions take no id at all — the id is derived server-side
 *      from the session on every call (hard rule 3). Nothing here could name
 *      another coach even if it were compromised, because it holds no id.
 *   2. Any copy of its own about who the number belongs to. Every such line
 *      arrives via `copy`, written in each wrapper for its own audience — so
 *      an owner never sees "your WhatsApp" and a coach never sees "this
 *      client's".
 *
 * A QR CODE IS A DEVICE-LINK GRANT — whoever scans it links THEIR phone to
 * that WhatsApp account and can then read/send as that business, the same
 * severity as leaking a password. The raw QR string this component ever
 * touches travels by exactly one path: an authenticated server-action
 * response (the injected `poll`) straight into this component's own state. It
 * is never revalidated, never placed in a URL or query param, never logged,
 * and is cleared the moment linking stops without a successful connect
 * (timeout, a terminal bridge error, `banned`/`logged_out` mid-link, or a
 * stale resume) via `stopLinkingWithMessage` — the one function below that
 * actually clears `session`/`qrEncoded`, not `stopPolling` itself (which only
 * ever owned the poll timer/attempt token).
 *
 * HONESTY WITH THE BRIDGE ABSENT (hard rule 4): `bridgeConfigured` and
 * `bridgeReachable` are deliberately separate booleans, never collapsed into
 * one "is it working" flag — 'unconfigured' ("isn't set up on this deployment
 * yet") and 'unreachable' ("isn't responding right now — shown status may be
 * stale") must read differently to a human.
 */

/** Bridge holds a live QR ~60s and rotates it — 2.5s polling absorbs a rotation automatically (each response just carries whatever string is current). */
const POLL_INTERVAL_MS = 2500;
/** Architecture doc's hard stop on a single linking attempt — after this, the user has to click Connect again for a fresh code rather than polling forever against a dead attempt. */
const LINK_TIMEOUT_MS = 5 * 60 * 1000;

const STATUS_CHIP: Record<WhatsappSessionStatus, { tone: "win" | "warn" | "loss"; label: string }> = {
  connected: { tone: "win", label: "Connected" },
  waiting_qr: { tone: "warn", label: "Waiting for QR scan" },
  disconnected: { tone: "warn", label: "Disconnected" },
  logged_out: { tone: "warn", label: "Logged out" },
  banned: { tone: "loss", label: "Banned" },
};

/**
 * Every line that names whose WhatsApp this is. Supplied per audience by the
 * wrapper — see this file's header for why none of it lives here.
 */
export interface WhatsappPanelCopy {
  cardTitle: string;
  cardSubtitle: string;
  /** Shown when no `whatsapp_sessions` row exists at all. */
  emptyTitle: string;
  emptyDescription: string;
  /** First-connect button label (a reconnect always reads "Reconnect"). */
  connectLabel: string;
  /**
   * Label for the "abandon the current attempt and issue a NEW code" button
   * in the `waiting_qr` state, and the exact words both stale-attempt
   * messages quote back at the reader.
   *
   * It must name the OUTCOME (a new code to scan), not the internal action.
   * The first version of this button read "Start a fresh code", which told a
   * client nothing about what would appear if they pressed it — and the
   * dead-end that made this button necessary at all (12X Coaching, 5 Aug
   * 2026) was itself a copy failure: the messages said "click Connect" while
   * no Connect button was rendered in that state. Keep this string and the
   * two `stopLinkingWithMessage`/`friendlyBridgeMessage` strings that quote
   * it in lockstep, or the same class of bug returns.
   */
  freshCodeLabel: string;
  /** The "on the phone: WhatsApp → Settings → Linked devices" instruction. */
  qrInstruction: string;
  /** THE SAFETY LINE under a live QR. Must always say, in some form, that whoever scans this can send as that account. */
  qrWarning: string;
  /** Body of the logout confirm box. */
  logoutConfirm: string;
  /** Shown for `disconnected`/`logged_out` when the bridge gave no reason, or only an opaque internal one (see `friendlyDisconnectReason`). */
  disconnectedFallback: string;
  /**
   * SHOWN AFTER A DELIBERATE UNLINK FROM THE PORTAL (adversarial review lens 2,
   * finding 1 — Charlie 30 Jul).
   *
   * Every portal unlink — Charlie's owner card AND the coach's own card both
   * hit the same bridge endpoint — persists the fixed string "unlinked via
   * bridge API" into `whatsapp_sessions.last_disconnect_reason`
   * (services/whatsapp-bridge/src/sessions.ts). The steady view renders that
   * reason whenever it is non-null, so before this field existed the
   * hard-rule-4 honesty copy in `disconnectedFallback` was unreachable in
   * EXACTLY the scenario it was written for, and both audiences were shown
   * operator jargon instead. This is the line that actually renders after a
   * real unlink, so it is the one that has to name the two people who could
   * have done it.
   */
  unlinkedMessage: string;
  /** Friendly rendering of the bridge's `invalid_coach_id`. */
  unknownAccountMessage: string;
  /**
   * WHAT TO DO ABOUT A BANNED NUMBER (adversarial review lens 3, finding 7).
   *
   * This branch used to be the one place in the panel that wasn't routed
   * through this per-audience `copy` object, so a fitness coach was told to
   * "see the WhatsApp runbook before trying anything else" — an operator
   * document they have no access to and have never heard of, on a dead-end
   * screen (hard rule 10).
   */
  bannedHelp: string;
  /**
   * WHAT TO DO WHEN THE BRIDGE REJECTS OUR CREDENTIALS (same finding). The
   * owner needs to know it's a bridge configuration problem; a coach needs to
   * know it isn't their fault and that they don't have to do anything.
   */
  unauthorizedMessage: string;
}

/**
 * Translates the bridge's own internal API vocabulary (e.g. "no session
 * running for this coach — POST /connect first",
 * services/whatsapp-bridge/src/server.ts) into copy a human reads. Hard rule
 * 4 demands honesty, not jargon. Falls back to the bridge's own message for
 * any code this mapping doesn't recognise, so a genuinely novel failure is
 * still SHOWN, just not translated.
 */
function friendlyBridgeMessage(code: string, fallbackMessage: string, copy: WhatsappPanelCopy): string {
  switch (code) {
    case "not_found":
      // Quotes `copy.freshCodeLabel` rather than naming a button in prose, so
      // this sentence cannot drift out of step with what is actually rendered.
      // It previously said "click Connect" while the 'waiting_qr' branch — the
      // ONLY state a resume can fail from — rendered no Connect button at all.
      return `That code has expired — click “${copy.freshCodeLabel}” and scan the new one.`;
    case "unauthorized":
      return copy.unauthorizedMessage;
    case "invalid_coach_id":
      return copy.unknownAccountMessage;
    case "internal":
      return "The WhatsApp service hit an unexpected problem — try again in a moment.";
    // Adversarial review, MINOR 4 (Charlie's bridge-side redeploy-safety
    // pass). The bridge returns this fixed code when a click lands on an
    // instance that is mid-redeploy (services/whatsapp-bridge/src/
    // sessions.ts's `ShuttingDownError`, surfaced by server.ts's /connect
    // route as `{ code: "shutting_down", message: "bridge instance is
    // shutting down — retry shortly" }`). Before this case existed, that
    // exact internal sentence — "bridge instance" is operator vocabulary, not
    // something a fitness coach or a client should ever read — fell through
    // to the `default` branch below and was shown verbatim. Same tone as
    // `lease_unavailable`'s handling in `handlePollResult` below (both mean
    // "this is a normal deploy handoff, not a real failure — try again in a
    // moment"), and deliberately worded so it also reads fine standing alone
    // here, since `handleConnect`'s single click has no retry loop of its own
    // to fall back on the way polling does.
    case "shutting_down":
      return "Service is restarting — try again in a minute.";
    default:
      return fallbackMessage;
  }
}

/**
 * The bridge's own fixed reason strings that must NEVER be shown verbatim,
 * mapped to the field of `copy` that says the same thing to this audience.
 *
 * ADVERSARIAL REVIEW LENS 2, FINDING 1 (Charlie 30 Jul). The bridge writes a
 * FIXED string into `whatsapp_sessions.last_disconnect_reason` on every
 * disconnect (never raw upstream error text — see its store's JSDoc), and the
 * steady view echoed all of them straight at the reader. Two of them are
 * internal vocabulary a fitness coach cannot act on:
 *
 *   "unlinked via bridge API" — a deliberate unlink from the portal, by
 *       EITHER side. This is the shared-control moment hard rule 4 is about,
 *       so it gets its own per-audience sentence naming both possibilities.
 *   "session stopped"        — the service tore the session down; there is no
 *       "who" and nothing for the reader to do beyond reconnect, so it falls
 *       back to the audience's plain-English disconnected line.
 *
 * DELIBERATELY NOT EXHAUSTIVE. Everything else the bridge can write is already
 * a human sentence ("logged out from phone", "connection lost", "connection
 * replaced by another client"), and an unrecognised string is still SHOWN
 * VERBATIM — the same convention `friendlyBridgeMessage` follows, so a
 * genuinely novel failure is never swallowed into a vague fallback.
 */
function friendlyDisconnectReason(reason: string | null, copy: WhatsappPanelCopy): string {
  if (reason === null) return copy.disconnectedFallback;
  if (reason === "unlinked via bridge API") return copy.unlinkedMessage;
  if (reason === "session stopped") return copy.disconnectedFallback;
  return reason;
}

export interface WhatsappConnectionPanelProps {
  copy: WhatsappPanelCopy;
  /** DB-derived summary (`repo.getWhatsappSessionSummary`) — works even with the bridge down. `null` = never connected. */
  summary: WhatsappSessionSummary | null;
  /** `isWhatsappBridgeConfigured()` — env vars unset means nothing here can do anything live. */
  bridgeConfigured: boolean;
  /** One shared `/health` probe result for the whole page render (`null` when unconfigured — nothing to probe). */
  bridgeReachable: boolean | null;
  /** `src/lib/data`'s `nowMs()` — same demo/live anchoring convention `relativeTime` uses everywhere else. */
  nowMs: number;
  /** Start (or restart) a linking attempt. Zero-argument by design — see this file's header. */
  connect: () => Promise<BridgeSessionResult>;
  /** Poll the live linking attempt. THE ONLY PATH a QR string ever travels. */
  poll: () => Promise<BridgeSessionResult>;
  /** Unlink and wipe stored credentials. */
  logout: () => Promise<BridgeOkResult>;
}

export function WhatsappConnectionPanel({
  copy,
  summary,
  bridgeConfigured,
  bridgeReachable,
  nowMs,
  connect,
  poll,
  logout,
}: WhatsappConnectionPanelProps) {
  const router = useRouter();

  const [linking, setLinking] = useState(false);
  const [session, setSession] = useState<BridgeSessionSnapshot | null>(null);
  /** The last QR string successfully encoded, paired with its data URL — kept together so a stale image can never render against a rotated string (see the encode effect below). */
  const [qrEncoded, setQrEncoded] = useState<{ qr: string; url: string } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const linkStartedAtRef = useRef<number | null>(null);
  /**
   * A token bumped every time polling stops for ANY reason (timeout, terminal
   * error, success, unmount, a fresh Connect/Resume superseding an old
   * attempt). Every in-flight tick captures this value before its `await` and
   * re-checks it after — discarding its own result if the token moved on.
   * This is what makes a LAGGARD response from an already-stopped attempt
   * structurally unable to repaint anything (the "stale QR scanned to
   * nowhere" / "laggard success wipes the timeout message" failure modes).
   */
  const attemptIdRef = useRef(0);
  /**
   * Per-attempt monotonic tick counter (reset to 0 in `startPolling`) — only
   * the LATEST issued tick's result is ever applied, so a poll response that
   * arrives out of order relative to a newer tick within the SAME attempt
   * (bridge latency around a QR rotation) can never overwrite a fresher one.
   */
  const tickSeqRef = useRef(0);
  /** True while the current attempt is a "Resume linking" against a possibly-dead bridge-side attempt, rather than a fresh Connect — gates the stale-resume detection below. */
  const isResumeRef = useRef(false);
  /** Consecutive `waiting_qr` polls with no `qr` yet, during a resume only — see the stale-resume detection in `handlePollResult`. */
  const noQrStreakRef = useRef(0);

  const stopPolling = useCallback(() => {
    attemptIdRef.current += 1;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    linkStartedAtRef.current = null;
  }, []);

  // Unmount safety — a live QR must never keep polling (or living in state)
  // after the user navigates away.
  useEffect(() => stopPolling, [stopPolling]);

  /**
   * The one place linking stops WITHOUT a successful connect. Clears
   * `session`/`qrEncoded` (the only two places a QR string or its rendered
   * image ever live) so a later "Resume linking" click can never repaint an
   * expired code.
   */
  const stopLinkingWithMessage = useCallback(
    (message: string | null) => {
      stopPolling();
      setLinking(false);
      setSession(null);
      setQrEncoded(null);
      setLinkError(message);
    },
    [stopPolling]
  );

  const handlePollResult = useCallback(
    (result: BridgeSessionResult) => {
      if (!result.ok) {
        // 'unreachable'/'lease_unavailable'/'shutting_down' are transient —
        // keep polling, bounded by the 5-minute timer in `startPolling`'s
        // tick. Anything else isn't something a retry fixes — stop and clear
        // the (now meaningless) QR state.
        if (result.code === "unreachable") {
          setLinkError("The WhatsApp service stopped responding — retrying…");
          return;
        }
        // Adversarial review, MINOR 4 — 'shutting_down' gets the SAME
        // transient treatment as 'lease_unavailable' here (same message,
        // poll loop left running), not routed through `stopLinkingWithMessage`
        // + `friendlyBridgeMessage`. Both codes mean "this specific bridge
        // instance can't help right now, but the redeploy that caused it
        // resolves within seconds" (services/whatsapp-bridge/src/server.ts's
        // /connect route: 'lease_unavailable' = a rival instance still owns
        // the lease; 'shutting_down' = THIS instance is the one going away) —
        // stopping the attempt over what is, from the client's side, a few
        // seconds' hiccup during OUR OWN deploy would needlessly wipe a QR
        // still worth waiting for. `friendlyBridgeMessage` also carries a
        // 'shutting_down' case (used by `handleConnect`/`handleLogout`, which
        // have no poll loop of their own to fall back on), kept in sync with
        // this exact wording.
        if (result.code === "lease_unavailable" || result.code === "shutting_down") {
          setLinkError("Service is restarting — try again in a minute.");
          return;
        }
        stopLinkingWithMessage(friendlyBridgeMessage(result.code, result.message, copy));
        return;
      }

      setLinkError(null);

      if (result.session.status === "connected") {
        // Success — stop polling but deliberately KEEP `session` (unlike
        // `stopLinkingWithMessage`): `SteadyView`'s connected branch reads
        // `session.dailyCap` from it, and a connected snapshot's `qr` is
        // always null per the bridge's own contract, so nothing stale can
        // leak through here.
        stopPolling();
        setLinking(false);
        setSession(result.session);
        // The DB summary (server-rendered) needs to catch up to the bridge's
        // freshly-flipped 'connected' status.
        router.refresh();
        return;
      }

      // `banned`/`logged_out` are TERMINAL outcomes reachable mid-link (e.g.
      // WhatsApp bans the number seconds after a scan). Stop immediately and
      // let `SteadyView`'s own honest branches render the truth once the DB
      // summary catches up — polling on would show "waiting" for the full
      // timeout and then falsely claim the code expired.
      if (result.session.status === "banned" || result.session.status === "logged_out") {
        stopPolling();
        setLinking(false);
        setSession(null);
        setQrEncoded(null);
        router.refresh();
        return;
      }

      // "Resume linking" polls a bridge-side attempt that may already be dead
      // (bridge redeploy, or a return after the QR's ~60s TTL). If the bridge
      // keeps answering `waiting_qr` with no `qr` at all for several
      // consecutive polls DURING A RESUME specifically (a fresh Connect
      // legitimately has a brief "Generating code…" window too, so this
      // detection is deliberately resume-only), there is no code coming this
      // attempt — stop with an accurate message.
      if (result.session.status === "waiting_qr" && result.session.qr === null) {
        if (isResumeRef.current) {
          noQrStreakRef.current += 1;
          if (noQrStreakRef.current >= 4) {
            stopLinkingWithMessage(
              `That code has expired — click “${copy.freshCodeLabel}” and scan the new one.`
            );
            return;
          }
        }
      } else {
        noQrStreakRef.current = 0;
      }

      setSession(result.session);
    },
    [copy, router, stopPolling, stopLinkingWithMessage]
  );

  const startPolling = useCallback(
    (resume: boolean) => {
      stopPolling();
      const myAttempt = attemptIdRef.current;
      tickSeqRef.current = 0;
      isResumeRef.current = resume;
      noQrStreakRef.current = 0;
      linkStartedAtRef.current = Date.now();
      setLinking(true);
      setLinkError(null);

      const tick = async () => {
        // Superseded by a newer attempt (a faster-resolving tick already
        // stopped polling, or Connect/Resume was clicked again, or the
        // component unmounted) — do nothing.
        if (attemptIdRef.current !== myAttempt) return;

        const startedAt = linkStartedAtRef.current;
        if (startedAt !== null && Date.now() - startedAt > LINK_TIMEOUT_MS) {
          stopLinkingWithMessage("Linking timed out — the code expired. Connect again to get a fresh one.");
          return;
        }

        const mySeq = ++tickSeqRef.current;
        try {
          const result = await poll();
          // Re-check both guards AFTER the await: the attempt may have been
          // stopped, or a newer tick issued and already applied its own
          // (fresher) result, while this one was in flight.
          if (attemptIdRef.current !== myAttempt || tickSeqRef.current !== mySeq) return;
          handlePollResult(result);
        } catch (err) {
          if (attemptIdRef.current !== myAttempt || tickSeqRef.current !== mySeq) return;
          // The action itself threw (an auth/live-mode/self-serve assertion
          // rejected it) rather than returning a `BridgeSessionResult` —
          // surface it the same honest way as a bridge-side failure instead
          // of an uncaught rejection.
          stopLinkingWithMessage(err instanceof Error ? err.message : "Could not check the linking status.");
        }
      };

      void tick();
      pollTimerRef.current = setInterval(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    },
    [poll, handlePollResult, stopPolling, stopLinkingWithMessage]
  );

  async function handleConnect() {
    setConnecting(true);
    setLinkError(null);
    try {
      const result = await connect();
      if (!result.ok) {
        setLinkError(friendlyBridgeMessage(result.code, result.message, copy));
        return;
      }
      setSession(result.session);
      startPolling(false);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Could not start linking.");
    } finally {
      setConnecting(false);
    }
  }

  // "Resume linking" (page loaded mid-`waiting_qr`) — a QR is only ever
  // obtainable live, so this starts the SAME poll loop rather than calling
  // Connect again (which would ask the bridge to restart the attempt);
  // `startPolling(true)` also arms the stale-resume detection above.
  function handleResumeLinking() {
    startPolling(true);
  }

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const result = await logout();
      if (!result.ok) {
        setLogoutError(friendlyBridgeMessage(result.code, result.message, copy));
        return;
      }
      setConfirmingLogout(false);
      setSession(null);
      setQrEncoded(null);
      router.refresh();
    } catch (err) {
      setLogoutError(err instanceof Error ? err.message : "Could not log out.");
    } finally {
      setLoggingOut(false);
    }
  }

  const currentQr = session?.status === "waiting_qr" ? session.qr : null;

  // Encode the live QR string into a scannable image whenever a NEW string
  // arrives — encoding happens entirely client-side in the user's own browser
  // (`qrcode`'s `toDataURL`), so the string never crosses any network
  // boundary beyond the one authenticated poll response it arrived in. The
  // actual `setQrEncoded` calls only ever happen inside the promise's
  // `.then`/`.catch` — genuinely async completions of an external encode —
  // so a stale string never renders while a fresher one is mid-encode
  // (`qrDataUrl` below only trusts `qrEncoded` when its paired string still
  // matches).
  useEffect(() => {
    if (!currentQr || qrEncoded?.qr === currentQr) return;
    let cancelled = false;
    QRCode.toDataURL(currentQr, { errorCorrectionLevel: "M", margin: 2, width: 264 })
      .then((url) => {
        if (!cancelled) setQrEncoded({ qr: currentQr, url });
      })
      .catch(() => {
        if (!cancelled) setQrEncoded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentQr, qrEncoded]);

  const qrDataUrl = currentQr && qrEncoded?.qr === currentQr ? qrEncoded.url : null;

  const chip = summary ? STATUS_CHIP[summary.status] : { tone: "muted" as const, label: "Never set up" };

  return (
    <Card>
      <CardHeader title={copy.cardTitle} subtitle={copy.cardSubtitle} action={<Chip tone={chip.tone}>{chip.label}</Chip>} />

      {!bridgeConfigured ? (
        <div className="rounded-lg border border-border bg-raised px-3 py-2.5 text-xs text-ink-faint">
          <p className="font-medium text-ink-dim">
            WhatsApp sending isn&rsquo;t switched on for this deployment yet — the bridge service isn&rsquo;t
            configured.
          </p>
          <p className="mt-1">Nothing is connected and nothing can send.</p>
          {summary ? (
            <p className="mt-2">
              Last known: {STATUS_CHIP[summary.status].label}
              {summary.phoneNumber ? ` — ${summary.phoneNumber}` : ""} (can&rsquo;t verify — service not configured)
            </p>
          ) : null}
        </div>
      ) : linking ? (
        <LinkingView copy={copy} session={session} qrDataUrl={qrDataUrl} error={linkError} />
      ) : (
        <SteadyView
          copy={copy}
          summary={summary}
          bridgeReachable={bridgeReachable}
          session={session}
          nowMs={nowMs}
          connecting={connecting}
          error={linkError}
          confirmingLogout={confirmingLogout}
          loggingOut={loggingOut}
          logoutError={logoutError}
          onConnect={handleConnect}
          onResumeLinking={handleResumeLinking}
          onRequestLogout={() => setConfirmingLogout(true)}
          onCancelLogout={() => setConfirmingLogout(false)}
          onConfirmLogout={handleLogout}
        />
      )}
    </Card>
  );
}

/** Rendered while a linking attempt (Connect / Resume linking) is in flight — see this file's QR HANDLING note above for the string's full lifecycle. */
function LinkingView({
  copy,
  session,
  qrDataUrl,
  error,
}: {
  copy: WhatsappPanelCopy;
  session: BridgeSessionSnapshot | null;
  qrDataUrl: string | null;
  error: string | null;
}) {
  const status = session?.status;

  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-raised px-4 py-5 text-center">
      {status === "waiting_qr" && qrDataUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- a client-generated data: URL, not a remote asset next/image can optimise */}
          <img
            src={qrDataUrl}
            alt="WhatsApp link QR code"
            width={264}
            height={264}
            className="rounded-lg bg-white p-2"
          />
          <p className="max-w-xs text-xs text-ink-dim">{copy.qrInstruction}</p>
          <p className="max-w-xs text-xs font-medium text-loss">{copy.qrWarning}</p>
        </>
      ) : status === "waiting_qr" ? (
        <p className="text-sm text-ink-faint">Generating code…</p>
      ) : status === "disconnected" ? (
        <p className="text-sm text-ink-faint">Reconnecting…</p>
      ) : (
        <p className="text-sm text-ink-faint">Waiting for the WhatsApp service…</p>
      )}
      {error ? <p className="text-xs text-warn">{error}</p> : null}
    </div>
  );
}

/** Rendered whenever no linking attempt is in flight — the DB-summary-driven status matrix from the architecture doc's "Steady-state render" section. */
function SteadyView({
  copy,
  summary,
  bridgeReachable,
  session,
  nowMs,
  connecting,
  error,
  confirmingLogout,
  loggingOut,
  logoutError,
  onConnect,
  onResumeLinking,
  onRequestLogout,
  onCancelLogout,
  onConfirmLogout,
}: {
  copy: WhatsappPanelCopy;
  summary: WhatsappSessionSummary | null;
  bridgeReachable: boolean | null;
  session: BridgeSessionSnapshot | null;
  nowMs: number;
  connecting: boolean;
  error: string | null;
  confirmingLogout: boolean;
  loggingOut: boolean;
  logoutError: string | null;
  onConnect: () => void;
  onResumeLinking: () => void;
  onRequestLogout: () => void;
  onCancelLogout: () => void;
  onConfirmLogout: () => void;
}) {
  // Never set up — no `whatsapp_sessions` row exists at all.
  if (!summary) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState title={copy.emptyTitle} description={copy.emptyDescription} />
        <Button size="sm" onClick={onConnect} disabled={connecting} className="self-start">
          {connecting ? "Starting…" : copy.connectLabel}
        </Button>
        {error ? <p className="text-xs text-loss">{error}</p> : null}
      </div>
    );
  }

  // Bridge configured but not currently answering `/health` — every status
  // below still renders from the DB, just flagged as possibly stale (hard
  // rule 4: never show "Connected" from stale state without saying so).
  const staleNote =
    bridgeReachable === false ? "Status may be stale — the WhatsApp service isn't responding right now." : null;

  if (summary.status === "banned") {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-ink">
          {summary.phoneNumber ? `${summary.phoneNumber} was` : "This number was"} banned by WhatsApp.
        </p>
        {summary.lastDisconnectReason ? <p className="text-xs text-ink-faint">{summary.lastDisconnectReason}</p> : null}
        {/* Adversarial review lens 3, finding 7 — this was the one branch in
            the panel not routed through the per-audience `copy` object, so a
            fitness coach got sent to an operator runbook they have no access
            to. Every audience now supplies its own sentence. */}
        <p className="text-xs text-ink-faint">{copy.bannedHelp}</p>
        {staleNote ? <p className="text-xs text-warn">{staleNote}</p> : null}
      </div>
    );
  }

  if (summary.status === "connected") {
    // A live `dailyCap` is only ever in hand right after a connect/poll
    // round-trip in THIS render lifecycle — the steady-state DB summary alone
    // has no cap concept (the cap is bridge-runtime-only, never mirrored into
    // the DB).
    const liveCap = session?.status === "connected" ? session.dailyCap : null;
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-ink">
          Connected as <span className="font-mono-nums">{summary.phoneNumber ?? "—"}</span>
        </p>
        {summary.lastConnectedAt ? (
          <p className="text-xs text-ink-faint">Last connected {relativeTime(summary.lastConnectedAt, nowMs)}</p>
        ) : null}
        <p className="text-xs text-ink-faint">
          Sends today: {summary.sentToday}
          {liveCap != null ? ` of ${liveCap}` : ""}
        </p>
        {staleNote ? <p className="text-xs text-warn">{staleNote}</p> : null}

        {confirmingLogout ? (
          <div className="mt-1 rounded-lg border border-loss/40 bg-loss/10 px-3 py-3 text-xs">
            <p className="font-medium text-ink">{copy.logoutConfirm}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="danger" onClick={onConfirmLogout} disabled={loggingOut}>
                {loggingOut ? "Logging out…" : "Log out"}
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancelLogout} disabled={loggingOut}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={onRequestLogout} className="self-start">
            Log out
          </Button>
        )}
        {logoutError ? <p className="text-xs text-loss">{logoutError}</p> : null}
      </div>
    );
  }

  if (summary.status === "waiting_qr") {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-ink-faint">A linking code was started but hasn&rsquo;t been scanned yet.</p>
        {staleNote ? <p className="text-xs text-warn">{staleNote}</p> : null}
        {/* THE DEAD END THIS SECOND BUTTON FIXES (12X Coaching, 5 Aug 2026):
            this branch used to render ONLY "Resume linking". Both failure
            messages a resume can produce — `no_attempt` (see
            `friendlyBridgeMessage`) and the stale-resume streak in
            `handleStatusResult` — tell the reader to start a fresh attempt,
            but the button that does that (`onConnect`) lived exclusively in
            the 'disconnected'/'logged_out' branch below. A client whose QR
            had simply timed out was therefore instructed to click a control
            that was not on their screen, with no way forward at all: resume
            failed every time, and the row's status never leaves 'waiting_qr'
            on its own. That is a total block on reconnecting a real client's
            business number, reachable by nothing more exotic than walking
            away for a minute mid-scan.
            Both paths are offered here rather than auto-falling-back to a
            fresh connect, because a resume that IS still alive must stay the
            cheap option — starting a new attempt needlessly discards a code
            the client may already have open on another screen. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onResumeLinking} className="self-start">
            Show the current code
          </Button>
          <Button size="sm" variant="secondary" onClick={onConnect} disabled={connecting} className="self-start">
            {connecting ? "Generating…" : copy.freshCodeLabel}
          </Button>
        </div>
        {error ? <p className="text-xs text-loss">{error}</p> : null}
      </div>
    );
  }

  // 'disconnected' / 'logged_out' — reconnect is identical to a first connect.
  return (
    <div className="flex flex-col gap-2 text-sm">
      {/* Adversarial review lens 2, finding 1 — this used to be
          `summary.lastDisconnectReason ?? copy.disconnectedFallback`, which
          meant the per-audience copy only ever rendered when the column was
          NULL. A portal unlink always writes a reason, so the honest
          shared-control sentence was dead code in the one scenario it was
          written for. `friendlyDisconnectReason` translates the bridge's fixed
          internal strings and passes anything else through unchanged. */}
      <p className="text-ink-faint">{friendlyDisconnectReason(summary.lastDisconnectReason, copy)}</p>
      {staleNote ? <p className="text-xs text-warn">{staleNote}</p> : null}
      <Button size="sm" onClick={onConnect} disabled={connecting} className="self-start">
        {connecting ? "Starting…" : "Reconnect"}
      </Button>
      {error ? <p className="text-xs text-loss">{error}</p> : null}
    </div>
  );
}
