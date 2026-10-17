/**
 * Typed client for the WhatsApp bridge (services/whatsapp-bridge/ — the
 * always-on Railway service holding each coach's Baileys session). This is
 * the ONLY module in the Next app that talks to the bridge; the later UI
 * package (QR card, 'whatsapp' sequence step) builds on these functions and
 * never fetches the bridge directly.
 *
 * WHY THE PORTAL DOESN'T HOLD SESSIONS ITSELF: a WhatsApp Web session is a
 * permanently-open WebSocket, and Vercel freezes a function instance the
 * moment it returns its response (src/lib/automations.ts's `keepAlive()`
 * JSDoc) — a session physically cannot live here, so the portal is a thin
 * HTTP caller instead.
 *
 * DEGRADE-GRACEFULLY CONTRACT (hard rule 5, mirrors src/lib/slack.ts /
 * src/lib/automations.ts): every function here
 *   - times out hard at `BRIDGE_TIMEOUT_MS` (5s, same constant the
 *     automations dispatcher uses) via AbortController,
 *   - NEVER throws — every failure returns a discriminated
 *     `{ ok: false, code, message }` the caller renders or ignores,
 *   - is 'unconfigured'-graceful: with `WHATSAPP_BRIDGE_URL`/
 *     `WHATSAPP_BRIDGE_SECRET` unset (demo mode, local dev), every call
 *     resolves `{ ok: false, code: 'unconfigured' }` without a network
 *     attempt — safe to call from anywhere, zero env vars needed.
 * A bridge outage therefore shows up as "WhatsApp unavailable" on a card,
 * never as a hung page render or a 500. Note the difference from `notify()`:
 * these are NOT fire-and-forget — callers (a server action showing a QR, the
 * future cron step) need the response — so there's no `waitUntil` here; the
 * hard timeout is what bounds the request path instead.
 *
 * WHERE SESSION STATUS COMES FROM when the UI is built: the DB summary
 * (`repo.getWhatsappSessionSummaries()` — src/lib/data/index.ts), which the
 * bridge keeps current and which works even while the bridge is down. This
 * module is for the LIVE interactions only: connect, the in-memory QR
 * (deliberately never persisted — it's a device-link grant), logout, send,
 * and send-status lookup.
 *
 * SERVER-ONLY: the secret authorises sending as ANY coach, so it must never
 * reach a client bundle — import this from server components/actions/routes
 * only (env vars here are not NEXT_PUBLIC_ for exactly that reason).
 *
 * IDEMPOTENCY (hard rule 3): `sendWhatsappMessage` REQUIRES a caller-chosen
 * `idempotencyKey`; the bridge dedupes on (coachId, key) so a cron re-run,
 * a Vercel retry, or a redeploy can never double-deliver. The future
 * 'whatsapp' step will pass its `automation_sequence_runs.id` — already
 * unique per intended send, and stable across retries of that run.
 *
 * SWAPPABLE TRANSPORT: everything below the exported free functions
 * (`connectWhatsappSession`, `getWhatsappBridgeSession`,
 * `logoutWhatsappSession`, `sendWhatsappMessage`, `getWhatsappMessageStatus`)
 * is just the Baileys-bridge's implementation of the `WhatsappTransport`
 * interface declared below. The future 'whatsapp' sequence step, and any
 * other call site, imports ONLY the five free functions — never
 * `bridgeTransport` directly — so if/when Charlie moves a client onto the
 * official WhatsApp Cloud API (Meta's hosted send/receive API — no linked
 * device, no QR, no per-session socket, billed per conversation) instead of
 * this Baileys bridge, a new `cloudApiTransport: WhatsappTransport` gets
 * written and the ONE line that assigns `activeTransport` below is what
 * changes — every call site is untouched. The interface is deliberately
 * shaped around what BOTH transports can express: `connect`/`session` cover
 * Cloud API's phone-number-registration flow just as well as Baileys' QR
 * link (a Cloud API transport simply always returns `qr: null` and jumps
 * straight to 'connected'), and `send`/`getMessageStatus` map directly onto
 * Cloud API's `POST /messages` + delivery-status webhooks. Nothing here
 * commits to Baileys-specific shapes leaking past this module.
 */

const BRIDGE_TIMEOUT_MS = 5000;

/** Mirrors the bridge's `SessionSnapshot` (services/whatsapp-bridge/src/sessions.ts). */
export interface BridgeSessionSnapshot {
  coachId: string;
  status: "disconnected" | "waiting_qr" | "connected" | "logged_out" | "banned";
  phoneNumber: string | null;
  /** Raw QR string (render client-side) — non-null only while 'waiting_qr' and fresh (~60s). */
  qr: string | null;
  sentToday: number;
  dailyCap: number;
  /** Items waiting in the bridge's send queue. */
  queueLength: number;
  /** Daily-cap units the queued items will cost (a group send is 5). Absent from a bridge build before groups. */
  queuedUnits?: number;
  /** Daily-cap units of the item being dispatched right now. Absent from a bridge build before groups. */
  inFlightUnits?: number;
}

/** Mirrors the bridge's message row shape (services/whatsapp-bridge/src/server.ts). */
export interface BridgeMessage {
  id: string;
  idempotencyKey: string;
  /** The recipient this row was actually accepted for — compare against the request's `to` to catch an idempotency-key reuse mismatch (see 'idempotency_conflict' below). `null` for a group send. */
  toPhone: string | null;
  /** Opt-in groups — the group this row was accepted for; `null` (or absent, from a bridge build before groups) for a one-to-one send. */
  groupJid?: string | null;
  status: "accepted" | "sending" | "sent" | "failed" | "not_on_whatsapp";
  waMessageId: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

/**
 * Every failure shape this module can return. `code` values:
 *   'unconfigured'          — env vars unset (demo/dev) — render "not set up", not an error.
 *   'unreachable'           — network error or the 5s timeout — bridge down/slow.
 *   'unauthorized'          — secret mismatch (config error, alert-worthy).
 *   'not_found'             — no session/message for that id.
 *   'invalid_phone' | 'invalid_text' | 'invalid_idempotency_key' | 'invalid_coach_id' | 'invalid_body'
 *                           — the bridge refused the input (422/400).
 *   'session_not_connected' — no linked, open session for this coach (409).
 *   'idempotency_conflict'  — this idempotencyKey was already used for a
 *                             DIFFERENT recipient — choose a new key (422).
 *   'daily_cap_reached'     — pacing cap hit; resumes at UTC midnight (429).
 *   'lease_unavailable'     — bridge mid-redeploy handoff; retry shortly (503).
 *   'group_not_enabled'     — `groupJid` is malformed or not an enabled group for this number (400).
 *   'groups_unavailable'    — the bridge could not fetch the number's groups from WhatsApp (502).
 *   'groups_refresh_failed' — the bridge could not reload its enabled groups; group traffic is paused until a reload succeeds (502).
 *   'internal'              — anything else, including a 2xx response whose
 *                             body didn't match the expected shape (treated
 *                             as a bridge-contract violation, never trusted
 *                             blindly — see `isValidSession`/`isValidMessage`).
 */
export interface BridgeFailure {
  ok: false;
  code: string;
  message: string;
}

export type BridgeSessionResult = { ok: true; session: BridgeSessionSnapshot } | BridgeFailure;
export type BridgeSendResult = { ok: true; replay: boolean; message: BridgeMessage } | BridgeFailure;
export type BridgeMessageResult = { ok: true; message: BridgeMessage } | BridgeFailure;
export type BridgeOkResult = { ok: true } | BridgeFailure;

/** One of the number's WhatsApp groups, live from the bridge (`GET /sessions/:id/groups`). Shown to the owner; the bridge never stores it. */
export interface BridgeGroup {
  jid: string;
  name: string;
  /** Member count. */
  size: number;
}

export type BridgeGroupsResult = { ok: true; groups: BridgeGroup[] } | BridgeFailure;

/**
 * The bridge's group-JID shape — byte-identical to its `GROUP_JID_RE`
 * (services/whatsapp-bridge/src/groups.ts) and to 0004's/0005's CHECKs.
 */
export const WHATSAPP_GROUP_JID_RE = /^[0-9]+(-[0-9]+)?@g\.us$/;

/** True iff `jid` is a well-formed WhatsApp group id (`120363…@g.us`, or the older `<creator>-<timestamp>@g.us`). */
export function isWhatsappGroupJid(jid: string): boolean {
  return typeof jid === "string" && WHATSAPP_GROUP_JID_RE.test(jid);
}

/**
 * One text send. EXACTLY ONE target, enforced by the type (the bridge also
 * 400s both): `to` for a one-to-one send, or `groupJid` for an enabled group.
 */
export type SendWhatsappInput = {
  coachId: string;
  text: string;
  /** Caller-chosen dedupe key, [A-Za-z0-9_-]{1,128} — see this file's IDEMPOTENCY note. */
  idempotencyKey: string;
} & (
  | {
      /** Strict E.164 ONLY (src/lib/phone.ts's contract) — pass `calls.prospectPhone` verbatim; the bridge 422s anything else rather than normalising (see services/whatsapp-bridge/src/phone.ts for why refusal beats repair). */
      to: string;
      groupJid?: never;
    }
  | {
      /** A group JID as stored in `whatsapp_groups` (never built by concatenation — bridge hard rule 3). The bridge refuses it with 'group_not_enabled' unless the group is enabled for this number. */
      groupJid: string;
      to?: never;
    }
);

/**
 * Media plan (docs/MEDIA-PLAN.md §5.3) — the attachment counterpart to
 * `SendWhatsappInput`, mirroring the bridge's own `{ to | groupJid,
 * idempotencyKey, attachment: { url, fileName? } }` body shape exactly
 * (services/whatsapp-bridge/src/server.ts). Same EXACTLY-ONE-target rule as
 * `SendWhatsappInput`.
 * Only ever sent when `WA_MEDIA_OUTBOUND_ENABLED` is on — see
 * `src/lib/ghl.ts`'s `isMediaOutboundEnabled`, the portal-side gate this
 * function's only caller (`src/lib/ghl-provider.ts`) checks first.
 */
export type SendWhatsappAttachmentInput = {
  coachId: string;
  attachment: {
    /** https:// only, ≤2048 chars — the bridge itself is the final validator (server.ts); this module passes the URL through untouched. */
    url: string;
    /** Display name for a document attachment, ≤128 chars. */
    fileName?: string;
  };
  idempotencyKey: string;
} & (
  | {
      /** Strict E.164, exactly as `SendWhatsappInput.to`. */
      to: string;
      groupJid?: never;
    }
  | {
      /** Opt-in groups — an enabled group's JID, exactly as `SendWhatsappInput.groupJid`; the bridge's send route takes it with an attachment too. */
      groupJid: string;
      to?: never;
    }
);

/**
 * Every operation a WhatsApp send/session transport must support — see this
 * file's SWAPPABLE TRANSPORT note above for why this exists as a named
 * interface rather than five free functions with no shared shape. Both the
 * current Baileys-bridge implementation (`bridgeTransport` below) and any
 * future official-WhatsApp-Cloud-API implementation satisfy this exact
 * contract, so `activeTransport`'s assignment is the only line a transport
 * swap touches.
 */
export interface WhatsappTransport {
  /** Start (or resume) a coach's session/registration. */
  connect(coachId: string): Promise<BridgeSessionResult>;
  /** Current snapshot — status, linked number, live QR (Baileys transports only), pacing counters. */
  getSession(coachId: string): Promise<BridgeSessionResult>;
  /** Unlink the coach's number and wipe stored credentials on the transport side. */
  logout(coachId: string): Promise<BridgeOkResult>;
  /** Queue one message for paced, idempotent dispatch. */
  send(input: SendWhatsappInput): Promise<BridgeSendResult>;
  /** Media plan (docs/MEDIA-PLAN.md §5.3) — queue one ATTACHMENT part for paced, idempotent dispatch; same accept-time contract as `send` (idempotency replay/conflict, connected check, daily-cap reservation), just carrying `attachment` instead of `text`. */
  sendAttachment(input: SendWhatsappAttachmentInput): Promise<BridgeSendResult>;
  /** Post-hoc delivery status of a previously accepted send, by the same idempotency key. */
  getMessageStatus(coachId: string, idempotencyKey: string): Promise<BridgeMessageResult>;
  /** Opt-in groups — the number's groups, live (connected sessions only). */
  listGroups(coachId: string): Promise<BridgeGroupsResult>;
  /** Opt-in groups — make the transport reload its enabled-group set after `whatsapp_groups` changed. */
  refreshGroups(coachId: string): Promise<BridgeOkResult>;
}

/** `WHATSAPP_BRIDGE_URL` must be https (a plain-http localhost is allowed for local dev only) — see `bridgeEnv`'s JSDoc. */
const LOCALHOST_HTTP_RE = /^http:\/\/localhost(:\d+)?$/i;

function bridgeEnv(): { url: string; secret: string } | null {
  const url = process.env.WHATSAPP_BRIDGE_URL;
  const secret = process.env.WHATSAPP_BRIDGE_SECRET;
  if (!url || !secret) return null;
  const trimmed = url.replace(/\/$/, "");
  // `WA_BRIDGE_SECRET` authorises SENDING FROM EVERY LINKED COACH'S WHATSAPP
  // (services/whatsapp-bridge/src/config.ts's fail-fast check says the same
  // thing) and this module attaches it as a bearer token on every request —
  // a plain-http URL (a plausible copy/paste from a Railway panel, or a
  // local-dev value accidentally promoted to prod) would put that secret on
  // the wire in cleartext with nothing failing loudly. Refuse it the same
  // way an unset env var is refused: 'unconfigured', zero network attempt.
  if (!/^https:\/\//i.test(trimmed) && !LOCALHOST_HTTP_RE.test(trimmed)) {
    console.error(
      `[whatsapp-bridge] WHATSAPP_BRIDGE_URL must be https:// (or http://localhost for local dev) — refusing to send WA_BRIDGE_SECRET over a non-https URL: ${trimmed}`
    );
    return null;
  }
  return { url: trimmed, secret };
}

/** Narrows an unknown JSON value to a plausible `BridgeSessionSnapshot` before trusting it — a bridge behind a misbehaving proxy could return 200 with an unexpected body, and blindly casting would hand callers `session: undefined` that later throws deep in a future UI (hard rule 5). */
function isValidSession(v: unknown): v is BridgeSessionSnapshot {
  return typeof v === "object" && v !== null && typeof (v as { coachId?: unknown }).coachId === "string" && typeof (v as { status?: unknown }).status === "string";
}

/** Same shape guard as `isValidSession`, for the group list — every entry must look right, or the whole body is treated as a contract violation. */
function isValidGroupList(v: unknown): v is BridgeGroup[] {
  return (
    Array.isArray(v) &&
    v.every(
      (g) =>
        typeof g === "object" &&
        g !== null &&
        typeof (g as { jid?: unknown }).jid === "string" &&
        typeof (g as { name?: unknown }).name === "string" &&
        typeof (g as { size?: unknown }).size === "number"
    )
  );
}

/** Same shape guard as `isValidSession`, for message rows. */
function isValidMessage(v: unknown): v is BridgeMessage {
  return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string" && typeof (v as { status?: unknown }).status === "string";
}

/**
 * One place for fetch + auth + timeout + never-throw (the module contract
 * above). Returns the parsed JSON body and status, or a synthesised
 * 'unreachable' failure — callers only ever see JSON.
 */
async function bridgeFetch(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<{ status: number; body: Record<string, unknown> } | BridgeFailure> {
  const env = bridgeEnv();
  if (!env) {
    return { ok: false, code: "unconfigured", message: "WHATSAPP_BRIDGE_URL/WHATSAPP_BRIDGE_SECRET not set — WhatsApp bridge disabled in this environment." };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
    try {
      const res = await fetch(`${env.url}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${env.secret}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Timeout, DNS, refused connection — all one caller-facing shape. Logged
    // here (non-fatal) so a flapping bridge is visible in Vercel logs.
    console.error(`[whatsapp-bridge] ${init.method} ${path} unreachable (non-fatal):`, err);
    return { ok: false, code: "unreachable", message: "WhatsApp bridge unreachable or timed out." };
  }
}

/** Extracts the uniform `{ok:false,error:{code,message}}` shape the bridge returns on non-2xx (services/whatsapp-bridge/src/server.ts). */
function toFailure(status: number, body: Record<string, unknown>): BridgeFailure {
  const error = (body.error ?? {}) as { code?: unknown; message?: unknown };
  return {
    ok: false,
    code: typeof error.code === "string" ? error.code : "internal",
    message: typeof error.message === "string" ? error.message : `bridge responded ${status}`,
  };
}

/**
 * The Baileys-bridge `WhatsappTransport` — talks to services/whatsapp-bridge/
 * over HTTP with the auth + timeout + never-throw contract this file's
 * header describes. This is the only transport that exists today (see the
 * SWAPPABLE TRANSPORT note above); every method here is a straight port of
 * what were previously this module's five top-level exported functions.
 */
const bridgeTransport: WhatsappTransport = {
  /**
   * Start (or resume) a coach's session. First-ever connect flips the bridge
   * to 'waiting_qr'; poll `getSession` for the QR to render.
   */
  async connect(coachId: string): Promise<BridgeSessionResult> {
    const res = await bridgeFetch(`/sessions/${encodeURIComponent(coachId)}/connect`, { method: "POST" });
    if ("ok" in res) return res;
    if (res.status === 200 || res.status === 202) {
      if (!isValidSession(res.body.session)) return { ok: false, code: "internal", message: "bridge returned a malformed session body" };
      return { ok: true, session: res.body.session };
    }
    return toFailure(res.status, res.body);
  },

  /** Live snapshot straight from the bridge — the only way to obtain a QR (never in the DB). For plain status display prefer `repo.getWhatsappSessionSummaries()`. */
  async getSession(coachId: string): Promise<BridgeSessionResult> {
    const res = await bridgeFetch(`/sessions/${encodeURIComponent(coachId)}`, { method: "GET" });
    if ("ok" in res) return res;
    if (res.status === 200) {
      if (!isValidSession(res.body.session)) return { ok: false, code: "internal", message: "bridge returned a malformed session body" };
      return { ok: true, session: res.body.session };
    }
    return toFailure(res.status, res.body);
  },

  /** Unlink the coach's device and wipe its stored credentials on the bridge side. */
  async logout(coachId: string): Promise<BridgeOkResult> {
    const res = await bridgeFetch(`/sessions/${encodeURIComponent(coachId)}/logout`, { method: "POST" });
    if ("ok" in res) return res;
    if (res.status === 200) return { ok: true };
    return toFailure(res.status, res.body);
  },

  /**
   * Queue one message for paced dispatch from the coach's own number.
   * `ok: true` means ACCEPTED (or replayed) — actual delivery is asynchronous
   * behind the bridge's per-session pacing; check `message.status` later via
   * `getMessageStatus` if the caller needs delivery truth.
   */
  async send(input: SendWhatsappInput): Promise<BridgeSendResult> {
    const res = await bridgeFetch(`/sessions/${encodeURIComponent(input.coachId)}/send`, {
      method: "POST",
      body:
        input.groupJid !== undefined
          ? { groupJid: input.groupJid, text: input.text, idempotencyKey: input.idempotencyKey }
          : { to: input.to, text: input.text, idempotencyKey: input.idempotencyKey },
    });
    if ("ok" in res) return res;
    if (res.status === 200 || res.status === 202) {
      if (!isValidMessage(res.body.message)) return { ok: false, code: "internal", message: "bridge returned a malformed message body" };
      return { ok: true, replay: Boolean(res.body.replay), message: res.body.message };
    }
    return toFailure(res.status, res.body);
  },

  /**
   * Media plan (docs/MEDIA-PLAN.md §5.3) — the attachment counterpart to
   * `send` above, hitting the SAME `POST /sessions/:coachId/send` route with
   * the `attachment` body shape instead of `text` (server.ts's xor contract
   * — exactly one of the two). With the bridge's own
   * `WA_MEDIA_OUTBOUND_ENABLED` off, this call gets back a fixed 422
   * `media_outbound_disabled` refusal — never a crash, never silently
   * dropped — which `toFailure` surfaces as an ordinary `BridgeFailure` the
   * caller maps like any other terminal bridge code.
   */
  async sendAttachment(input: SendWhatsappAttachmentInput): Promise<BridgeSendResult> {
    const res = await bridgeFetch(`/sessions/${encodeURIComponent(input.coachId)}/send`, {
      method: "POST",
      body:
        input.groupJid !== undefined
          ? { groupJid: input.groupJid, attachment: input.attachment, idempotencyKey: input.idempotencyKey }
          : { to: input.to, attachment: input.attachment, idempotencyKey: input.idempotencyKey },
    });
    if ("ok" in res) return res;
    if (res.status === 200 || res.status === 202) {
      if (!isValidMessage(res.body.message)) return { ok: false, code: "internal", message: "bridge returned a malformed message body" };
      return { ok: true, replay: Boolean(res.body.replay), message: res.body.message };
    }
    return toFailure(res.status, res.body);
  },

  /** Post-hoc status of a previously accepted send, by the same idempotency key. */
  async getMessageStatus(coachId: string, idempotencyKey: string): Promise<BridgeMessageResult> {
    const res = await bridgeFetch(
      `/sessions/${encodeURIComponent(coachId)}/messages/${encodeURIComponent(idempotencyKey)}`,
      { method: "GET" }
    );
    if ("ok" in res) return res;
    if (res.status === 200) {
      if (!isValidMessage(res.body.message)) return { ok: false, code: "internal", message: "bridge returned a malformed message body" };
      return { ok: true, message: res.body.message };
    }
    return toFailure(res.status, res.body);
  },

  /** `GET /sessions/:coachId/groups` — 409 'session_not_connected' unless the number is linked and open. */
  async listGroups(coachId: string): Promise<BridgeGroupsResult> {
    const res = await bridgeFetch(`/sessions/${encodeURIComponent(coachId)}/groups`, { method: "GET" });
    if ("ok" in res) return res;
    if (res.status === 200) {
      if (!isValidGroupList(res.body.groups)) return { ok: false, code: "internal", message: "bridge returned a malformed groups body" };
      return { ok: true, groups: res.body.groups };
    }
    return toFailure(res.status, res.body);
  },

  /** `POST /sessions/:coachId/groups/refresh` — on failure the bridge pauses group traffic (fail closed) until a later refresh lands. */
  async refreshGroups(coachId: string): Promise<BridgeOkResult> {
    const res = await bridgeFetch(`/sessions/${encodeURIComponent(coachId)}/groups/refresh`, { method: "POST" });
    if ("ok" in res) return res;
    if (res.status === 200) return { ok: true };
    return toFailure(res.status, res.body);
  },
};

/**
 * The transport every exported function below delegates to. THIS ASSIGNMENT
 * is the one line a future transport swap changes (see SWAPPABLE TRANSPORT
 * above) — e.g. `coachUsesCloudApi(coachId) ? cloudApiTransport : bridgeTransport`
 * once a second transport exists. Kept as a plain `const` rather than
 * per-coach dispatch for now because exactly one transport exists.
 */
const activeTransport: WhatsappTransport = bridgeTransport;

/**
 * Start (or resume) a coach's session. First-ever connect flips the bridge
 * to 'waiting_qr'; poll `getWhatsappBridgeSession` for the QR to render.
 */
export function connectWhatsappSession(coachId: string): Promise<BridgeSessionResult> {
  return activeTransport.connect(coachId);
}

/** Live snapshot straight from the bridge — the only way to obtain a QR (never in the DB). For plain status display prefer `repo.getWhatsappSessionSummaries()`. */
export function getWhatsappBridgeSession(coachId: string): Promise<BridgeSessionResult> {
  return activeTransport.getSession(coachId);
}

/** Unlink the coach's device and wipe its stored credentials on the bridge side. */
export function logoutWhatsappSession(coachId: string): Promise<BridgeOkResult> {
  return activeTransport.logout(coachId);
}

/**
 * Queue one message for paced dispatch from the coach's own number.
 * `ok: true` means ACCEPTED (or replayed) — actual delivery is asynchronous
 * behind the bridge's per-session pacing; check `message.status` later via
 * `getWhatsappMessageStatus` if the caller needs delivery truth.
 */
export function sendWhatsappMessage(input: SendWhatsappInput): Promise<BridgeSendResult> {
  return activeTransport.send(input);
}

/**
 * Media plan (docs/MEDIA-PLAN.md §5.3) — queue one ATTACHMENT part for paced
 * dispatch; same "ok: true means ACCEPTED, not delivered" contract as
 * `sendWhatsappMessage`. Only ever called from `src/lib/ghl-provider.ts`
 * behind `isMediaOutboundEnabled()` (`src/lib/ghl.ts`).
 */
export function sendWhatsappAttachment(input: SendWhatsappAttachmentInput): Promise<BridgeSendResult> {
  return activeTransport.sendAttachment(input);
}

/** Post-hoc status of a previously accepted send, by the same idempotency key. */
export function getWhatsappMessageStatus(coachId: string, idempotencyKey: string): Promise<BridgeMessageResult> {
  return activeTransport.getMessageStatus(coachId, idempotencyKey);
}

/** Opt-in groups — the number's WhatsApp groups, live from the bridge (connected sessions only). For the owner's group picker; never stored as-is. */
export function listWhatsappGroups(coachId: string): Promise<BridgeGroupsResult> {
  return activeTransport.listGroups(coachId);
}

/** Opt-in groups — call after changing a number's `whatsapp_groups` rows so the bridge reloads which groups it forwards and accepts sends to. */
export function refreshWhatsappGroups(coachId: string): Promise<BridgeOkResult> {
  return activeTransport.refreshGroups(coachId);
}

/**
 * True iff `WHATSAPP_BRIDGE_URL`/`WHATSAPP_BRIDGE_SECRET` are both set (and
 * the URL passes `bridgeEnv`'s https-or-localhost check) — the CRITICAL
 * DEPLOY REALITY gate every WhatsApp UI surface reads before rendering
 * anything live. This package ships to production BEFORE Railway exists, so
 * this returns `false` there: no network attempt, just the same env check
 * `bridgeFetch` already runs on every call. Distinct from "reachable" (see
 * `getWhatsappBridgeHealth` below) — 'unconfigured' (this) and 'unreachable'
 * (a configured bridge that isn't answering) must read differently to a
 * human (hard rule 4): "isn't set up on this deployment" vs "isn't
 * responding right now — shown status may be stale".
 */
export function isWhatsappBridgeConfigured(): boolean {
  return bridgeEnv() !== null;
}

/**
 * One `/health` probe (no auth required by the bridge, but this still goes
 * through `bridgeFetch` for the shared timeout/never-throw contract) — the
 * single live signal every WhatsApp surface uses to decide whether a DB-read
 * status might be stale. Callers should call this AT MOST ONCE per page
 * render (see the connection card / connections overview JSDoc — N per-coach
 * health calls on a page that must survive the bridge being down is exactly
 * the never-resolving-spinner failure hard rule 4 bans) and share the result
 * across everything on that page, never fan it out per row.
 */
export async function getWhatsappBridgeHealth(): Promise<{ ok: true } | BridgeFailure> {
  const res = await bridgeFetch("/health", { method: "GET" });
  if ("ok" in res) return res;
  if (res.status === 200) return { ok: true };
  return toFailure(res.status, res.body);
}
